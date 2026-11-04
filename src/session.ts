import { fromZetaEvent, fromZetaHistory, type SessionLease, type ZetaClient } from "@fulcrum/zeta";
import type { RunEvent } from "@fulcrum/core";

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

export const PAGE_SIZE = 100;

/** The name, else the first prompt, else where it ran and a short id, so untitled rows still differ. */
export const sessionTitle = (session: SessionMeta) =>
  session.name?.trim() || session.first_message_preview?.trim() ||
  (session.cwd ? `${session.cwd.split("/").filter(Boolean).at(-1) ?? "/"} · ${session.session_id.slice(0, 8)}` : "untitled session");

/** "now", "4m", "3h", "2d", then a short date. Short, because the list is narrow and scanned, not read. */
export function ago(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d`;
  return new Date(then).toLocaleDateString("en", { month: "short", day: "numeric", ...(new Date(then).getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }) });
}

/** Newest first. Child sessions (workers a session started) are left out; the parent row stands for them. */
export const topLevel = (sessions: readonly SessionMeta[]) =>
  sessions.filter((session) => !session.parent_session_id).sort((a, b) => b.updated_at.localeCompare(a.updated_at));

export async function listSessions(client: ZetaClient, offset = 0): Promise<{ sessions: SessionMeta[]; nextOffset: number | null }> {
  const paged = client.features.includes("list_sessions_paging");
  const result = (await client.request("list_sessions", paged ? { offset, limit: PAGE_SIZE } : {})) as { sessions?: SessionMeta[]; next_offset?: number | null };
  return { sessions: result.sessions ?? [], nextOffset: paged ? result.next_offset ?? null : null };
}

export const getStatus = (client: ZetaClient, signal?: AbortSignal) => client.request("status", {}, { timeoutMs: 15_000, signal }) as Promise<ServerStatus>;

export type OpenProgress = (messages: number, complete: boolean) => void;
export type OpenResult = { lease: SessionLease; syncing: boolean; complete: Promise<{ lease?: SessionLease; syncing: boolean }> };

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
    if (before.session?.session_id === id) initialStatus = before;
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
  return { lease, syncing: initialStatus.state !== "idle", complete };
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

export type SessionsState = {
  sessions: SessionMeta[];
  nextOffset: number | null;
  listError: string | null;
  listLoading: boolean;
  listSlow: boolean;
  listReady: boolean;
  /** The server's own session from `status` and what it is doing. */
  server: { id: string | null; state: ServerStatus["state"]; approvals: number } | null;
  transition: SessionTransition;
  /** A `new_session` in flight, and why the last one failed. */
  creating: boolean;
  createError: string | null;
};

type Source = { readonly client: ZetaClient | null; subscribe(listener: () => void): () => void };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Session list and selection over a connection. On every connect it reloads the list and reopens the selected
 * session, or the server's own session when nothing is selected. The newest `select` wins; leases of abandoned
 * opens are released.
 */
export function createSessions(connection: Source, { selected = null, onSelect }: { selected?: string | null; onSelect?: (id: string) => void } = {}) {
  let state: SessionsState = { sessions: [], nextOffset: null, listError: null, listLoading: false, listSlow: false, listReady: false, server: null, transition: { kind: "idle", selected }, creating: false, createError: null };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<SessionsState>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); };
  const transition = (event: TransitionEvent) => set({ transition: reduceSessionTransition(state.transition, event) });
  let client: ZetaClient | null = null;
  let openGeneration = 0;
  let openAbort: AbortController | null = null;
  const live = (target: ZetaClient) => client === target;

  type Catalog = { client: ZetaClient; inFlight: Promise<void> | null; slowTimer: ReturnType<typeof setTimeout> | null };
  let catalog: Catalog | null = null;
  const localSessions = new Map<string, { session: SessionMeta; createdGeneration: number }>();
  let listGeneration = 0;
  const currentCatalog = (owner: Catalog) => catalog === owner;
  const retireCatalog = () => {
    const timer = catalog?.slowTimer;
    if (timer !== null && timer !== undefined) clearTimeout(timer);
    catalog = null;
  };
  const refresh = async () => {
    const owner = catalog;
    if (!owner) return;
    if (owner.inFlight) return owner.inFlight;
    const generation = ++listGeneration;
    set({ listLoading: true, listSlow: false, listError: null, listReady: false });
    owner.slowTimer = setTimeout(() => { if (currentCatalog(owner)) set({ listSlow: true }); }, 5_000);
    owner.inFlight = (async () => {
      try {
        const list = await listSessions(owner.client);
        if (!currentCatalog(owner)) return;
        const visible = new Map(list.sessions.map((session) => [session.session_id, session]));
        for (const [id, local] of localSessions) {
          if (local.createdGeneration < generation) localSessions.delete(id);
          else if (!visible.has(id)) visible.set(id, local.session);
        }
        set({ sessions: [...visible.values()], nextOffset: list.nextOffset, listError: null, listReady: true });
      } catch (error) {
        if (currentCatalog(owner)) set({ listError: message(error) });
      } finally {
        if (owner.slowTimer !== null) clearTimeout(owner.slowTimer);
        owner.slowTimer = null;
        owner.inFlight = null;
        if (currentCatalog(owner)) set({ listLoading: false, listSlow: false });
      }
    })();
    return owner.inFlight;
  };

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
      }, abort.signal, knownStatus);
      if (!state.listLoading && !state.listReady) void refresh();
      const { lease } = opened;
      if (mine !== openGeneration || !live(target)) return lease.release();
      previous?.lease.release();
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
          await target.request("resume", { session_id: previousId }, { timeoutMs: 30_000 });
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
    retireCatalog();
    set({ listLoading: false, listSlow: false, listReady: false });
    openGeneration++;
    openAbort?.abort();
    markApprovalsReconnecting(disconnected);
    transition({ type: "stale" });
  };
  const loadConnection = async (target: ZetaClient) => {
    try {
      const status = await getStatus(target);
      if (!live(target)) return;
      set({ server: { id: status.session?.session_id ?? null, state: status.state, approvals: status.pending_approvals?.length ?? 0 } });
      const id = transitionSelected(state.transition) ?? status.session?.session_id ?? null;
      if (id) {
        await open(id, status);
        if (!live(target)) return;
      } else void refresh();
    } catch (error) {
      if (!live(target)) return;
      const id = transitionSelected(state.transition) ?? "";
      transition({ type: "failed", id, error: { id, message: message(error), busy: isBusyError(error) } });
    }
  };
  const connect = (target: ZetaClient) => {
    retireCatalog();
    catalog = { client: target, inFlight: null, slowTimer: null };
    set({ listLoading: false, listSlow: false, listReady: false, listError: null });
    void loadConnection(target);
  };
  const onConnection = () => {
    if (connection.client === client) return;
    const disconnected = client;
    client = connection.client;
    if (client) connect(client);
    else disconnect(disconnected);
  };
  const unsubscribe = connection.subscribe(onConnection);
  onConnection();

  return {
    get state() { return state; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select(id: string) {
      const run = transitionRun(state.transition);
      if (id === transitionSelected(state.transition) && ((state.transition.kind === "opening" || state.transition.kind === "replacing") || (run?.id === id && !run.stale))) return;
      onSelect?.(id);
      void open(id);
    },
    refresh,
    dismissOpenError() { transition({ type: "dismiss" }); },
    /** Starts a session with zeta's `new_session` (which makes it the server's own), then opens it. */
    async create() {
      const target = client;
      if (!target || state.creating) return;
      set({ creating: true, createError: null });
      try {
        const { session } = (await target.request("new_session", {}, { timeoutMs: 30_000 })) as { session: SessionMeta };
        if (!live(target)) return set({ creating: false });
        localSessions.set(session.session_id, { session, createdGeneration: listGeneration });
        set({ creating: false, sessions: [session, ...state.sessions.filter((item) => item.session_id !== session.session_id)] });
        onSelect?.(session.session_id);
        await open(session.session_id);
        void refresh();
      } catch (error) {
        set({ creating: false, createError: live(target) ? message(error) : null });
      }
    },
    async loadMore() {
      const target = client;
      if (!target || state.nextOffset === null) return;
      try {
        const page = await listSessions(target, state.nextOffset);
        if (live(target)) set({ sessions: [...state.sessions, ...page.sessions], nextOffset: page.nextOffset });
      } catch (error) {
        if (live(target)) set({ listError: message(error) });
      }
    },
    dispose() {
      unsubscribe();
      retireCatalog();
      openGeneration++;
      openAbort?.abort();
      transitionRun(state.transition)?.lease.release();
    },
  };
}
export type Sessions = ReturnType<typeof createSessions>;
