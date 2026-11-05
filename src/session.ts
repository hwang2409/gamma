import { fromZetaEvent, fromZetaHistory, type SessionLease, type ZetaClient } from "@fulcrum/zeta";
import type { RunEvent } from "@fulcrum/core";
import type { hostBindings, Registration } from "./host-client";
type HostBindings = typeof hostBindings;

/** The `SessionMetadata` fields this app reads from `list_sessions` (zeta docs/serve-protocol.md). */
export type SessionMeta = {
  session_id: string;
  name?: string;
  first_message_preview?: string;
  created_at: string;
  updated_at: string;
  provider?: string;
  model?: string;
  cwd?: string;
  parent_session_id?: string | null;
};

export type ServerStatus = {
  session: SessionMeta | null;
  state: "idle" | "running" | "tool";
  pending_approvals: Array<{ request_id: string; tool_call: unknown; delegated: boolean; agent_instance_id?: string; resolution_pending?: "approve" | "deny" | "expire" | "abort" }>;
  pending_approvals_truncated?: boolean;
};

/** The name, else the first prompt; null when zeta has neither yet. */
export const sessionTitle = (session: SessionMeta | null) => session?.name?.trim() || session?.first_message_preview?.trim() || null;

export const getStatus = (client: ZetaClient, signal?: AbortSignal) => client.request("status", {}, { timeoutMs: 15_000, signal }) as Promise<ServerStatus>;

export type OpenProgress = (messages: number, complete: boolean) => void;
export type OpenResult = { lease: SessionLease; session: SessionMeta | null; syncing: boolean; complete: Promise<{ lease?: SessionLease; syncing: boolean }> };

type HistoryPage = { messages?: unknown[]; next_offset?: number | null };
const isApprovalEvent = (event: RunEvent) => event.type === "approval_request" || event.type === "approval_end";
const snapshotEvents = (id: string, rows: unknown[], status: ServerStatus, historyApprovals = true, liveApprovalStatus = false): RunEvent[] => {
  let events = fromZetaHistory(rows).filter((event) => historyApprovals || !isApprovalEvent(event));
  if (liveApprovalStatus && !status.pending_approvals_truncated) {
    const pending = new Set((status.pending_approvals ?? []).map((approval) => approval.request_id));
    const ended = new Set(events.flatMap((event) => event.type === "approval_end" ? [event.request_id] : []));
    events = events.filter((event) => event.type !== "approval_request" || pending.has(event.request_id) || ended.has(event.request_id));
  }
  for (const approval of status.pending_approvals ?? [])
    events.push(...fromZetaEvent({
      event: "approval_request", session_id: id, ...approval,
      ...(approval.resolution_pending ? { state: "resolving", status: "resolving…", disabled_reason: "the server is saving this decision" } : {}),
    }));
  events.push({ type: status.state === "idle" ? "run_end" : "run_start" });
  return events;
};
const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(Object.assign(new Error("request aborted"), { name: "AbortError" }));
  const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error("request aborted"), { name: "AbortError" })); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

const MAX_TAIL_RECONCILES = 3;
type LoadedPage = { offset: number; rows: unknown[]; nextOffset: number | null };
const rowId = (row: unknown) => row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string"
  ? (row as { id: string }).id
  : undefined;
const changedTailBoundary = (before: LoadedPage, after: readonly LoadedPage[]) => {
  const rows = after.flatMap((page) => page.rows);
  return rows.length < before.rows.length || rowId(rows[0]) !== rowId(before.rows[0]);
};

