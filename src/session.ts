import { fromZetaEvent, fromZetaHistory, servedTurnOutcome, statusTurnOutcome, type SessionLease, type ZetaClient } from "@fulcrum/zeta";
import type { RunEvent } from "@fulcrum/core";
import type { hostBindings, Registration } from "./host-client";
import type { QueuedImage } from "./image-queue";
import { evictedResult, refusal } from "./delivery";
import { decideSend, MISMATCH, sessionMismatch } from "./delivery-owner";
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
  last_turn_outcome?: { turn_id?: unknown; reason?: unknown } | null;
};

/** The name, else the first prompt; null when zeta has neither yet. */
export const sessionTitle = (session: SessionMeta | null) => session?.name?.trim() || session?.first_message_preview?.trim() || null;

export const getStatus = (client: ZetaClient, signal?: AbortSignal) => client.request("status", {}, { timeoutMs: 15_000, signal }) as Promise<ServerStatus>;

export type OpenProgress = (messages: number, complete: boolean) => void;
export type OpenResult = { lease: SessionLease; session: SessionMeta | null; syncing: boolean; complete: Promise<{ lease?: SessionLease; syncing: boolean }> };

type HistoryPage = { messages?: unknown[]; next_offset?: number | null };
const isApprovalEvent = (event: RunEvent) => event.type === "approval_request" || event.type === "approval_end";
const terminalEvents = (status: ServerStatus, rows: unknown[] = [], restoredTurnId?: string, historyComplete = true): RunEvent[] => {
  if (status.state !== "idle") return [{ type: "run_start" }];
  const turnId = typeof status.last_turn_outcome?.turn_id === "string" ? status.last_turn_outcome.turn_id : undefined;
  const hasServedOutcome = rows.some((row) => row && typeof row === "object" && (row as { event?: unknown }).event === "served_turn_end");
  const outcome = turnId
    ? servedTurnOutcome(rows, turnId) ?? (historyComplete && !hasServedOutcome ? statusTurnOutcome(status.last_turn_outcome, turnId) : undefined)
    : undefined;
  const stopped: RunEvent[] = outcome === "cancelled" && restoredTurnId !== turnId
    ? [{ type: "error", error: { code: "aborted", message: "turn aborted" } }]
    : [];
  return [...stopped, { type: "run_end", ...(outcome ? { outcome } : {}) }];
};
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
  onReplay?: () => void,
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
  let stoppedRestoredTurnId: string | undefined;
  const finalEvents = (rows: unknown[], status: ServerStatus, historyComplete = true, replacing = false) => {
    const events = terminalEvents(status, rows, replacing ? undefined : stoppedRestoredTurnId, historyComplete);
    const turnId = typeof status.last_turn_outcome?.turn_id === "string" ? status.last_turn_outcome.turn_id : undefined;
    if (events.some((event) => event.type === "error" && event.error.code === "aborted")) stoppedRestoredTurnId = turnId;
    else if (replacing && stoppedRestoredTurnId === turnId) stoppedRestoredTurnId = undefined;
    return events;
  };
  const replayEvents = (rows: unknown[], status: ServerStatus, historyComplete = true) => [
    ...snapshotEvents(id, rows, status, historyComplete, approvalReconnect),
    ...finalEvents(rows, status, historyComplete, true),
  ];
  const stableRows = () => (pages.length === 1 ? pages : pages.slice(0, -1)).flatMap((page) => page.rows);
  const publishStablePrefix = (status: ServerStatus) => {
    lease.store.resync(replayEvents(stableRows(), status, false));
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
    for (const event of finalEvents(allRows(), status)) lease.store.dispatch(event);
    publishedPages = pages.length;
  };
  const waitUntilIdle = async (status?: ServerStatus): Promise<ServerStatus> => {
    const shouldWait = status !== undefined || initialStatus.state !== "idle";
    status ??= initialStatus.state === "idle" ? await getStatus(client, activeSignal) : initialStatus;
    let pending = JSON.stringify(status.pending_approvals ?? []);
    while (shouldWait && status.state !== "idle") {
      await wait(500, activeSignal);
      status = await getStatus(client, activeSignal);
      const nextPending = JSON.stringify(status.pending_approvals ?? []);
      if (nextPending !== pending) publishApprovals(status);
      pending = nextPending;
    }
    return status;
  };

  // Attach before the replay: fulcrum's replay disposes the session's old store first, so a busy or failed resume
  // leaves the last transcript readable.
  const before = knownStatus ?? await getStatus(client, signal);
  if (registration) {
    const resumed = await client.request("resume", { session_id: id, host_commands: [registration.command] }, { timeoutMs: 30_000, signal }) as { session?: SessionMeta };
    id = resumed.session?.session_id ?? id;
    initialStatus = before.session?.session_id === id ? before : { session: resumed.session ?? null, state: "idle", pending_approvals: [] };
  } else if (before.session?.session_id === id) initialStatus = before;
  else {
    const resumed = await client.request("resume", { session_id: id }, { timeoutMs: 30_000, signal }) as { session?: SessionMeta };
    id = resumed.session?.session_id ?? id;
    initialStatus = { session: resumed.session ?? null, state: "idle", pending_approvals: [] };
  }
  if (signal?.aborted) throw Object.assign(new Error("request aborted"), { name: "AbortError" });
  onReplay?.();
  let firstLoad = true;
  const lease = await client.replay(id, async (replaySignal) => {
    activeSignal = combinedSignal(replaySignal);
    if (!firstLoad) {
      await loadFullHistory();
      return replayEvents(allRows(), await getStatus(client, activeSignal));
    }
    firstLoad = false;
    pages = [await historyPage(0, activeSignal)];
    progress?.(allRows().length, pages[0]!.nextOffset === null);
    return replayEvents(allRows(), initialStatus, pages[0]!.nextOffset === null);
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
      const [, status] = await Promise.all([loadRemainingPages(), waitUntilIdle()]);
      if (client.replayRevision(id) === 0 && client.finishReplay(id, 0)) {
        publishFinalTail(status);
        return { syncing: false };
      }
      await finishWhenClean(status);
      return { syncing: false };
    } catch (error) {
      throw error;
    }
  })();
  return { lease, session: initialStatus.session, syncing: initialStatus.state !== "idle", complete };
}

