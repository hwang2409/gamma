import {
  listChildRuns,
  openChildRun,
  sendChildRun,
  type ChildRunHistoryProgress,
  type ChildRunRow,
  type OpenChildRunResult,
  type ZetaClient,
} from "@fulcrum/zeta";

export type ChildKey = { readonly sessionId: string; readonly runId: string };
export type ChildCatalog = {
  readonly owner: string | null;
  readonly runs: readonly ChildRunRow[];
  readonly nextOffset?: number;
  readonly invalidRows: number;
  readonly loading: boolean;
  readonly warning: string | null;
  readonly reportedAt: number | null;
};
export type ChildHistory = {
  readonly key: ChildKey;
  readonly result: OpenChildRunResult;
  readonly progress: ChildRunHistoryProgress;
};
export type ChildRunsSnapshot = { readonly catalog: ChildCatalog; readonly history: ChildHistory | null; readonly historyError: unknown; readonly historyLoading: boolean };

type Listener = () => void;
const pair = ({ sessionId, runId }: ChildKey) => `${sessionId}\u0000${runId}`;
const same = (left: ChildKey, right: ChildKey) => left.sessionId === right.sessionId && left.runId === right.runId;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createChildRunsController(client: ZetaClient, now = Date.now) {
  let catalog: ChildCatalog = { owner: null, runs: [], invalidRows: 0, loading: false, warning: null, reportedAt: null };
  let generation = 0;
  let listAbort: AbortController | null = null;
  let historyAbort: AbortController | null = null;
  let history: ChildHistory | null = null;
  let historyError: unknown = null;
  let historyLoading = false;
  const drafts = new Map<string, string>();
  const sending = new Set<string>();
  const listeners = new Set<Listener>();
  let snapshot: ChildRunsSnapshot = { catalog, history, historyError, historyLoading };
  const emit = () => { snapshot = { catalog, history, historyError, historyLoading }; listeners.forEach((listener) => listener()); };
  const publish = (next: ChildCatalog) => { catalog = next; emit(); };

  const load = async (owner: string, mode: "open" | "refresh" | "more" = "open") => {
    if (mode === "open" && catalog.owner === owner && (catalog.loading || catalog.reportedAt !== null)) return;
    const continuation = mode === "more";
    const offset = continuation ? catalog.nextOffset : 0;
    if (continuation && offset === undefined) return;
    const base = catalog.runs;
    const current = ++generation;
    listAbort?.abort();
    const abort = listAbort = new AbortController();
    publish({ ...(catalog.owner === owner ? catalog : { owner, runs: [], invalidRows: 0, reportedAt: null }), loading: true, warning: null });
    try {
      const result = await listChildRuns(client, owner, { offset, limit: 100, signal: abort.signal });
      if (current !== generation || abort.signal.aborted || catalog.owner !== owner) return;
      if (result.kind !== "page") {
        publish({ ...catalog, loading: false, warning: result.kind === "unavailable" ? "child catalog needs a newer zeta server" : "zeta returned an invalid child report" });
        return;
      }
      const runs = continuation ? [...base, ...result.runs] : result.runs;
      publish({ owner, runs, ...(result.nextOffset === undefined ? {} : { nextOffset: result.nextOffset }), invalidRows: (continuation ? catalog.invalidRows : 0) + result.invalidRows, loading: false, warning: result.invalidRows ? `${result.invalidRows} invalid child ${result.invalidRows === 1 ? "row was" : "rows were"} omitted` : null, reportedAt: now() });
    } catch (error) {
      if (current !== generation || abort.signal.aborted || catalog.owner !== owner) return;
      publish({ ...catalog, loading: false, warning: message(error) });
    }
  };

  const setOwner = (owner: string | null) => {
    if (catalog.owner === owner) return;
    generation += 1;
    listAbort?.abort();
    listAbort = null;
    historyAbort?.abort();
    historyAbort = null;
    history?.result.lease.release();
    history = null;
    historyError = null;
    historyLoading = false;
    publish({ owner, runs: [], invalidRows: 0, loading: false, warning: null, reportedAt: null });
  };

  const open = async (key: ChildKey) => {
    if (history && same(history.key, key)) return history.result;
    historyAbort?.abort();
    history?.result.lease.release();
    history = null;
    historyError = null;
    historyLoading = true;
    const abort = historyAbort = new AbortController();
    let progress: ChildRunHistoryProgress = { messages: 0, complete: false, restart: 0 };
    emit();
    try {
      const result = await openChildRun(client, key, {
        signal: abort.signal,
        onProgress(next) {
          progress = next;
          if (!history || history.key.sessionId !== key.sessionId || history.key.runId !== key.runId || historyAbort !== abort) return;
          history = { ...history, progress };
          emit();
        },
      });
      if (abort.signal.aborted || historyAbort !== abort) { result.lease.release(); return result; }
      history = { key, result, progress };
      historyLoading = false;
      emit();
      void result.complete.then(() => {
        if (history?.result !== result) return;
        history = { ...history, progress: { ...history.progress, messages: result.lease.store.getState().outline.length, complete: true } };
        emit();
      }, (error) => {
        if (history?.result !== result) return;
        historyError = error;
        emit();
      });
      return result;
    } catch (error) {
      if (historyAbort !== abort || abort.signal.aborted) throw error;
      historyLoading = false;
      historyError = error;
      emit();
      throw error;
    }
  };

  const closeHistory = () => {
    historyAbort?.abort();
    historyAbort = null;
    history?.result.lease.release();
    history = null;
    historyError = null;
    historyLoading = false;
    emit();
  };

  const send = async (key: ChildKey, text: string) => {
    const id = pair(key);
    if (sending.has(id)) return { kind: "busy" as const };
    sending.add(id);
    emit();
    try {
      const result = await sendChildRun(client, key, text);
      if (result.kind === "accepted" && result.runId === key.runId) {
        if (drafts.get(id) === text) drafts.delete(id);
        await load(key.sessionId, "refresh");
      }
      return result;
    } finally {
      sending.delete(id);
      emit();
    }
  };

  return {
    subscribe(listener: Listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get snapshot() { return snapshot; },
    setOwner,
    load,
    open,
    closeHistory,
    draft(key: ChildKey) { return drafts.get(pair(key)) ?? ""; },
    setDraft(key: ChildKey, value: string) { drafts.set(pair(key), value); emit(); },
    sending(key: ChildKey) { return sending.has(pair(key)); },
    send,
    dispose() { setOwner(null); closeHistory(); listeners.clear(); },
  };
}

export type ChildRunsController = ReturnType<typeof createChildRunsController>;