/** Opens the first history page immediately, then one coordinator owns paging and the replay join. */
export async function openSession(
  client: ZetaClient,
  id: string,
  progress?: OpenProgress,
  signal?: AbortSignal,
  knownStatus?: ServerStatus,
  registration?: Registration,
): Promise<OpenResult> {
  if (client.features.includes("session_replay_seq")) throw new Error("session_replay_seq needs the sequence replay coordinator");
  const approvalReconnect = client.features.includes("approval_reconnect");
  let pages: LoadedPage[] = [];
  let initialStatus!: ServerStatus;
  let activeSignal!: AbortSignal;
  const combinedSignal = (replaySignal: AbortSignal) => signal ? AbortSignal.any([signal, replaySignal]) : replaySignal;
  const historyPage = async (offset: number, loadSignal: AbortSignal): Promise<LoadedPage> => {
    const page = await client.request(
      "session_history",
      { session_id: id, offset },
      { timeoutMs: 15_000, signal: loadSignal },
    ) as HistoryPage;
    return { offset, rows: page.messages ?? [], nextOffset: page.next_offset ?? null };
  };
  const allRows = () => pages.flatMap((page) => page.rows);
  let publishedPages = 1;
  const stableRows = () => (pages.length === 1 ? pages : pages.slice(0, -1)).flatMap((page) => page.rows);
  const publishStablePrefix = (status: ServerStatus) => {
    lease.store.resync(snapshotEvents(id, stableRows(), status, false, approvalReconnect));
    publishedPages = pages.length === 1 ? 1 : pages.length - 1;
  };
  const publishApprovals = (status: ServerStatus) => {
    for (const event of snapshotEvents(id, [], status, true, approvalReconnect)) if (event.type === "approval_request") lease.store.dispatch(event);
  };
  const loadPageRange = async (start: number) => {
    const loaded: LoadedPage[] = [];
    for (let offset: number | null = start; offset !== null; ) {
      const page = await historyPage(offset, activeSignal);
      loaded.push(page);
      offset = page.nextOffset;
    }
    return loaded;
  };
  const loadFullHistory = async () => { pages = await loadPageRange(0); };
  const appendProgressPage = (page: LoadedPage, count: number) => {
    pages.push(page);
    if (page.nextOffset !== null) {
      for (const event of fromZetaHistory(page.rows)) if (!isApprovalEvent(event)) lease.store.dispatch(event);
      publishedPages++;
    }
    if (page.nextOffset === null || count % 25 === 0) progress?.(allRows().length, page.nextOffset === null);
  };
  const loadRemainingPages = async () => {
    let offset = pages.at(-1)?.nextOffset ?? null;
    for (let count = 1; offset !== null; count++) {
      const page = await historyPage(offset, activeSignal);
      appendProgressPage(page, count);
      offset = page.nextOffset;
    }
  };
  const publishFinalTail = (status: ServerStatus) => {
    for (const page of pages.slice(publishedPages))
      for (const event of fromZetaHistory(page.rows)) if (!isApprovalEvent(event)) lease.store.dispatch(event);
    if (pages.length > 1)
      for (const event of fromZetaHistory(allRows())) if (isApprovalEvent(event)) lease.store.dispatch(event);
    for (const event of snapshotEvents(id, [], status, true, approvalReconnect)) lease.store.dispatch(event);
    publishedPages = pages.length;
  };
  const waitUntilIdle = async (status = initialStatus): Promise<ServerStatus> => {
    let pending = JSON.stringify(status.pending_approvals ?? []);
    while (status.state !== "idle") {
      await wait(500, activeSignal);
      status = await getStatus(client, activeSignal);
      const nextPending = JSON.stringify(status.pending_approvals ?? []);
      if (nextPending !== pending) publishApprovals(status);
      pending = nextPending;
    }
    return status;
  };

  let firstLoad = true;
  const lease = await client.replay(id, async (replaySignal) => {
    activeSignal = combinedSignal(replaySignal);
    if (!firstLoad) {
      await loadFullHistory();
      return snapshotEvents(id, allRows(), await getStatus(client, activeSignal), true, approvalReconnect);
    }
    firstLoad = false;
    const before = knownStatus ?? await getStatus(client, activeSignal);
    if (registration) {
      const resumed = await client.request("resume", { session_id: id, host_commands: [registration.command] }, { timeoutMs: 30_000, signal: activeSignal }) as { session?: SessionMeta };
      initialStatus = before.session?.session_id === id ? before : { session: resumed.session ?? null, state: "idle", pending_approvals: [] };
    } else if (before.session?.session_id === id) initialStatus = before;
    else {
      const resumed = await client.request("resume", { session_id: id }, { timeoutMs: 30_000, signal: activeSignal }) as { session?: SessionMeta };
      initialStatus = { session: resumed.session ?? null, state: "idle", pending_approvals: [] };
    }
    pages = [await historyPage(0, activeSignal)];
    progress?.(allRows().length, pages[0]!.nextOffset === null);
    return snapshotEvents(id, allRows(), initialStatus, pages[0]!.nextOffset === null, approvalReconnect);
  }, true);

  const reconcileTail = async () => {
    const before = pages.at(-1)!;
    const revision = client.replayRevision(id);
    const tail = await loadPageRange(before.offset);
    const changed = changedTailBoundary(before, tail);
    if (changed) await loadFullHistory();
    else pages.splice(pages.length - 1, 1, ...tail);
    const status = await getStatus(client, activeSignal);
    if (changed || pages.length === 1) publishStablePrefix(status);
    const clean = client.finishReplay(id, revision);
    if (clean) publishFinalTail(status);
    return { clean, status };
  };
  const finishWhenClean = async (status: ServerStatus) => {
    while (true) {
      for (let attempt = 0; attempt < MAX_TAIL_RECONCILES; attempt++) {
        const result = await reconcileTail();
        status = result.status;
        if (result.clean) return;
      }
      status = status.state === "idle" ? (await wait(500, activeSignal), await getStatus(client, activeSignal)) : await waitUntilIdle(status);
    }
  };
  const complete = (async (): Promise<{ syncing: boolean }> => {
    try {
      await wait(0, activeSignal);
      const [, idle] = await Promise.all([loadRemainingPages(), waitUntilIdle()]);
      if (client.replayRevision(id) === 0 && client.finishReplay(id, 0)) {
        publishFinalTail(idle);
        return { syncing: false };
      }
      await finishWhenClean(idle);
      return { syncing: false };
    } catch (error) {
      throw error;
    }
  })();
  return { lease, session: initialStatus.session, syncing: initialStatus.state !== "idle", complete };
}

