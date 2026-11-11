import type { SubAgentNavigation } from "@fulcrum/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createTextDraftStore, type TextDraftStore } from "./run-state";
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
const draftKey = ({ sessionId, runId }: ChildKey) => `child:${JSON.stringify([sessionId, runId])}`;
const same = (left: ChildKey, right: ChildKey) => left.sessionId === right.sessionId && left.runId === right.runId;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export type ChildRunAuthority = "controller" | "observer";

export function childNavigationUnavailable({ authority, canList, canOpenHistory }: { authority: ChildRunAuthority; canList: boolean; canOpenHistory: boolean }) {
  return authority === "observer" || canOpenHistory || canList ? undefined : "child details need a newer zeta server";
}

export function createChildRunsController(client: ZetaClient, now = Date.now, authority: ChildRunAuthority = "controller", draftStore: TextDraftStore = createTextDraftStore()) {
  let catalog: ChildCatalog = { owner: null, runs: [], invalidRows: 0, loading: false, warning: null, reportedAt: null };
  let generation = 0;
  let listAbort: AbortController | null = null;
  let historyAbort: AbortController | null = null;
  let history: ChildHistory | null = null;
  let historyError: unknown = null;
  let historyLoading = false;
  const drafts = draftStore;
  const sending = new Set<string>();
  const listeners = new Set<Listener>();
  let snapshot: ChildRunsSnapshot = { catalog, history, historyError, historyLoading };
  const emit = () => { snapshot = { catalog, history, historyError, historyLoading }; listeners.forEach((listener) => listener()); };
  const publish = (next: ChildCatalog) => { catalog = next; emit(); };

  const load = async (owner: string, mode: "open" | "refresh" | "more" = "open") => {
    if (authority !== "controller") return;
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
    if (authority !== "controller") return { kind: "read_only" as const };
    const id = pair(key);
    if (sending.has(id)) return { kind: "busy" as const };
    sending.add(id);
    emit();
    try {
      const result = await sendChildRun(client, key, text);
      if (result.kind === "accepted" && result.runId === key.runId) {
        if (drafts.get(draftKey(key)) === text) drafts.delete(draftKey(key));
        if (catalog.owner === key.sessionId) await load(key.sessionId, "refresh");
      }
      return result;
    } finally {
      sending.delete(id);
      emit();
    }
  };

  return {
    subscribe(listener: Listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get authority() { return authority; },
    get snapshot() { return snapshot; },
    setOwner,
    load,
    open,
    closeHistory,
    draft(key: ChildKey) { return drafts.get(draftKey(key)) ?? ""; },
    setDraft(key: ChildKey, value: string) { if (value) drafts.set(draftKey(key), value); else drafts.delete(draftKey(key)); emit(); },
    sending(key: ChildKey) { return sending.has(pair(key)); },
    send,
    dispose() { setOwner(null); closeHistory(); listeners.clear(); },
  };
}

export type ChildRunsController = ReturnType<typeof createChildRunsController>;

const EMPTY_CHILD_SNAPSHOT: ChildRunsSnapshot = { catalog: { owner: null, runs: [], invalidRows: 0, loading: false, warning: null, reportedAt: null }, history: null, historyError: null, historyLoading: false };

export function useChildRoute({
  client,
  authority,
  owner,
  child,
  canList,
  canOpenHistory,
  onPushChild,
  onBack,
  onReplaceParent,
}: {
  client: ZetaClient | null;
  authority: ChildRunAuthority;
  owner: string | null;
  child: string | undefined;
  canList: boolean;
  canOpenHistory: boolean;
  onPushChild(runId: string): void;
  onBack(): void;
  onReplaceParent(): void;
}) {
  const drafts = useRef<TextDraftStore>(createTextDraftStore());
  const controller = useMemo(() => client ? createChildRunsController(client, Date.now, authority, drafts.current) : null, [authority, client]);
  const snapshot = useSyncExternalStore(controller ? controller.subscribe : () => () => {}, () => controller?.snapshot ?? EMPTY_CHILD_SNAPSHOT);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const activationTarget = useRef<HTMLElement | null>(null);
  const pushed = useRef(false);
  const openedFromCatalog = useRef(false);
  const childrenButtonRef = useRef<HTMLButtonElement>(null);
  const parentRef = useRef<HTMLElement>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => controller?.dispose(), [controller]);
  useEffect(() => () => { if (focusTimer.current) clearTimeout(focusTimer.current); }, []);
  useEffect(() => {
    const remember = (event: Event) => {
      const target = event.composedPath().find((candidate) => candidate instanceof HTMLElement && candidate.matches("button, a[href], [tabindex]"));
      activationTarget.current = target instanceof HTMLElement ? target : null;
      queueMicrotask(() => { if (activationTarget.current === target) activationTarget.current = null; });
    };
    document.addEventListener("click", remember, true);
    document.addEventListener("keydown", remember, true);
    return () => { document.removeEventListener("click", remember, true); document.removeEventListener("keydown", remember, true); };
  }, []);
  useEffect(() => { controller?.setOwner(owner); }, [controller, owner]);
  useEffect(() => {
    if (!controller || !child || !owner) return;
    if (authority === "controller" && canList) void controller.load(owner);
    if (canOpenHistory) void controller.open({ sessionId: owner, runId: child }).catch(() => undefined);
    return () => controller.closeHistory();
  }, [authority, canList, canOpenHistory, child, controller, owner]);

  const openChild = useCallback((runId: string) => {
    if (!owner) return;
    if (focusTimer.current) { clearTimeout(focusTimer.current); focusTimer.current = null; }
    if (!openedFromCatalog.current) {
      const active = document.activeElement;
      opener.current = activationTarget.current ?? (active instanceof HTMLElement && active !== document.body ? active : null);
    }
    openedFromCatalog.current = false;
    pushed.current = true;
    onPushChild(runId);
    setCatalogOpen(false);
  }, [onPushChild, owner]);
  const closeChild = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      onBack();
    } else onReplaceParent();
    focusTimer.current = setTimeout(() => {
      focusTimer.current = null;
      (opener.current?.isConnected ? opener.current : childrenButtonRef.current ?? parentRef.current)?.focus();
    }, 300);
  }, [onBack, onReplaceParent]);
  const openCatalog = useCallback((element: HTMLElement) => {
    if (!controller || !owner || authority !== "controller" || !canList) return;
    opener.current = element;
    openedFromCatalog.current = true;
    setCatalogOpen(true);
    void controller.load(owner);
  }, [authority, canList, controller, owner]);
  const closeCatalog = useCallback(() => {
    openedFromCatalog.current = false;
    setCatalogOpen(false);
    setTimeout(() => opener.current?.focus(), 0);
  }, []);
  const navigation = useMemo<SubAgentNavigation | null>(() => client && owner ? {
    open: openChild,
    unavailable: () => childNavigationUnavailable({ authority, canList, canOpenHistory }),
  } : null, [authority, canList, canOpenHistory, client, openChild, owner]);

  return {
    controller,
    snapshot,
    catalogOpen,
    navigation,
    openChild,
    closeChild,
    openCatalog,
    closeCatalog,
    childrenButtonRef,
    parentRef: parentRef as RefObject<HTMLElement>,
    canList: authority === "controller" && canList,
    canSend: authority === "controller",
  };
}
