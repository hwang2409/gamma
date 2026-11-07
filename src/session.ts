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
export type OpenFailure = { id: string; message: string; busy: boolean };
export type RunState = {
  selected: string | null;
  open: OpenRun | null;
  opening: { id: string; messages: number } | null;
  openError: OpenFailure | null;
  session: SessionMeta | null;
  /** The attached run that owns zeta's active turn, independent from the selected URL. */
  active: string | null;
  attached: string | null;
};

type Source = { readonly client: ZetaClient | null; subscribe(listener: () => void): () => void };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Owns cached session leases while exposing only the exact URL-selected run. */
export function createRun(connection: Source, { selected = null, onSelect, bindings }: { selected?: string | null; onSelect?: (id: string | null) => void; bindings?: HostBindings } = {}) {
  let state: RunState = { selected, open: null, opening: selected ? { id: selected, messages: 0 } : null, openError: null, session: null, active: null, attached: null };
  const cachedRuns = new Map<string, OpenRun>();
  const cachedSessions = new Map<string, SessionMeta>();
  const listeners = new Set<() => void>();
  const set = (patch: Partial<RunState>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); };
  let client: ZetaClient | null = null;
  let activeSubscription = () => {};
  let openGeneration = 0;
  let openAbort: AbortController | null = null;
  let attachmentHolds = 0;
  let deferredSelection: string | null | undefined;
  let createdPending: string | null = null;
  const live = (target: ZetaClient) => client === target;
  const register = (target: ZetaClient, id?: string) => bindings && target.features.includes("session_host_commands") ? bindings.register(id) : undefined;
  const watchActiveTurn = (id: string, run: OpenRun) => {
    activeSubscription();
    const update = () => set({ active: run.lease.store.getState().agent === "running" ? id : null });
    activeSubscription = run.lease.store.subscribe(update);
    update();
  };
  const publishSelected = (id: string) => set({
    selected: id,
    open: cachedRuns.get(id) ?? null,
    opening: cachedRuns.has(id) ? null : { id, messages: 0 },
    openError: null,
    session: cachedSessions.get(id) ?? null,
  });
  const updateCached = (id: string, run: OpenRun) => {
    cachedRuns.set(id, run);
    if (state.selected === id) set({ open: run, opening: null });
  };
  const open = async (id: string, knownStatus?: ServerStatus, present = true) => {
    const target = client;
    if (state.active && state.active !== id) {
      publishSelected(id);
      set({ opening: cachedRuns.has(id) ? null : { id, messages: 0 }, openError: { id, message: `${state.active} has the active turn`, busy: true } });
      return;
    }
    const mine = ++openGeneration;
    openAbort?.abort();
    const abort = new AbortController();
    openAbort = abort;
    if (present) publishSelected(id);
    const cached = cachedRuns.get(id);
    if (!target || (cached && state.attached === id && !cached.stale)) return;
    try {
      const registration = await register(target, id);
      let status = knownStatus;
      if (cached && !status) {
        const resumed = await target.request("resume", { session_id: id, ...(registration ? { host_commands: [registration.command] } : {}) }, { timeoutMs: 30_000, signal: abort.signal }) as { session?: SessionMeta };
        status = await getStatus(target, abort.signal);
        if (!status.session) status = { ...status, session: resumed.session ?? null };
      }
      if (mine !== openGeneration || !live(target)) return;
      let history = { messages: 0, complete: false };
      const opened = await openSession(target, id, (messages, complete) => {
        history = { messages, complete };
        if (mine === openGeneration && state.selected === id) set({ opening: { id, messages } });
      }, abort.signal, status, registration);
      if (mine !== openGeneration || !live(target)) { opened.lease.release(); return; }
      const run = { id, lease: opened.lease, stale: false, history, syncing: opened.syncing };
      const old = cachedRuns.get(id);
      if (old && old.lease !== run.lease) old.lease.release();
      if (opened.session) cachedSessions.set(id, opened.session);
      updateCached(id, run);
      set({ attached: id, ...(state.selected === id ? { session: opened.session ?? cachedSessions.get(id) ?? null, openError: null } : {}) });
      watchActiveTurn(id, run);
      void opened.complete.then((result) => {
        const nextSelection = state.active === id ? state.selected : null;
        if (state.active === id) set({ active: null });
        if (result.lease) {
          const current = cachedRuns.get(id);
          if (mine !== openGeneration || !live(target)) return result.lease.release();
          current?.lease.release();
          const completed = { ...run, lease: result.lease, history: { ...history, complete: true }, syncing: result.syncing };
          updateCached(id, completed);
          if (state.attached === id) watchActiveTurn(id, completed);
        } else if (cachedRuns.get(id) === run) updateCached(id, { ...run, history: { ...history, complete: true }, syncing: result.syncing });
        if (nextSelection && nextSelection !== id) void open(nextSelection);
      }).catch((error) => {
        if (mine === openGeneration && live(target) && state.selected === id && (error as { name?: string }).name !== "AbortError")
          set({ openError: { id, message: message(error), busy: isBusyError(error) } });
      });
    } catch (error) {
      if (mine !== openGeneration || !live(target) || (error as { name?: string }).name === "AbortError") return;
      set({ open: cachedRuns.get(id) ?? null, opening: null, openError: { id, message: message(error), busy: isBusyError(error) } });
    }
  };
  const disconnect = () => {
    openGeneration++;
    openAbort?.abort();
    const selected = state.selected && cachedRuns.get(state.selected);
    if (selected && client?.features.includes("approval_reconnect")) {
      for (const { id: itemId } of selected.lease.store.getOutline()) {
        const item = selected.lease.store.getItem(itemId);
        if (item?.type === "approval" && !item.ended && item.request.type === "approval_request")
          selected.lease.store.dispatch({ ...item.request, state: "reconnecting", status: "reconnecting…", disabled_reason: "decisions are disabled while disconnected" });
      }
    }
    activeSubscription();
    activeSubscription = () => {};
    for (const [id, run] of cachedRuns) cachedRuns.set(id, { ...run, stale: true });
    set({ open: state.selected ? cachedRuns.get(state.selected) ?? null : null, active: null, attached: null });
  };
  const connect = async (target: ZetaClient) => {
    try {
      const status = await getStatus(target);
      if (!live(target)) return;
      const owner = status.state === "idle" ? null : status.session?.session_id ?? null;
      set({ attached: status.session?.session_id ?? null, active: owner });
      if (state.selected) await open(state.selected, status);
    } catch (error) {
      if (live(target) && state.selected) set({ opening: null, openError: { id: state.selected, message: message(error), busy: isBusyError(error) } });
    }
  };
  const onConnection = () => {
    if (connection.client === client) return;
    if (client) disconnect();
    client = connection.client;
    if (client) void connect(client);
  };
  const unsubscribe = connection.subscribe(onConnection);
  onConnection();

  return {
    get state() { return state; },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    select(id: string) {
      if (id === state.selected && (state.opening || (state.open && !state.open.stale))) return;
      onSelect?.(id);
      if (attachmentHolds) { deferredSelection = id; publishSelected(id); return; }
      void open(id);
    },
    holdAttachment() {
      attachmentHolds++;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        if (--attachmentHolds) return;
        const target = deferredSelection === undefined ? createdPending : deferredSelection;
        deferredSelection = undefined; createdPending = null;
        if (target) void open(target);
      };
    },
    dismissOpenError() { set({ openError: null }); },
    async refreshStatus() {
      if (!client) return;
      const status = await getStatus(client);
      const owner = status.state === "idle" ? null : status.session?.session_id ?? null;
      set({ active: owner, attached: status.session?.session_id ?? state.attached });
      if (!owner && state.selected && !state.selected.startsWith("draft:")) await open(state.selected, status);
    },
    sendImages(sessionId: string, deliveryId: string, text: string, images: readonly { name: string; mime_type: string; data: string }[]) {
      if (!client || state.attached !== sessionId) throw Object.assign(new Error("session is not attached"), { code: -32003 });
      return client.request("send_images", { session_id: sessionId, delivery_id: deliveryId, text, images }, { timeoutMs: 30_000 });
    },
    async create(choice: { model?: string; provider?: string; approval_mode?: "ask" | "allow" } = {}) {
      const target = client;
      if (!target) throw new Error("not connected to zeta serve");
      const binding = await register(target);
      const { approval_mode, ...sessionChoice } = choice;
      const params = { ...sessionChoice, ...(target.features.includes("new_session_settings") && approval_mode ? { approval_mode } : {}), ...(binding ? { host_commands: [binding.command] } : {}) };
      const { session } = (await target.request("new_session", params, { timeoutMs: 30_000 })) as { session: SessionMeta };
      if (binding) await bindings!.bind(binding.registration_id, session.session_id);
      if (!live(target)) throw new Error("the connection dropped while the run started");
      cachedSessions.set(session.session_id, session);
      createdPending = session.session_id;
      set({ attached: session.session_id, ...(deferredSelection === undefined ? { selected: session.session_id, opening: { id: session.session_id, messages: 0 }, open: null, session } : {}) });
      onSelect?.(session.session_id);
      await open(session.session_id, undefined, deferredSelection === undefined);
      if (!attachmentHolds) createdPending = null;
      return session.session_id;
    },
    reset() {
      if (!state.active) { openGeneration++; openAbort?.abort(); }
      if (attachmentHolds) deferredSelection = null;
      onSelect?.(null);
      set({ selected: null, open: null, opening: null, openError: null, session: null });
    },
    dispose() {
      unsubscribe();
      openGeneration++;
      openAbort?.abort();
      cachedRuns.forEach((run) => run.lease.release());
      cachedRuns.clear();
      activeSubscription();
    },
  };
}
export type RunControl = ReturnType<typeof createRun>;