export const isBusyError = (error: unknown) => (error as { code?: unknown } | null)?.code === -32004;

export type OpenRun = { id: string; lease: SessionLease; stale: boolean; history: { messages: number; complete: boolean }; syncing: boolean };
export type OpenFailure = { id: string; message: string; busy: boolean; restored?: boolean };
export type SessionTransition =
  | { kind: "idle"; selected: string | null }
  | { kind: "opening"; to: string; messages: number }
  | { kind: "open"; run: OpenRun }
  | { kind: "replacing"; from: OpenRun; to: string; messages: number }
  | { kind: "failed"; run: OpenRun | null; to: string; error: OpenFailure };

export const transitionRun = (transition: SessionTransition): OpenRun | null =>
  transition.kind === "open" ? transition.run : transition.kind === "replacing" ? transition.from : transition.kind === "failed" ? transition.run : null;
export const transitionSelected = (transition: SessionTransition): string | null => {
  if (transition.kind === "idle") return transition.selected;
  if (transition.kind === "open") return transition.run.id;
  if (transition.kind === "failed" && transition.error.restored && transition.run) return transition.run.id;
  return transition.kind === "replacing" || transition.kind === "opening" || transition.kind === "failed" ? transition.to : null;
};

type TransitionEvent =
  | { type: "start"; id: string }
  | { type: "progress"; id: string; messages: number }
  | { type: "opened"; run: OpenRun }
  | { type: "updated"; run: OpenRun }
  | { type: "failed"; id: string; error: OpenFailure }
  | { type: "stale" }
  | { type: "dismiss" };