export const isBusyError = (error: unknown) => (error as { code?: unknown } | null)?.code === -32004;

export type OpenRun = { id: string; lease: SessionLease; stale: boolean; history: { messages: number; complete: boolean }; syncing: boolean };
export type OpenCandidate = { id: string; unique: boolean };
export type OpenFailure = { id: string; message: string; busy: boolean; candidates?: readonly OpenCandidate[] };
export type RunState = {
  selected: string | null;
  open: OpenRun | null;
  opening: { id: string; messages: number; loading: boolean } | null;
  openError: OpenFailure | null;
  session: SessionMeta | null;
  /** The attached run that owns zeta's active turn, independent from the selected URL. */
  active: string | null;
  /** The active run's title (its id when gamma has no name for it), for notes a person reads. */
  activeTitle: string | null;
  attached: string | null;
};

type Source = { readonly client: ZetaClient | null; subscribe(listener: () => void): () => void };
type RunStateStore = import("./run-state").RunStateStore;
type WorkspaceEffect = import("./run-state").WorkspaceEffect;
type OperationId = import("./run-state").OperationId;
type SessionId = import("./run-state").SessionId;
type DraftRunId = import("./run-state").DraftRunId;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const ambiguousCandidates = (error: unknown): readonly OpenCandidate[] | undefined => {
  const data = (error as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || (data as { code?: unknown }).code !== "session_id_ambiguous") return undefined;
  const requested = (data as { session_id?: unknown }).session_id;
  const raw = (data as { candidates?: unknown }).candidates;
  if (typeof requested !== "string" || !Array.isArray(raw) || !raw.every((candidate) => typeof candidate === "string")) return undefined;
  const counts = new Map<string, number>();
  for (const candidate of raw.slice(0, 8)) counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
  return [...counts].map(([id, count]) => ({ id, unique: count === 1 && id !== requested && id.startsWith(requested) }));
};
const turn = (status: ServerStatus) => status.pending_approvals?.length ? "approval" as const : status.state === "idle" ? "idle" as const : status.state;