export function reduceSessionTransition(transition: SessionTransition, event: TransitionEvent): SessionTransition {
  const run = transitionRun(transition);
  switch (event.type) {
    case "start": return run ? { kind: "replacing", from: run, to: event.id, messages: 0 } : { kind: "opening", to: event.id, messages: 0 };
    case "opened":
    case "updated": return { kind: "open", run: event.run };
    case "failed": return { kind: "failed", run, to: event.id, error: event.error };
    case "stale": return run ? { kind: "open", run: { ...run, stale: true } } : transition;
    case "dismiss": return run ? { kind: "open", run } : { kind: "idle", selected: transitionSelected(transition) };
    case "progress": {
      if (transition.kind === "opening" && transition.to === event.id) return { ...transition, messages: event.messages };
      if (transition.kind === "replacing" && transition.to === event.id) return { ...transition, messages: event.messages };
      return transition;
    }
  }
}

export const sessionPresentation = (transition: SessionTransition) => {
  const run = transitionRun(transition);
  const opening = transition.kind === "opening" ? { id: transition.to, messages: transition.messages }
    : transition.kind === "replacing" ? { id: transition.to, messages: transition.messages } : null;
  return {
    selected: transitionSelected(transition),
    open: run,
    opening,
    openError: transition.kind === "failed" ? transition.error : null,
  };
};

export type RunState = {
  transition: SessionTransition;
  /** zeta's metadata for the run on screen: its title, model, and cwd. Null for a blank run. */
  session: SessionMeta | null;
};

type Source = { readonly client: ZetaClient | null; subscribe(listener: () => void): () => void };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The one run the page shows, over a connection. On every connect it reopens the selected run; with none selected the
 * page is a blank run until `create`, and the server's own session is never opened on its own. The newest open wins;
 * leases of abandoned opens are released.
 */