/** Executes tagged session effects. Run selection, leases, attachment, and active-turn truth remain in RunStateStore. */
export function createSessionManager(connection: Source, runs: RunStateStore, bindings?: HostBindings) {
  let client: ZetaClient | null = null;
  let unsubscribe = () => {};
  let started = false;
  let openAbort: AbortController | null = null;
  let openOperation: { runId: SessionId; operationId: OperationId } | null = null;
  const leaseSubscriptions = new Map<string, () => void>();
  const leases = new Map<string, OpenRun>();
  const replays = new Map<string, Promise<void>>();
  const knownStatus = new Map<string, ServerStatus>();
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
  const live = (target: ZetaClient) => client === target;
  const register = (target: ZetaClient, id?: string) => bindings && target.features.includes("session_host_commands") ? bindings.register(id) : undefined;
  const finish = (operationId: OperationId | undefined, value?: unknown, error?: unknown) => {
    if (!operationId) return;
    const waiter = pending.get(operationId); if (!waiter) return;
    pending.delete(operationId); error === undefined ? waiter.resolve(value) : waiter.reject(error);
  };
  const current = (runId: string, operationId: OperationId) => runs.isCurrentOperation(runId, operationId);
  const watch = (runId: SessionId, open: OpenRun) => {
    leases.set(runId, open);
    leaseSubscriptions.get(runId)?.();
    let running = open.lease.store.getState().agent === "running";
    const update = () => {
      const next = open.lease.store.getState().agent === "running";
      if (next === running) return;
      running = next;
      runs.dispatch(next ? { type: "TURN_START", runId } : { type: "TURN_END", runId });
    };
    leaseSubscriptions.set(runId, open.lease.store.subscribe(update));
    if (running) runs.dispatch({ type: "TURN_START", runId });
  };
  const handleStatus = async (effect: Extract<WorkspaceEffect, { type: "status" }>) => {
    const target = client;
    if (!target) return;
    try {
      const status = await getStatus(target);
      if (!live(target)) return;
      knownStatus.clear();
      if (status.session) knownStatus.set(status.session.session_id, status);
      runs.dispatch({ type: "STATUS", ...(status.session ? { sessionId: status.session.session_id as SessionId, session: status.session } : {}), turn: turn(status), operationId: effect.operationId });
      finish(effect.operationId, status);
    } catch (error) { finish(effect.operationId, undefined, error); }
  };
  const handleOpen = async (effect: Extract<WorkspaceEffect, { type: "open-session" }>) => {
    const target = client;
    if (!target || !current(effect.runId, effect.operationId)) return;
    openAbort?.abort();
    const abort = new AbortController();
    openAbort = abort;
    openOperation = { runId: effect.runId, operationId: effect.operationId };
    // The previous lease stays readable until this open's replay replaces its store.
    const replaced = () => {
      const previous = leases.get(effect.runId);
      runs.dispatch({ type: "OPEN_EVICTED", runId: effect.runId, operationId: effect.operationId });
      if (!previous) return;
      leaseSubscriptions.get(effect.runId)?.();
      leaseSubscriptions.delete(effect.runId);
      leases.delete(effect.runId);
      previous.lease.release();
    };
    try {
      let history = { messages: 0, complete: false };
      const registration = await register(target, effect.runId);
      const initialStatus = knownStatus.get(effect.runId);
      knownStatus.clear();
      // fulcrum refuses a second replay of a session until the aborted one unwinds (back then forward during an open).
      const prior = replays.get(effect.runId);
      if (prior) { await prior; if (!live(target) || !current(effect.runId, effect.operationId)) return; }
      const attempt = openSession(target, effect.runId, (messages, complete) => {
        history = { messages, complete };
        runs.dispatch({ type: "OPEN_PROGRESS", runId: effect.runId, operationId: effect.operationId, messages });
      }, abort.signal, initialStatus, registration, replaced);
      const settled = attempt.then(() => {}, () => {}).finally(() => { if (replays.get(effect.runId) === settled) replays.delete(effect.runId); });
      replays.set(effect.runId, settled);
      const opened = await attempt;
      const runId = (opened.session?.session_id ?? effect.runId) as SessionId;
      try {
        if (registration && runId !== effect.runId) await bindings!.bind(registration.registration_id, runId);
      } catch (error) { opened.complete.catch(() => {}); opened.lease.release(); throw error; }
      if (!live(target) || !current(effect.runId, effect.operationId)) { opened.complete.catch(() => {}); opened.lease.release(); return; }
      runs.dispatch({ type: "SESSION_CANONICALIZED", runId: effect.runId, sessionId: runId, operationId: effect.operationId });
      const open: OpenRun = { id: runId, lease: opened.lease, stale: false, history, syncing: true };
      runs.dispatch({ type: "RESUME_OK", runId, operationId: effect.operationId });
      runs.dispatch({ type: "OPEN_OK", runId, operationId: effect.operationId, open, ...(opened.session ? { session: opened.session } : {}) });
      watch(runId, open);
      void opened.complete.then((result) => {
        if (!current(runId, effect.operationId)) { result.lease?.release(); return; }
        const active = runs.get(runId).open ?? open;
        const complete: OpenRun = { ...active, ...(result.lease ? { lease: result.lease } : {}), history: { ...history, complete: true }, syncing: result.syncing };
        if (result.lease && active.lease !== result.lease) active.lease.release();
        runs.dispatch({ type: "OPEN_COMPLETE", runId, operationId: effect.operationId, open: complete });
        watch(runId, complete);
      }).catch((error) => {
        if (current(runId, effect.operationId) && (error as { name?: string }).name !== "AbortError") runs.dispatch({ type: "OPEN_FAIL", runId, operationId: effect.operationId, error: message(error), busy: isBusyError(error), candidates: ambiguousCandidates(error) });
      });
    } catch (error) {
      if (!live(target) || !current(effect.runId, effect.operationId) || (error as { name?: string }).name === "AbortError") return;
      runs.dispatch({ type: "OPEN_FAIL", runId: effect.runId, operationId: effect.operationId, error: message(error), busy: isBusyError(error), candidates: ambiguousCandidates(error) });
    }
  };
  const handleCreate = async (effect: Extract<WorkspaceEffect, { type: "new-session" }>) => {
    const target = client;
    if (!target) { const error = new Error("not connected to zeta serve"); runs.dispatch({ type: "NEW_SESSION_FAIL", runId: effect.runId, operationId: effect.operationId, error: error.message }); return finish(effect.operationId, undefined, error); }
    try {
      const binding = await register(target);
      const { approval_mode, ...sessionChoice } = effect.choice ?? {};
      const params = { ...sessionChoice, ...(target.features.includes("new_session_settings") && approval_mode ? { approval_mode } : {}), ...(binding ? { host_commands: [binding.command] } : {}) };
      const { session } = await target.request("new_session", params, { timeoutMs: 30_000 }) as { session: SessionMeta };
      if (binding) await bindings!.bind(binding.registration_id, session.session_id);
      if (!live(target) || !current(effect.runId, effect.operationId)) return;
      runs.dispatch({ type: "NEW_SESSION_OK", runId: effect.runId, sessionId: session.session_id as SessionId, operationId: effect.operationId, session });
      finish(effect.operationId, session.session_id);
    } catch (error) {
      if (!live(target) || !current(effect.runId, effect.operationId)) return;
      runs.dispatch({ type: "NEW_SESSION_FAIL", runId: effect.runId, operationId: effect.operationId, error: message(error), busy: isBusyError(error) });
      finish(effect.operationId, undefined, error);
    }
  };
  const handleImages = async (effect: Extract<WorkspaceEffect, { type: "send-images" }>) => {
    const delivery = runs.get(effect.runId).deliveries.get(effect.intentId);
    const { blocked, sessionId } = decideSend(runs.getCatalog(), effect.runId, { kind: "attempt", intentId: effect.intentId });
    // Nothing left gamma: the draft keeps its id and says why, the same shape as handleDelivery's pre-send block.
    if (!client || !delivery || blocked) { const error = new Error(client && delivery ? blocked : "session is not attached"); runs.dispatch({ type: "DELIVERY_ACK", runId: effect.runId, operationId: effect.operationId, intentId: effect.intentId, attemptId: effect.intentId, queued: false, failed: true, blocked: true, note: error.message }); finish(effect.operationId, undefined, error); return; }
    try {
      await client.request("send_images", { session_id: sessionId, text: delivery.text, images: delivery.images.map(({ name, mime_type, data }) => ({ name, mime_type, data })), delivery_id: effect.intentId }, { timeoutMs: 30_000 });
      runs.dispatch({ type: "DELIVERY_ACK", runId: effect.runId, operationId: effect.operationId, intentId: effect.intentId, attemptId: effect.intentId, queued: false }); finish(effect.operationId, true);
    } catch (error) {
      if (sessionMismatch(error)) { runs.dispatch({ type: "DELIVERY_ACK", runId: effect.runId, operationId: effect.operationId, intentId: effect.intentId, attemptId: effect.intentId, failed: true, blocked: true, note: MISMATCH }); return finish(effect.operationId, undefined, new Error(MISMATCH)); }
      const evicted = evictedResult(error);
      if (evicted?.accepted) { runs.dispatch({ type: "DELIVERY_ACK", runId: effect.runId, operationId: effect.operationId, intentId: effect.intentId, attemptId: effect.intentId, queued: false }); return finish(effect.operationId, true); }
      runs.dispatch({ type: "DELIVERY_ACK", runId: effect.runId, operationId: effect.operationId, intentId: effect.intentId, attemptId: effect.intentId, queued: false, failed: true, refused: Boolean(evicted) });
      finish(effect.operationId, undefined, evicted ? refusal(evicted) : error);
    }
  };
  const executeOne = (effect: WorkspaceEffect) => {
    if (effect.type === "status") return void handleStatus(effect);
    if (effect.type === "send-images") return void handleImages(effect);
    if (effect.type === "open-session") return void handleOpen(effect);
    if (effect.type === "new-session") return void handleCreate(effect);
    if (effect.type === "release-lease") { const open = leases.get(effect.runId); leaseSubscriptions.get(effect.runId)?.(); leaseSubscriptions.delete(effect.runId); leases.delete(effect.runId); open?.lease.release(); }
  };
  const onConnection = () => {
    if (connection.client === client) return;
    if (client) {
      openAbort?.abort(); openOperation = null; leaseSubscriptions.forEach((stop) => stop()); leaseSubscriptions.clear();
      if (client.features.includes("approval_reconnect")) for (const record of runs.getCatalog().runs.values()) if (record.open) for (const { id } of record.open.lease.store.getOutline()) {
        const item = record.open.lease.store.getItem(id);
        if (item?.type === "approval" && !item.ended && item.request.type === "approval_request") record.open.lease.store.dispatch({ ...item.request, state: "reconnecting", status: "reconnecting…", disabled_reason: "decisions are disabled while disconnected" });
      }
      runs.dispatch({ type: "DISCONNECT" });
    }
    client = connection.client;
    if (client) runs.dispatch({ type: "RECONNECT" });
  };
  return {
    execute(effects: readonly WorkspaceEffect[]) {
      if (openOperation && !current(openOperation.runId, openOperation.operationId)) { openAbort?.abort(); openOperation = null; }
      for (const effect of effects) executeOne(effect);
    },
    start() { if (started) return; started = true; unsubscribe = connection.subscribe(onConnection); onConnection(); },
    create(runId: string, choice: { model?: string; provider?: string; approval_mode?: "ask" | "allow" } = {}) {
      const operationId = crypto.randomUUID() as OperationId;
      const result = new Promise<string>((resolve, reject) => pending.set(operationId, { resolve: (value) => resolve(String(value)), reject }));
      runs.startSession(runId, choice, operationId);
      return result;
    },
    refreshStatus() {
      const operationId = crypto.randomUUID() as OperationId;
      const result = new Promise<ServerStatus>((resolve, reject) => pending.set(operationId, { resolve: (value) => resolve(value as ServerStatus), reject }));
      void handleStatus({ type: "status", operationId });
      return result;
    },
    dismissOpenError(runId: string) { runs.dispatch({ type: "OPEN_DISMISS", runId: runId as SessionId }); },
    retryOpen(runId: string) { runs.requestOpen(runId); },
    abort(runId: string) {
      const attachment = runs.getCatalog().attachment;
      if (!client || attachment.kind !== "attached" || attachment.sessionId !== runId) throw Object.assign(new Error("session is not attached"), { code: -32003 });
      return client.request("abort", {}, { timeoutMs: 10_000 });
    },
    sendImages(sessionId: string, deliveryId: string, text: string, images: readonly QueuedImage[]) {
      const operationId = crypto.randomUUID() as OperationId;
      return new Promise<void>((resolve, reject) => {
        pending.set(operationId, { resolve: () => resolve(), reject });
        runs.dispatch({ type: "DELIVERY_BEGIN", runId: sessionId as SessionId, operationId, delivery: { id: deliveryId, attemptId: deliveryId, operationId, method: "send_images", text, images, state: "requesting" } });
      });
    },
    dispose() { unsubscribe(); openAbort?.abort(); openOperation = null; leaseSubscriptions.forEach((stop) => stop()); leaseSubscriptions.clear(); pending.clear(); },
  };
}
export type SessionManager = ReturnType<typeof createSessionManager>;