export function createRun(connection: Source, { selected = null, onSelect, bindings }: { selected?: string | null; onSelect?: (id: string | null) => void; bindings?: HostBindings } = {}) {
  let state: RunState = { transition: { kind: "idle", selected }, session: null };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<RunState>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); };
  const transition = (event: TransitionEvent) => set({ transition: reduceSessionTransition(state.transition, event) });
  let client: ZetaClient | null = null;
  let openGeneration = 0;
  let openAbort: AbortController | null = null;
  const live = (target: ZetaClient) => client === target;
  const register = (target: ZetaClient, id?: string) => bindings && target.features.includes("session_host_commands") ? bindings.register(id) : undefined;

  const open = async (id: string, knownStatus?: ServerStatus) => {
    const target = client;
    const mine = ++openGeneration;
    openAbort?.abort();
    const abort = new AbortController();
    openAbort = abort;
    transition({ type: "start", id });
    if (!target) return;
    const previous = transitionRun(state.transition);
    const previousId = previous?.id !== id ? previous?.id : null;
    try {
      let history = { messages: 0, complete: false };
      const opened = await openSession(target, id, (messages, complete) => {
        history = { messages, complete };
        if (mine !== openGeneration) return;
        transition({ type: "progress", id, messages });
      }, abort.signal, knownStatus, await register(target, id));
      const { lease } = opened;
      if (mine !== openGeneration || !live(target)) return lease.release();
      previous?.lease.release();
      if (opened.session) set({ session: opened.session });
      transition({ type: "opened", run: { id, lease, stale: false, history, syncing: opened.syncing } });
      void opened.complete.then((result) => {
        if (mine !== openGeneration || !live(target)) return result.lease?.release();
        if (result.lease) {
          const run = transitionRun(state.transition);
          run?.lease.release();
          transition({ type: "updated", run: { id, lease: result.lease, stale: false, history: { ...history, complete: true }, syncing: result.syncing } });
        } else {
          const run = transitionRun(state.transition);
          if (run?.id === id) transition({ type: "updated", run: { ...run, history: { ...history, complete: true }, syncing: result.syncing } });
        }
      }).catch((error) => {
        if (mine === openGeneration && live(target) && (error as { name?: string }).name !== "AbortError")
          transition({ type: "failed", id, error: { id, message: message(error), busy: isBusyError(error) } });
      });
    } catch (error) {
      if (mine !== openGeneration || !live(target)) return;
      let restored = false;
      if (previousId) {
        try {
          const binding = await register(target, previousId);
          await target.request("resume", { session_id: previousId, ...(binding ? { host_commands: [binding.command] } : {}) }, { timeoutMs: 30_000 });
          restored = true;
        } catch { /* keep the retained run read-only with an explicit reopen action */ }
      }
      if (mine !== openGeneration || !live(target)) return;
      if (restored && previousId) onSelect?.(previousId);
      transition({ type: "failed", id, error: { id, message: message(error), busy: isBusyError(error), ...(restored ? { restored: true } : {}) } });
    }
  };

  const markApprovalsReconnecting = (disconnected: ZetaClient | null) => {
    const run = transitionRun(state.transition);
    if (!run || !disconnected?.features.includes("approval_reconnect")) return;
    for (const { id: itemId } of run.lease.store.getOutline()) {
      const item = run.lease.store.getItem(itemId);
      if (item?.type === "approval" && !item.ended && item.request.type === "approval_request")
        run.lease.store.dispatch({ ...item.request, state: "reconnecting", status: "reconnecting…", disabled_reason: "decisions are disabled while disconnected" });
    }
  };
  const disconnect = (disconnected: ZetaClient | null) => {
    openGeneration++;
    openAbort?.abort();
    markApprovalsReconnecting(disconnected);
    transition({ type: "stale" });
  };
  const connect = async (target: ZetaClient) => {
    const id = transitionSelected(state.transition);
    if (!id) return;
    try {
      const status = await getStatus(target);
      if (live(target)) await open(id, status);
    } catch (error) {
      if (live(target)) transition({ type: "failed", id, error: { id, message: message(error), busy: isBusyError(error) } });
    }
  };
  const onConnection = () => {
    if (connection.client === client) return;
    const disconnected = client;
    client = connection.client;
    if (client) void connect(client);
    else disconnect(disconnected);
  };
  const unsubscribe = connection.subscribe(onConnection);
  onConnection();

  return {
    get state() { return state; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Opens `id` again, for a retry after a failed open. */
    select(id: string) {
      const run = transitionRun(state.transition);
      if (id === transitionSelected(state.transition) && ((state.transition.kind === "opening" || state.transition.kind === "replacing") || (run?.id === id && !run.stale))) return;
      onSelect?.(id);
      void open(id);
    },
    dismissOpenError() { transition({ type: "dismiss" }); },
    /**
     * Starts the run with zeta's `new_session` (which makes it the server's own) and opens it. `model` and `provider`
     * pick the model the first turn uses. Rejects with zeta's error, so the composer keeps the draft and says why.
     */
    async create(choice: { model?: string; provider?: string; approval_mode?: "ask" | "allow" } = {}) {
      const target = client;
      if (!target) throw new Error("not connected to zeta serve");
      const binding = await register(target);
      const { approval_mode, ...sessionChoice } = choice;
      const params = { ...sessionChoice, ...(target.features.includes("new_session_settings") && approval_mode ? { approval_mode } : {}), ...(binding ? { host_commands: [binding.command] } : {}) };
      const { session } = (await target.request("new_session", params, { timeoutMs: 30_000 })) as { session: SessionMeta };
      if (binding) await bindings!.bind(binding.registration_id, session.session_id);
      if (!live(target)) throw new Error("the connection dropped while the run started");
      set({ session });
      onSelect?.(session.session_id);
      await open(session.session_id);
      const failure = state.transition.kind === "failed" ? state.transition.error : null;
      if (failure) throw new Error(failure.message);
      return session.session_id;
    },
    /** Back to a blank run: the next send starts a new session. */
    reset() {
      openGeneration++;
      openAbort?.abort();
      transitionRun(state.transition)?.lease.release();
      onSelect?.(null);
      set({ transition: { kind: "idle", selected: null }, session: null });
    },
    dispose() {
      unsubscribe();
      openGeneration++;
      openAbort?.abort();
      transitionRun(state.transition)?.lease.release();
    },
  };
}
export type RunControl = ReturnType<typeof createRun>;
