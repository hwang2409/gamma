import { createHighlighter } from "@fulcrum/highlight";
import { Markdown, type Fences, type MarkdownProps } from "@fulcrum/markdown/react";
import { MermaidFence } from "@fulcrum/mermaid";
import { Approval, Code, Fallback, FileBlock, HighlightContext, ImageBlock, Message, Notification, RunProvider, SubAgentNavigationProvider, Timeline, ToolCall, useItemSelector, useRun, useRunStore, useTimeline, type Renderers, type UserMessageItem } from "@fulcrum/react";
import { createRunStore } from "@fulcrum/core";
import { CHILD_RUN_HISTORY_FEATURE, CHILD_RUNS_FEATURE, ChildRunHistoryError, SESSION_GRANTS_FEATURE, type ChildRunRow, type ZetaClient } from "@fulcrum/zeta";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { commandRequests, createConnection, serveCommand, type Connection, type ConnectionState } from "./connection";
import { createDeliveryManager, stopTurn, type DeliveryManager } from "./delivery";
import { createSessionManager, sessionTitle, type OpenRun, type RunState, type SessionManager, type SessionMeta } from "./session";
import { themeChoices, ThemePicker, useTheme, type ThemeChoice } from "./theme";
import { GammaComposer, type Submit } from "./composer";
import { nextRunModel, PermissionsControl, RunSettings, SettingsMenu, useVimSetting, VimToggle } from "./controls";
import { activeRun, createRunStateStore, inputBlockText, runInput, settingsBlockText, workspaceRunState, type DraftRunId, type EntryId, type RunId, type RunStateStore } from "./run-state";
import { artifactContentUrl, hostBindings, useArtifacts } from "./host-client";
import type { Artifact } from "./host/types";
import { createCommandController, createUnavailableCommandController, isSlashCommandText, type ClientActionName, type ComposerAction } from "./commands";
import { createReceiptStore, type ReceiptStore } from "./receipts";
import { RenderErrorBoundary } from "./error-boundary";
import { createApprovalDecider, pendingApprovals } from "./approvals";
import { createClientActions, createLocalActions, type ActionReceipt } from "./client-actions";
import { alwaysAllowed as getAlwaysAllowed, markAlwaysAllowed, subscribeAlwaysAllowed } from "./always-allowed";
import { createSessionGrantsModel, type SessionGrantsModel } from "./session-grants";
import { useChildRoute, type ChildKey, type ChildRunsController } from "./child-runs";
import { createWriteClient, type WriteClient } from "./write-client";

const highlight = createHighlighter();
addEventListener("pagehide", () => highlight.dispose(), { once: true });
const fences: Fences = { mermaid: MermaidFence };
const RichMarkdown = (props: MarkdownProps) => <Markdown {...props} highlight={highlight} fences={fences} />;

// Renderers stay module-level so appends never re-render every row; approvals reach the live client through context.
type Decide = (requestId: string) => Promise<unknown>;
const Decisions = createContext<{ approve?: Decide; always?: Decide; deny?: Decide; disabledReason?: string; alwaysAllowed?: ReadonlySet<string>; markAlways?(toolId: string): void; observer?: true } | null>(null);
function ZetaApproval({ id }: { id: string }) {
  const decide = useContext(Decisions);
  const toolId = useItemSelector(id, (item) => item?.type === "approval" && item.request.type === "approval_request" ? item.request.tool_call.id : "");
  const pending = useItemSelector(id, (item) => item?.type === "approval" && !item.ended);
  // An observer sees the request but has no decision to make: no buttons (css hides any a disabled_reason would draw).
  if (decide?.observer) return <div className="observer-approval"><Approval id={id} />{pending ? <p className="note" role="status">waiting for the controller to approve</p> : null}</div>;
  const approveAlways = decide?.always;
  const always = approveAlways && ((requestId: string) => approveAlways(requestId).then((result) => { decide?.markAlways?.(toolId); return result; }));
  return <Approval id={id} onApprove={decide?.approve} onApproveAlways={always} approveAlwaysLabel="always allow" onDeny={decide?.deny} disabledReason={decide?.disabledReason} />;
}
// The intents of steers a stop dropped: zeta never gave them to the agent, so their rows must not look delivered.
const DeliveryStates = createContext<ReadonlyMap<string, import("./delivery-owner").PendingDelivery>>(new Map());
const UNDELIVERED: Record<string, string> = {
  turn_end: "not delivered · the turn ended before zeta used this steer",
  abort: "not delivered · the stop ended the turn before zeta took this steer",
  stop: "not delivered · the stop ended the turn before zeta took this steer",
  clear: "not delivered · pending steers were cleared before zeta used this steer",
  disconnect: "not delivered · the connection ended before zeta used this steer",
  failed: "not delivered · the turn failed before zeta used this steer",
  restart: "not delivered · zeta restarted before it used this steer",
  dropped: "not delivered · zeta did not take this message",
  unconfirmed: "not confirmed · resend will not run it twice",
};
const ResendDelivery = createContext<((intent: string) => void) | null>(null);
function UserRow({ id }: { id: string }) {
  const intent = useItemSelector(id, (item) => (item?.type === "user" && item.event.type === "user_message" ? item.event.intent : undefined));
  const delivery = useItemSelector(id, (item) => (item?.type === "user" && item.event.type === "user_message" ? item.event.delivery_id : undefined));
  const deliveries = useContext(DeliveryStates);
  const resend = useContext(ResendDelivery);
  const identity = intent ?? delivery ?? (id.startsWith("user:intent:") ? id.slice("user:intent:".length) : id.startsWith("user:delivery:") ? id.slice("user:delivery:".length) : "");
  const pending = deliveries.get(identity);
  const state = pending?.state;
  const lost = state === "dropped";
  const waiting = state === "requesting" || state === "queued";
  const label = state === "requesting" && pending?.resent ? "resending" : state;
  const renderDeliveryNote = useCallback((item: UserMessageItem) => {
    if (item.event.delivery_status !== "dropped" && !lost && !item.event.text_omitted) return null;
    const reason = item.event.delivery_reason ?? pending?.why ?? "dropped";
    return <>{UNDELIVERED[reason] ?? UNDELIVERED.dropped}{item.event.text_omitted ? " · text not kept" : null}{pending?.failure ? <span className="resend-failure">{pending.failure}</span> : null} {lost && !item.event.text_omitted && resend && identity ? <button type="button" className="ghost" onClick={() => resend(identity)}>resend</button> : null}</>;
  }, [identity, lost, pending?.failure, pending?.why, resend]);
  return (
    <>
      <Fallback id={id} renderDeliveryNote={renderDeliveryNote} />
      {waiting ? <p className="queued-delivery" role="status" aria-label={`message ${label}`}>{label}</p> : null}
    </>
  );
}
const ImageViewer = createContext<((block: any) => void) | null>(null);
const Artifacts = createContext<readonly Artifact[]>([]);
function ArtifactContent({ artifact }: { artifact: Artifact }) {
  const onOpen = useContext(ImageViewer);
  const url = artifactContentUrl(artifact);
  const block = { type: artifact.media_type.startsWith("image/") ? "image" : "file", url, mediaType: artifact.media_type, size: artifact.size, title: artifact.title ?? undefined, filename: artifact.filename ?? undefined, artifact } as any;
  return <div className="artifact" data-media-type={artifact.media_type}>
    {artifact.media_type.startsWith("image/") ? <ImageBlock id={`${artifact.artifact_id}:${artifact.version}`} block={block} streaming={false} onOpen={onOpen ?? undefined} />
    : artifact.media_type === "text/markdown" ? <ArtifactMarkdown artifact={artifact} block={block} onOpen={onOpen} />
    : <FileBlock id={`${artifact.artifact_id}:${artifact.version}`} block={block} streaming={false} onOpen={onOpen ?? undefined} />}
  </div>;
}
function ArtifactMarkdown({ artifact, block, onOpen }: { artifact: Artifact; block: any; onOpen: ((block: any) => void) | null }) {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => { let live = true; void fetch(artifactContentUrl(artifact)).then((response) => response.text()).then((text) => { if (live) setSource(text); }); return () => { live = false; }; }, [artifact]);
  return <div className="artifact-markdown"><div className="artifact-label"><span>{artifact.title ?? artifact.filename ?? "markdown"}</span>{onOpen ? <button type="button" onClick={() => onOpen(block)}>open</button> : null}</div>{source === null ? <span>loading…</span> : <RichMarkdown source={source} streaming={false} />}</div>;
}
function ArtifactList({ anchor }: { anchor: string | null }) {
  const artifacts = useContext(Artifacts).filter((artifact) => artifact.anchor_tool_call_id === anchor);
  return artifacts.length ? <div className="artifacts" aria-label="rendered files">{artifacts.map((artifact) => <ArtifactContent key={`${artifact.artifact_id}:${artifact.version}`} artifact={artifact} />)}</div> : null;
}
function ToolWithArtifacts({ id }: { id: string }) {
  const toolId = useItemSelector(id, (item) => item?.type === "tool" ? item.tool_call.id : null);
  const decisions = useContext(Decisions);
  const alwaysAllowed = Boolean(toolId && decisions?.alwaysAllowed?.has(toolId));
  return <><div className={alwaysAllowed ? "gamma-tool always-allowed" : "gamma-tool"}><ToolCall id={id} />{alwaysAllowed ? <span className="approval-session-decision">always allowed for this session</span> : null}</div>{toolId ? <ArtifactList anchor={toolId} /> : null}</>;
}
const ApprovalModeContext = createContext(false);
function YoloIndicator({ className = "" }: { className?: string }) {
  const yolo = useContext(ApprovalModeContext);
  return yolo ? <strong className={`yolo-indicator ${className}`} title="tools run without asking">YOLO</strong> : null;
}
function ZetaMessage({ id }: { id: string }) {
  const onOpen = useContext(ImageViewer);
  return <Message id={id} markdown={RichMarkdown} onOpen={onOpen ?? undefined} />;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function localDeadline(value: unknown) {
  if (typeof value !== "string") return;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return;
  const now = new Date();
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return { iso: date.toISOString(), label: sameDay ? clock : date.getFullYear() === now.getFullYear() ? `${day}, ${clock}` : `${day}, ${date.getFullYear()}, ${clock}` };
}
function ZetaNotification({ id }: { id: string }) {
  const data = useItemSelector(id, (item) => item?.type === "notification" && item.event.type === "notification" ? item.event.data : undefined);
  if (!data || data.kind !== "child_hold") return <Notification id={id} />;
  const description = typeof data.description === "string" && data.description.trim() ? data.description.trim() : typeof data.child_instance_id === "string" && data.child_instance_id.trim() ? data.child_instance_id.trim() : "";
  const until = localDeadline(data.until);
  if (!description || !until) return <Notification id={id} />;
  const reason = data.reason === "rate_limit" ? "rate limit" : data.reason === "subscription_limit" ? "subscription limit" : "";
  return <div role="group" aria-label="notification" data-part="notification" data-kind="child-hold" data-status="held" data-id={id}>
    <span data-part="notification-summary"><span data-part="notification-line">child {description} waits until <time dateTime={until.iso} title={until.iso}>{until.label}</time>{reason ? <> · {reason}</> : null}</span></span>
  </div>;
}
// A failed turn's one action: send its prompt again, offered on the error row while it is the last row.
type RetryAction = { run(): void; label: "retry" | "edit and retry" };
const RetryTurn = createContext<RetryAction | null>(null);
function ErrorRow({ id }: { id: string }) {
  const retry = useContext(RetryTurn);
  const last = useRun(useCallback((state: { outline: readonly { id: string }[] }) => state.outline.at(-1)?.id === id, [id]));
  return (
    <div className="turn-error">
      <Fallback id={id} />
      {retry && last ? <button type="button" className="ghost turn-retry" onClick={retry.run}>{retry.label}</button> : null}
    </div>
  );
}
const renderers: Renderers = {
  message: ({ id }) => <ZetaMessage id={id} />,
  approval: ZetaApproval,
  user: UserRow,
  tool: ToolWithArtifacts,
  error: ErrorRow,
  notification: ZetaNotification,
};

const useExternal = <T,>(source: { subscribe(listener: () => void): () => void; readonly state: T }) =>
  useSyncExternalStore(useCallback((listener) => source.subscribe(listener), [source]), () => source.state);

/** Seconds until `at`, ticking once a second only while a wait is shown. */
function useCountdown(at: number | null) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (at === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [at]);
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

const RUN = "gamma-run";
type BrowserEntry = { gammaEntryId: string; run: string; child?: string };
const draftId = () => `draft:${crypto.randomUUID()}`;
const entryId = () => crypto.randomUUID();
const writeEntry = (entry: BrowserEntry, mode: "push" | "replace") => {
  const url = new URL(location.href);
  url.searchParams.set("run", entry.run);
  if (entry.child) url.searchParams.set("child", entry.child); else url.searchParams.delete("child");
  localStorage.setItem(RUN, entry.run);
  history[mode === "push" ? "pushState" : "replaceState"](entry, "", url);
};
const initialEntry = (): BrowserEntry => {
  const state = history.state as Partial<BrowserEntry> | null;
  const params = new URLSearchParams(location.search);
  const run = params.get("run") ?? localStorage.getItem(RUN) ?? draftId();
  const child = params.get("child") ?? undefined;
  const entry = { gammaEntryId: typeof state?.gammaEntryId === "string" ? state.gammaEntryId : entryId(), run, ...(child ? { child } : {}) };
  writeEntry(entry, "replace");
  return entry;
};

function TestRenderError({ area }: { area: "app" | "transcript" | "composer" }) {
  if (!import.meta.env.DEV) return null;
  if (new URL(location.href).searchParams.get("__gamma_render_error") !== area) return null;
  throw new Error(`planted ${area} render error`);
}

export function App() {
  const [theme, setTheme] = useTheme();
  const [vim, setVim] = useVimSetting();
  const connection = useMemo(() => createConnection({ origin: location.origin, initialPort: Number(import.meta.env.VITE_ZETA_PORT) || 8765 }), []);
  const firstEntry = useMemo(initialEntry, []);
  const runState = useMemo(() => createRunStateStore(8, localStorage, sessionStorage, { id: firstEntry.gammaEntryId as EntryId, run: firstEntry.run as RunId }), [firstEntry]);
  const workspace = useSyncExternalStore(runState.subscribe, runState.getCatalog);
  const [browserChild, setBrowserChild] = useState(firstEntry.child);
  const [suppressComposerFocus, setSuppressComposerFocus] = useState(false);
  const browserEntry = { gammaEntryId: workspace.entry.id, run: workspace.entry.run, ...(browserChild ? { child: browserChild } : {}) };
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("run") !== browserEntry.run || (params.get("child") ?? undefined) !== browserEntry.child) writeEntry(browserEntry, "replace");
  }, [browserEntry.gammaEntryId, browserEntry.run, browserEntry.child]);
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const writes = useMemo(() => createWriteClient(() => ({
    client: connectionRef.current.client,
    authority: connectionRef.current.state.phase === "connected" ? connectionRef.current.state.authority : null,
  })), []);
  const runs = useMemo(() => createSessionManager(connection, runState, hostBindings, writes), [connection, runState, writes]);
  const receipts = useMemo(createReceiptStore, []);
  const deliveries = useMemo(() => createDeliveryManager(() => connectionRef.current.client, writes, runState, runs.execute, runs.abort, (runId, text) => {
    const id = runState.canonical(runId);
    receipts.set(id, { text: runState.get(id).attachments.length ? `${text}\nattachments are still attached and were not sent.` : text, tone: "error" });
  }), [receipts, runState, runs, writes]);
  useEffect(() => {
    const activate = (id: string) => {
      const nextModel = nextRunModel().model;
      runState.activate(id, id.startsWith("draft:") ? nextModel ? { choice: "explicit", model: nextModel } : { choice: "default" } : { choice: "explicit", model: "" });
    };
    runState.dispatch({ type: "NAVIGATED", entryId: firstEntry.gammaEntryId as EntryId, runId: firstEntry.run as RunId });
    activate(firstEntry.run);
    runs.start();
    const pop = (event: PopStateEvent) => {
      const params = new URLSearchParams(location.search);
      const raw = params.get("run") ?? draftId();
      const canonical = runState.canonical(raw);
      const child = params.get("child") ?? undefined;
      const state = event.state as Partial<BrowserEntry> | null;
      const next = { gammaEntryId: typeof state?.gammaEntryId === "string" ? state.gammaEntryId : entryId(), run: canonical, ...(child ? { child } : {}) };
      if (canonical !== raw || !state?.gammaEntryId) writeEntry(next, "replace");
      setBrowserChild(child);
      runState.dispatch({ type: "NAVIGATED", entryId: next.gammaEntryId as EntryId, runId: canonical as RunId }); activate(canonical);
    };
    // A page back from the bfcache keeps its memory; it is a new page life, so it must not resend a steer by itself.
    const restored = (event: PageTransitionEvent) => { if (event.persisted) runState.dispatch({ type: "PAGE_RESTORED" }); };
    addEventListener("popstate", pop);
    addEventListener("pageshow", restored);
    return () => { removeEventListener("popstate", pop); removeEventListener("pageshow", restored); runState.dispose(); deliveries.dispose(); receipts.dispose(); runs.dispose(); connection.stop(); };
  }, [connection, deliveries, firstEntry.run, receipts, runState, runs]);
  const state = useExternal(connection);
  const view = workspaceRunState(workspace);
  const open = view.open;
  // A different reducer-owned selection gets its own empty transcript until zeta opens it.
  const blank = useMemo(() => createRunStore(), [browserEntry.run]);
  const store = open?.lease.store ?? blank;
  const selectedRecord = runState.get(browserEntry.run);
  const landedNotice = workspace.notice ?? null;
  const shownSettings = selectedRecord.settings.error ? selectedRecord.settings.loaded : selectedRecord.settings.pending ? selectedRecord.settings.desired : selectedRecord.settings.loaded ?? selectedRecord.settings.desired;
  const yolo = shownSettings?.approval_mode === "allow";
  const [retryTurn, setRetryTurn] = useState<RetryAction | null>(null);
  const [followRequest, setFollowRequest] = useState(0);
  const [viewer, setViewer] = useState<any>(null);
  const viewerOpener = useRef<HTMLElement | null>(null);
  const openViewer = useCallback((block: any) => { viewerOpener.current = document.activeElement as HTMLElement | null; setViewer(block); }, []);
  const closeViewer = useCallback(() => { setViewer(null); requestAnimationFrame(() => viewerOpener.current?.focus()); }, []);
  const deliveryStates = selectedRecord.deliveries;
  useEffect(() => {
    const controls = state.phase === "connected" && state.authority === "controller";
    deliveries.observeActive(view.active, controls);
    if (controls && view.attached) void deliveries.reconcile(view.attached);
  }, [deliveries, state.phase, view.active, view.attached]);
  const newRun = useCallback(() => {
    const next = { gammaEntryId: entryId(), run: draftId() };
    setBrowserChild(undefined);
    setSuppressComposerFocus(false);
    writeEntry(next, "push"); runState.dispatch({ type: "NEW_RUN", entryId: next.gammaEntryId as EntryId, runId: next.run as DraftRunId }); runState.activate(next.run, nextRunModel().model ? { choice: "explicit", model: nextRunModel().model! } : { choice: "default" });
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.dock textarea[aria-label="message"]')?.focus());
  }, [runState]);
  const onCreated = useCallback((from: string, sessionId: string) => {
    const currentEntry = runState.getEntry();
    const current = { gammaEntryId: currentEntry.id, run: currentEntry.run };
    if (current.run !== sessionId) return;
    const next = { ...current, run: sessionId };
    writeEntry(next, "replace");
  }, [deliveries, runState]);
  const selectRun = useCallback((id: string) => {
    const next = { gammaEntryId: entryId(), run: id };
    setBrowserChild(undefined);
    setSuppressComposerFocus(false);
    writeEntry(next, "push"); runState.dispatch({ type: "NAVIGATED", entryId: next.gammaEntryId as EntryId, runId: id as RunId }); runState.activate(id, { choice: "explicit", model: "" });
  }, [runState]);
  const client = state.phase === "connected" ? connection.client : null;
  const writeClient = state.phase === "connected" && state.authority === "controller" ? writes.get() : null;
  const attachedOwner = open?.id === browserEntry.run ? open.id : null;
  const pushChild = useCallback((runId: string) => {
    if (!attachedOwner) return;
    const next = { gammaEntryId: entryId(), run: attachedOwner, child: runId };
    writeEntry(next, "push");
    setBrowserChild(runId);
  }, [attachedOwner]);
  const backFromChild = useCallback(() => { setSuppressComposerFocus(true); history.back(); }, []);
  const replaceChild = useCallback(() => {
    setSuppressComposerFocus(true);
    const next = { gammaEntryId: browserEntry.gammaEntryId, run: browserEntry.run };
    writeEntry(next, "replace");
    setBrowserChild(undefined);
  }, [browserEntry.gammaEntryId, browserEntry.run]);
  const childRoute = useChildRoute({
    client: state.phase === "connected" && state.authority === "controller" ? writeClient : client,
    authority: state.phase === "connected" ? state.authority : "controller",
    owner: attachedOwner,
    child: browserEntry.child,
    // Zeta offers each role only the methods it may call (zeta origin/main src/zeta/server/protocol.py:372-384): an observer
    // gets child_run_list from #1175 (protocol.py:357), an older zeta keeps it controller-only and refuses it with -32008.
    canList: (client?.features.includes(CHILD_RUNS_FEATURE) && commandRequests(client).has("child_run_list")) ?? false,
    canOpenHistory: client?.features.includes(CHILD_RUN_HISTORY_FEATURE) ?? false,
    onPushChild: pushChild,
    onBack: backFromChild,
    onReplaceParent: replaceChild,
  });
  const { controller: childController, snapshot: childSnapshot } = childRoute;
  const resendDelivery = useCallback((intent: string) => void deliveries.resend(browserEntry.run, intent), [deliveries, browserEntry.run]);

  return (
    <HighlightContext value={highlight}>
      <ApprovalModeContext value={yolo}>
        <RunProvider store={store} highlight={highlight} onRetry={writeClient && open ? () => writeClient.retrySession(open.id) : undefined}>
          <SubAgentNavigationProvider value={childRoute.navigation}>
          <DeliveryStates value={deliveryStates}>
          <RetryTurn value={retryTurn}>
            <ResendDelivery value={writeClient ? resendDelivery : null}>
            <div className="app">
              <TestRenderError area="app" />
              <header className="topbar">
                <span className="brand"><span className="brand-mark" aria-hidden="true" /><span className="brand-name">gamma</span></span>
                <RunTitle session={view.session} blank={!view.selected} opening={Boolean(view.opening)} />
                {state.phase === "connected" && state.authority === "observer" ? <span className="authority-badge"><span className="authority-mark" aria-hidden="true" />observing</span> : null}
                {childRoute.canList && attachedOwner ? <button ref={childRoute.childrenButtonRef} type="button" className="ghost children-button" onClick={(event) => childRoute.openCatalog(event.currentTarget)}>{childSnapshot.catalog.reportedAt === null ? "children" : `children ${childSnapshot.catalog.runs.length}${childSnapshot.catalog.nextOffset !== undefined ? "+" : ""}`}</button> : null}
                <YoloIndicator className="topbar-yolo" />
                {state.phase !== "connected" || state.authority === "controller" ? <button type="button" className="ghost new-run" aria-label="new run" onClick={() => void newRun()}><span className="new-run-label">new run</span><span className="new-run-short" aria-hidden="true">+</span></button> : null}
                <SettingsMenu>
                  <ThemePicker theme={theme} onChange={setTheme} />
                  <VimToggle on={vim} onChange={setVim} />
                </SettingsMenu>
              </header>
              <main ref={childRoute.parentRef} className="main" tabIndex={-1}>
                {landedNotice ? <div className="landed-notice" role="status">your message started run {landedNotice.runId} <button type="button" className="ghost" onClick={() => { runState.dismissNotice(); selectRun(landedNotice.runId); }}>open</button><button type="button" className="ghost" onClick={() => runState.dismissNotice()}>dismiss</button></div> : null}
                <RenderErrorBoundary className="run-render-failure" focusMode="transcript" title="run view broke" description="your draft is safe below. switch runs or reload gamma." resetKey={`${browserEntry.run}:${browserEntry.child ?? ""}`}>
                  {browserEntry.child ? childController && attachedOwner ? <ChildView key={`${attachedOwner}:${browserEntry.child}`} owner={attachedOwner} runId={browserEntry.child} controller={childController} snapshot={childSnapshot} historyAvailable={client?.features.includes(CHILD_RUN_HISTORY_FEATURE) ?? null} canList={childRoute.canList} canSend={childRoute.canSend} onBack={childRoute.closeChild} /> : <section className="child-view" aria-label="child run"><button type="button" className="ghost child-back" onClick={childRoute.closeChild}>back to parent run</button><p className="note" data-tone="busy" role="status">connecting to the parent run…</p></section> : <Body state={state} view={view} connection={connection} writes={writes} runs={runs} onNewRun={newRun} onSelectRun={selectRun} followRequest={followRequest} />}
                </RenderErrorBoundary>
                {!browserEntry.child ? <Dock key={browserEntry.run} autoFocus={!suppressComposerFocus} runId={browserEntry.run} runState={runState} onCreated={onCreated} onAccepted={() => setFollowRequest((request) => request + 1)} deliveries={deliveries} receipts={receipts} state={state} view={view} connection={connection} writes={writes} runs={runs} vim={vim} setVim={setVim} theme={theme} setTheme={setTheme} onNewRun={newRun} onRetryTurn={setRetryTurn} onImageOpen={openViewer} /> : null}
                {childRoute.catalogOpen && childController && attachedOwner ? <ChildCatalog owner={attachedOwner} controller={childController} snapshot={childSnapshot.catalog} onOpen={childRoute.openChild} onClose={childRoute.closeCatalog} /> : null}
                {viewer ? <Inspector value={viewer} onClose={closeViewer} /> : null}
              </main>
            </div>
            </ResendDelivery>
          </RetryTurn>
          </DeliveryStates>
          </SubAgentNavigationProvider>
        </RunProvider>
      </ApprovalModeContext>
    </HighlightContext>
  );
}

function childStatus(row: ChildRunRow) {
  return row.status.value;
}
function childAgentType(row: ChildRunRow) {
  return row.agentType && row.agentType !== row.description ? row.agentType : null;
}
function elapsed(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds < 3600 ? `${minutes}m ${Math.round(seconds % 60)}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function ChildCatalog({ owner, controller, snapshot, onOpen, onClose }: { owner: string; controller: ChildRunsController; snapshot: ChildRunsController["snapshot"]["catalog"]; onOpen(runId: string): void; onClose(): void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); }, []);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab") return;
    const targets = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [href], textarea, [tabindex]:not([tabindex="-1"])')];
    if (!targets.length) return;
    const first = targets[0]!;
    const last = targets.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="child-catalog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="child-catalog" role="dialog" aria-modal="true" aria-labelledby="child-catalog-title" aria-busy={snapshot.loading} onKeyDown={onKeyDown}>
      <header><div><h2 id="child-catalog-title">children</h2>{snapshot.reportedAt ? <p>last reported <time dateTime={new Date(snapshot.reportedAt).toISOString()}>{new Date(snapshot.reportedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></p> : null}</div><button ref={close} type="button" className="ghost child-close" onClick={onClose} aria-label="close children">close</button></header>
      <div className="child-catalog-actions"><button type="button" className="ghost" disabled={snapshot.loading} onClick={() => void controller.load(owner, "refresh")}>refresh</button></div>
      {snapshot.warning ? <p className="child-warning" role="alert">{snapshot.warning}</p> : null}
      {snapshot.loading && snapshot.reportedAt === null ? <p role="status">loading children…</p> : null}
      {!snapshot.loading && snapshot.reportedAt !== null && snapshot.runs.length === 0 ? <p>no children reported</p> : null}
      <ol className="child-list">{snapshot.runs.map((row) => <li key={`${row.sessionId}:${row.runId}`}>
        <button type="button" className="child-row" onClick={() => onOpen(row.runId)}>
          <span className="child-row-heading"><strong>{row.description || row.runId}</strong><span className="status-mark" data-state={childStatus(row)} aria-hidden="true" /><span>{childStatus(row)}</span></span>
          <span>{childAgentType(row) ? `${childAgentType(row)}${row.currentStep ? " · " : ""}` : ""}{row.currentStep || (!row.description ? "agent" : "")}</span>
          <span className="child-row-metrics">{elapsed(row.elapsedSeconds)} · {row.turnsUsed} {row.turnsUsed === 1 ? "turn" : "turns"} · {row.toolCount} {row.toolCount === 1 ? "tool" : "tools"}</span>
        </button>
      </li>)}</ol>
      {snapshot.nextOffset !== undefined ? <button type="button" className="ghost load-more" disabled={snapshot.loading} onClick={() => void controller.load(owner, "more")}>load more</button> : null}
    </aside>
  </div>;
}

function ChildView({ owner, runId, controller, snapshot, historyAvailable, canList, canSend, onBack }: { owner: string; runId: string; controller: ChildRunsController; snapshot: ChildRunsController["snapshot"]; historyAvailable: boolean | null; canList: boolean; canSend: boolean; onBack(): void }) {
  const key = useMemo<ChildKey>(() => ({ sessionId: owner, runId }), [owner, runId]);
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef(false);
  const row = snapshot.catalog.runs.find((candidate) => candidate.sessionId === owner && candidate.runId === runId);
  const [notice, setNotice] = useState<{ text: string; tone?: "danger" } | null>(null);
  const draft = controller.draft(key);
  const sending = controller.sending(key);
  const send = useCallback(async () => {
    const text = controller.draft(key);
    if (!text.trim() || sending) return;
    setNotice(null);
    try {
      const result = await controller.send(key, text);
      setNotice(result.kind === "accepted" ? null : { text: "delivery is unknown; your draft is kept", tone: "danger" });
    } catch (error) {
      setNotice({ text: `${error instanceof Error ? error.message : String(error)}; your draft is kept`, tone: "danger" });
    }
  }, [controller, key, sending]);
  const retry = useCallback(() => { controller.closeHistory(); void controller.open(key).catch(() => undefined); }, [controller, key]);
  const historyError = snapshot.historyError;
  const errorKind = historyError instanceof ChildRunHistoryError ? historyError.kind : null;
  const errorCopy = historyAvailable === false ? "transcript view needs a newer zeta server" : errorKind === "not_found" ? "this child transcript was not found" : errorKind === "owner_not_active" ? "the parent run is not active" : errorKind === "corrupt_transcript" ? "this child transcript is corrupt" : errorKind === "history_kept_changing" ? "history kept changing" : errorKind === "not_negotiated" ? "transcript view needs a newer zeta server" : historyError ? "could not load the saved transcript" : null;
  const missing = !row && snapshot.catalog.reportedAt !== null;
  useEffect(() => {
    if (!focused.current && (row || snapshot.history || errorCopy || historyAvailable === false)) {
      focused.current = true;
      heading.current?.focus();
    }
  }, [errorCopy, historyAvailable, row, snapshot.history]);
  return <section className="child-view" aria-label="child run" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onBack(); } }}>
    <header className="child-header">
      <button type="button" className="ghost child-back" onClick={onBack}>back to parent run</button>
      <h2 ref={heading} tabIndex={-1} className="child-identity"><span className="child-owner">{owner}</span><span aria-hidden="true">/</span><strong>{row?.description || runId}</strong>{row && childAgentType(row) ? <span>{childAgentType(row)}</span> : null}</h2>
      <span className="saved-label">{historyAvailable === false ? "child details" : "saved transcript"}</span>
      {row ? <div className="child-meta"><span className="status-mark" data-state={childStatus(row)} aria-hidden="true" /><span>{childStatus(row)}</span>{row.currentStep ? <span>{row.currentStep}</span> : null}<span>{elapsed(row.elapsedSeconds)}</span><span>{row.turnsUsed} {row.turnsUsed === 1 ? "turn" : "turns"}</span><span>{row.toolCount} {row.toolCount === 1 ? "tool" : "tools"}</span></div> : null}
    </header>
    {missing ? <div className="child-route-note"><p>{snapshot.catalog.nextOffset !== undefined ? "this child is not in the latest report" : "this child is no longer listed"}</p><div className="actions">{snapshot.catalog.nextOffset !== undefined ? <button type="button" className="ghost" onClick={() => void controller.load(owner, "more")}>load more</button> : null}<button type="button" className="ghost" onClick={() => void controller.load(owner, "refresh")}>refresh</button><button type="button" className="ghost" onClick={onBack}>back</button></div></div> : null}
    {snapshot.historyLoading ? <p className="note" data-tone="busy" role="status">loading saved transcript…</p> : null}
    {historyAvailable === false ? <p className="note child-history-note" role="status">{canSend ? "this zeta version cannot show the child transcript yet; details and follow-up still work" : "this zeta version cannot show the child transcript yet"}</p> : null}
    {!canSend ? <p className="note" role="status">read-only: follow-ups are available from the controller connection</p> : null}
    {!canSend && !canList ? <p className="note" role="status">this zeta connection cannot list child details</p> : null}
    {errorCopy && historyAvailable !== false ? <div className="note" data-tone="danger" role="alert"><span>{errorCopy}</span> <button type="button" className="ghost" onClick={retry}>try again</button> <button type="button" className="ghost" onClick={onBack}>back</button></div> : null}
    {snapshot.history ? <RenderErrorBoundary className="run-render-failure" focusMode="transcript" title="child transcript broke" description="your draft is safe below. switch children or reload gamma." resetKey={`${owner}:${runId}`}><TestRenderError area="transcript" /><RunProvider store={snapshot.history.result.lease.store} highlight={highlight}><ChildTimeline /></RunProvider></RenderErrorBoundary> : null}
    {canSend && row?.acceptsFollowUps ? <div className="child-followup">
      {notice ? <p role={notice.tone ? "alert" : "status"} data-tone={notice.tone}>{notice.text}</p> : null}
      <label htmlFor="child-followup">follow up with this child</label>
      <div><textarea id="child-followup" aria-label="child follow-up" value={draft} onChange={(event) => controller.setDraft(key, event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><button type="button" className="child-send" disabled={!draft.trim()} onClick={() => void send()}>{sending ? "sending…" : "send"}</button></div>
    </div> : canSend && row ? <p className="child-ineligible">this child is not accepting follow-ups</p> : null}
  </section>;
}

function ChildTimeline() {
  const scroll = useRef<HTMLDivElement>(null);
  const [jumpLane, setJumpLane] = useState<HTMLDivElement | null>(null);
  return <div className="run child-transcript"><div className="scroll" ref={scroll}><Timeline renderers={renderers} virtual scrollRef={scroll} renderJumpToLatest={(control) => jumpLane ? createPortal(control, jumpLane) : null} aria-label="saved child activity" /></div><div className="jump-lane" ref={setJumpLane} /></div>;
}

/** The first prompt of a run zeta has not titled yet. */
function useFirstPrompt() {
  const store = useRunStore();
  return useRun(useCallback((state: ReturnType<typeof store.getState>) => {
    const first = state.outline.find((item) => item.kind === "user");
    const item = first && store.getItem(first.id);
    return item?.type === "user" && item.event.type === "user_message" ? item.event.text.trim().split("\n")[0] || null : null;
  }, [store]));
}

function RunTitle({ session, blank, opening }: { session: SessionMeta | null; blank: boolean; opening: boolean }) {
  const prompt = useFirstPrompt();
  const title = sessionTitle(session) ?? prompt;
  useEffect(() => { document.title = title ? `${title} · gamma` : "gamma"; }, [title]);
  return (
    <div className="run-title">
      <h1 title={title ?? undefined}>{title ?? (blank ? "untitled run" : opening ? "opening…" : "run")}</h1>
    </div>
  );
}

type RunPhase =
  | { kind: "ready" | "thinking" | "reconnecting" | "connecting" | "opening" | "approval" }
  | { kind: "running"; tool: string };

/** What the run is doing now, from the store: a pending approval wins over a running tool, which wins over thinking. */
function useAgentPhase(): { kind: "idle" | "thinking" | "approval" } | { kind: "running"; tool: string } | { kind: "failed"; message: string } {
  const store = useRunStore();
  const phase = useRun(useCallback((state: ReturnType<typeof store.getState>) => {
    if (state.agent !== "running") {
      const last = state.outline.at(-1);
      const item = last && store.getItem(last.id);
      return item?.type === "error" && item.event.type === "error" && item.event.error.code !== "aborted" ? `failed:${item.event.error.message}` : "idle";
    }
    if (Object.values(state.toolApprovals).some((id) => { const item = store.getItem(id); return item?.type === "approval" && !item.ended; })) return "approval";
    const tool = Object.keys(state.activeToolIds).at(-1);
    const item = tool ? store.getItem(`tool:${tool}`) : undefined;
    return item?.type === "tool" ? `running:${item.tool_call.name}` : "thinking";
  }, [store]));
  if (phase.startsWith("failed:")) return { kind: "failed", message: phase.slice(7) };
  if (phase.startsWith("running:")) return { kind: "running", tool: phase.slice(8) };
  return { kind: phase as "idle" | "thinking" | "approval" };
}

/** Moves focus to the pending approval's first decision, scrolling the run to it first. */
function focusApproval() {
  const scroll = document.querySelector<HTMLElement>(".scroll");
  const find = () => scroll?.querySelector<HTMLElement>('[data-part="approval"][data-state="pending"]');
  const target = find();
  if (!target && scroll) scroll.scrollTop = scroll.scrollHeight;
  requestAnimationFrame(() => {
    const row = find();
    row?.scrollIntoView({ block: "center" });
    const decision = row?.querySelector<HTMLButtonElement>('button[data-action="approve"]:not(:disabled)') ?? row?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    decision?.focus({ preventScroll: true });
  });
}

/**
 * One line over the composer: what the run is doing now. It never carries a problem. Each problem has one home with
 * one action: connection and run-open problems in the main panel, a failed turn on its transcript row, a failed send,
 * steer, or stop in the composer note. While a problem panel shows, the status line is absent.
 */
function StatusLine({ phase, observer }: { phase: RunPhase; observer: boolean }) {
  const idle = observer && phase.kind === "ready";
  const tone = phase.kind === "approval" ? "warn" : idle ? "neutral" : phase.kind === "ready" ? "ok" : "busy";
  const text = idle ? "idle" : { ready: "ready", thinking: "working…", connecting: "connecting…", reconnecting: "reconnecting…", opening: "opening the run…", approval: "", running: "" }[phase.kind];
  return (
    <div className="status-line" data-state={idle ? "idle" : phase.kind} data-tone={tone} role="status">
      {phase.kind === "approval" && observer ? (
        <span className="status-text">waiting for the controller to approve</span>
      ) : phase.kind === "approval" ? (
        <button type="button" className="status-link" onClick={focusApproval}>waiting for your approval</button>
      ) : (
        <span className="status-text">{phase.kind === "running" ? `running ${phase.tool}` : text}</span>
      )}
    </div>
  );
}

function focusComposer() {
  document.querySelector<HTMLTextAreaElement>('.dock textarea[aria-label="message"]')?.focus();
}

function CommandReceiptLine({ store, runId }: { store: ReceiptStore; runId: string }) {
  const receipt = useSyncExternalStore(store.subscribe, () => store.get(runId));
  const text = useRef<HTMLSpanElement>(null);
  useEffect(() => { if (receipt) text.current?.scrollTo(0, 0); }, [receipt]);
  if (!receipt) return null;
  const dismiss = () => { store.dismiss(runId); focusComposer(); };
  return <div className="command-receipt" data-tone={receipt.tone} onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); dismiss(); } }}><span className="command-receipt-body">{receipt.tone === "error" ? <span className="command-receipt-label">error</span> : null}<span ref={text} className="command-receipt-text" role={receipt.tone === "error" ? "alert" : "status"} aria-label={receipt.tone === "error" ? "command error" : "command result"} tabIndex={0}>{receipt.text}</span></span>{receipt.action ? <button type="button" className="ghost receipt-action" onClick={receipt.action.run}>{receipt.action.label}</button> : null}<button type="button" className="ghost" aria-label="dismiss command result" onClick={dismiss}>dismiss</button></div>;
}

async function submitRun({ text, images, steer, deliveryId, connection, runs, deliveries, choice, yolo, runId, onCreated }: { text: string; images: readonly import("./image-queue").QueuedImage[]; steer: boolean; deliveryId: string; connection: Connection; runs: SessionManager; deliveries: DeliveryManager; choice: { model?: string; provider?: string }; yolo: boolean; runId: string; onCreated(from: string, sessionId: string): void }) {
  const target = connection.client;
  if (!target) throw new Error("not connected to zeta serve");
  let id = runId.startsWith("draft:") ? null : runId;
  if (!id) {
    try { id = await runs.create(runId, choice.model && target.features.includes("new_session_settings") ? { ...choice, approval_mode: yolo ? "allow" : "ask" } : choice); }
    catch (cause) {
      if ((cause as { code?: unknown }).code === -32004) throw new Error("another run has the active zeta turn; wait for it to finish, then send again");
      throw cause;
    }
    onCreated(runId, id);
    if (!choice.model || !target.features.includes("new_session_settings")) await deliveries.changeSettings(id, { ...(choice.model ? { model: choice.model } : {}), approval_mode: yolo ? "allow" : "ask" });
  }
  if (!images.length) return await deliveries.submit(id, text, steer, deliveryId);
  return await runs.sendImages(id, deliveryId, text, images);
}

function dockPhase(state: ConnectionState, opening: boolean, open: OpenRun | null, agent: ReturnType<typeof useAgentPhase>, starting: boolean): RunPhase {
  if (state.phase === "connecting" || state.phase === "dropped") return { kind: state.phase === "connecting" && !state.lost ? "connecting" : "reconnecting" };
  if ((opening || open?.stale) && !starting) return { kind: open?.stale ? "reconnecting" : "opening" };
  if (agent.kind === "approval") return { kind: "approval" };
  if (agent.kind === "running") return { kind: "running", tool: agent.tool };
  if (agent.kind === "thinking") return { kind: "thinking" };
  return { kind: "ready" };
}

function DockComposer({ autoFocus, readOnly, blockedReason, blockedStatic, settingsReason, running, vim, commands, onSubmit, onPreparationFailure, onStop, onImageOpen, onFileInput, client, deliveries, sessionId, runState, runId, createdWithDefault, planMode, grants, permissionsOpenRequest }: { autoFocus: boolean; readOnly: string | null; blockedReason: string | null; blockedStatic: boolean; settingsReason?: string; running: boolean; vim: boolean; commands: ReturnType<typeof createUnavailableCommandController>; onSubmit: Submit; onPreparationFailure(error: unknown, images: readonly import("./image-queue").QueuedImage[], text: string): void; onStop(): Promise<unknown>; onImageOpen(block: any): void; onFileInput(input: HTMLInputElement | null): void; client: ZetaClient | null; deliveries: DeliveryManager; sessionId: string | null; runState: RunStateStore; runId: string; createdWithDefault: boolean; planMode: boolean; grants: SessionGrantsModel | null; permissionsOpenRequest: number }) {
  const permissions = grants ? <PermissionsControl model={grants} openRequest={permissionsOpenRequest} /> : null;
  if (readOnly !== null) return <><TestRenderError area="composer" /><GammaComposer state="read-only" reason={readOnly} vim={vim} commands={commands} onSubmit={onSubmit} onPreparationFailure={onPreparationFailure} onImageOpen={onImageOpen} onFileInput={onFileInput} store={runState} runId={runId} footer={permissions} /></>;
  return <><TestRenderError area="composer" /><GammaComposer state={running ? "steerable" : "idle"} blockedReason={blockedReason ?? undefined} blockedStatic={blockedStatic} vim={vim} commands={commands} autoFocus={autoFocus} onSubmit={onSubmit} onPreparationFailure={onPreparationFailure} onStop={running ? onStop : undefined} onImageOpen={onImageOpen} onFileInput={onFileInput} store={runState} runId={runId} footer={<>{planMode ? <span className="plan-chip" aria-label="plan mode: on">plan</span> : null}<RunSettings available={Boolean(client)} disabledReason={settingsReason} deliveries={deliveries} sessionId={sessionId} createdWithDefault={createdWithDefault} running={running} store={runState} runId={runId} />{permissions}</>} /></>;
}


/**
 * Retry for a failed turn. Zeta echoes an opaque command's typed line (`/review x`) as the user message, so a slash-led
 * prompt goes back into the draft for the preparation seam instead of reaching `send {text}`.
 */
function runChoice(model: ReturnType<RunStateStore["get"]>["model"], local: { model?: string; provider?: string }) {
  const preferred = model.choice === "explicit" ? model.model : undefined;
  return preferred ? { model: preferred, ...(local.model === preferred && local.provider ? { provider: local.provider } : {}) } : {};
}

function useDockRetry(agent: ReturnType<typeof useAgentPhase>, client: ZetaClient | null, deliveries: DeliveryManager, runState: RunStateStore, runId: string, lastPrompt: string | null, onRetryTurn: Dispatch<SetStateAction<RetryAction | null>>) {
  const failed = agent.kind === "failed" && client && lastPrompt ? lastPrompt : null;
  useEffect(() => {
    const retry: RetryAction | null = failed && isSlashCommandText(failed)
      ? { run: () => { runState.restoreDraft(runId, runState.get(runId).lastDeliveryMethod === "send" ? `/${failed}` : failed); focusComposer(); }, label: "edit and retry" }
      : failed ? { run: () => void deliveries.submit(runId, failed, false).catch(() => {}), label: "retry" } : null;
    onRetryTurn(retry);
    return () => onRetryTurn(null);
  }, [failed, deliveries, runState, runId, onRetryTurn]);
}

const NEEDS_OPEN_RUN = "this command needs an open run: send a message first";

function dockReadOnlyReason(displayed: string | null, active: string | null) {
  return active && displayed !== active ? "this run is read-only while another run has the active zeta turn; stop it or wait" : null;
}

/** Connection facts stay with the app; run facts come from the reducer's runInput. */
function connectionBlockedReason(state: ConnectionState) {
  if (state.phase === "not_running") return "sending is paused until zeta serve runs again";
  if (state.phase !== "connected") return "sending is paused until zeta reconnects";
  return null;
}

function Dock({ autoFocus, state, view, connection, writes, runs, vim, setVim, theme, setTheme, onNewRun, onRetryTurn, onImageOpen, runState, runId, onCreated, onAccepted, deliveries, receipts }: {
  autoFocus: boolean; state: ConnectionState; view: RunState; connection: Connection; writes: WriteClient; runs: SessionManager; vim: boolean; setVim(value: boolean): void; theme: ThemeChoice; setTheme(value: ThemeChoice): void; onNewRun(): void; onRetryTurn: Dispatch<SetStateAction<RetryAction | null>>; onImageOpen(block: any): void; runState: RunStateStore; runId: string; onCreated(from: string, sessionId: string): void; onAccepted(): void; deliveries: DeliveryManager; receipts: ReceiptStore;
}) {
  const present = view;
  const open = present.open;
  const approvalStore = useRunStore();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const blank = !present.selected;
  const client = state.phase === "connected" ? connection.client : null;
  const writeClient = state.phase === "connected" && state.authority === "controller" ? writes.get() : null;
  const agent = useAgentPhase();
  const agentRunning = agent.kind === "thinking" || agent.kind === "approval" || agent.kind === "running";
  const running = state.phase === "connected" && agentRunning && open?.id === view.active;
  const yolo = useContext(ApprovalModeContext);
  useEffect(() => { deliveries.bind(runId, open?.lease.store); }, [deliveries, runId, open?.lease.store]);
  const record = useSyncExternalStore(runState.subscribe, () => runState.get(runId));
  const starting = record.lifecycle.kind === "creating";
  const input = runInput(runState.getCatalog(), runId as RunId);
  const sessionId = blank || starting || view.attached !== open?.id ? null : open.id;
  const observer = state.phase === "connected" && state.authority === "observer";
  const grants = useMemo(() => writeClient && sessionId && writeClient.features.includes(SESSION_GRANTS_FEATURE) ? createSessionGrantsModel(writeClient, sessionId) : null, [writeClient, sessionId]);
  const [permissionsOpenRequest, setPermissionsOpenRequest] = useState(0);
  useEffect(() => {
    if (!grants) return;
    void grants.load().catch(() => {});
    return () => grants.stop();
  }, [grants]);
  const requests = client ? commandRequests(client) : new Set<string>();
  const commands = useMemo(() => writeClient && sessionId
    ? createCommandController(sessionId, (method, params) => writeClient.request(method, params), { features: new Set(writeClient.features), requests: commandRequests(client!), turnActive: () => activeRun(runState.getCatalog()) === sessionId })
    : createUnavailableCommandController(observer ? "you are observing this run" : client ? NEEDS_OPEN_RUN : undefined, Boolean(client && !sessionId)), [client, observer, runState, sessionId, writeClient]);
  const approvalDisabledReason = observer ? "you are observing this run; decisions are off" : !client ? "reconnecting — decisions are disabled until the server confirms this run" : open?.stale ? "reconnecting — decisions are disabled until the server confirms this run" : present.openError ? "opening the run — decisions are paused" : undefined;

  const onSubmit: Submit = useCallback(async (action, images, { steer, deliveryId, sourceText }) => {
    writes.get();
    // Without an open run nothing was attempted, so the attachments wait for the message that opens one.
    const kept = sessionId ? "attachments are still attached and were not sent." : "attachments stay queued for your next message.";
    const setReceipt = (text: string, tone: "quiet" | "error", extra: Pick<import("./receipts").CommandReceipt, "action"> = {}) => receipts.set(runState.canonical(runId), { text: images.length ? `${text}\n${kept}` : text, tone, ...extra });
    const consume = () => runState.consumeDraft(runId, sourceText);
    const syncResult = async (command: string, text: string) => {
      if (sessionId && (command === "model" || command === "plan" || command === "implement")) await deliveries.loadSettings(sessionId).catch(() => {});
      if (command !== "vim" || !client) return text;
      try {
        const status = await client.request("status", {} as never) as { session?: { vim_mode?: unknown } };
        if (typeof status.session?.vim_mode === "boolean") { setVim(status.session.vim_mode); return text; }
      } catch {}
      return `${text}\ngamma composer vim unchanged; this server did not report vim mode`;
    };
    if (action.kind === "receipt") {
      const text = action.command ? await syncResult(action.command, action.text) : action.text;
      setReceipt(text, action.tone);
      if (!action.retain) consume();
      return;
    }
    if (action.kind === "client-action") {
      const local = { newRun: onNewRun, themes: themeChoices, currentTheme: () => theme, setTheme, openFilePicker: () => fileInput.current?.click() };
      // Resolve the action table first (zeta-backed for an open run, gamma's own otherwise), then index it.
      const actions: Partial<Record<ClientActionName, (args: string) => Promise<ActionReceipt | void>>> = writeClient && sessionId ? createClientActions({
        ...local, sessionId, requests, request: (method, params) => writeClient.request(method as never, params as never),
        refreshStatus: runs.refreshStatus, retrySession: (id) => writeClient.retrySession(id), currentName: () => sessionTitle(present.session) ?? undefined,
        approvalStore, approvalDisabledReason, decide: createApprovalDecider(writeClient, open!.lease.store), markAlways: (toolId) => markAlwaysAllowed(sessionId, toolId),
        ...(grants ? { permissions: {
          get grants() { return grants.state.snapshot?.session_grants ?? []; },
          open: () => setPermissionsOpenRequest((request) => request + 1),
          revoke: (grant) => grants.revoke(grant),
          clear: () => grants.clear(),
        } } : {}),
      }) : createLocalActions(local);
      const run = actions[action.name];
      if (!run) { setReceipt(NEEDS_OPEN_RUN, "error"); return; }
      try {
        const result = await run(action.args);
        if (result) setReceipt(result.text, result.tone);
        if (!result?.retain) consume();
        // Refocus only if the action lost focus: a reader who already tabbed into the receipt keeps their place.
        if (action.name !== "new_session" && action.name !== "paste" && action.name !== "permissions") requestAnimationFrame(() => { if (!document.activeElement || document.activeElement === document.body) focusComposer(); });
      } catch (error) { setReceipt(error instanceof Error ? error.message : String(error), "error"); }
      return;
    }
    if (action.kind === "send-input") {
      const id = runState.canonical(runId);
      if (action.command === "plan" || action.command === "implement") await deliveries.loadSettings(id).catch(() => {});
      if (activeRun(runState.getCatalog()) === id) {
        setReceipt("this command sends a message; it waits until the turn ends", "error");
        return;
      }
      const result = await deliveries.submitOpaque(id, action.inputId, action.displayText, sourceText, deliveryId);
      if (images.length) receipts.set(id, { text: "attachments are still attached and were not sent.", tone: "quiet" });
      onAccepted();
      return result;
    }
    if (!images.length && action.text !== sourceText) {
      const current = runState.get(runId).text;
      if (current.startsWith(sourceText)) runState.edit(runId, { text: action.text + current.slice(sourceText.length) });
    }
    const local = nextRunModel();
    const choice = runChoice(record.model, local);
    try {
      const result = await submitRun({ text: action.text, images, steer, deliveryId, connection, runs, deliveries, choice, yolo, runId, onCreated });
      onAccepted();
      return result;
    } catch (error) {
      // A send whose draft kept its delivery id is a wait (the composer's delivery note), not a second error banner.
      if (runState.get(runId).retryDelivery?.id !== deliveryId) setReceipt(error instanceof Error ? error.message : String(error), "error");
      throw error;
    }
  }, [approvalDisabledReason, approvalStore, client, connection, deliveries, grants, onAccepted, onCreated, onNewRun, present.session, receipts, record.model, requests, runId, runState, runs, sessionId, setTheme, setVim, theme, writeClient, writes, yolo]);
  const onStop = useCallback(async () => { await deliveries.stop(runId); await runs.refreshStatus(); }, [deliveries, runId, runs]);
  const lastPrompt = useLastPrompt();

  useDockRetry(agent, writeClient, deliveries, runState, runId, lastPrompt, onRetryTurn);

  const failure = present.openError;
  const problem = (state.phase !== "connected" && state.phase !== "connecting" && state.phase !== "dropped") || Boolean(failure);
  const phase = dockPhase(state, Boolean(present.opening) || input.block === "opening" || input.block === "syncing", open, agent, starting);
  // Both roles were refused: this tab can never send until a manual retry gets a slot, so nothing is editable.
  const readOnly = state.phase === "observer_limit" ? "this run has the most observers zeta allows; close another observer tab, then retry"
    : observer ? "another client controls this run; you are observing, sending is off" : blank ? null : dockReadOnlyReason(open?.id ?? null, view.active);
  const blockedReason = starting ? null : input.block === "pending" || input.block === "waits-for-active" ? inputBlockText(input.block, view.activeTitle) : connectionBlockedReason(state) ?? inputBlockText(input.block, view.activeTitle);
  const onPreparationFailure = useCallback((error: unknown, images: readonly import("./image-queue").QueuedImage[], text: string) => {
    const attachment = runState.getCatalog().attachment;
    const active = attachment.kind === "attached" && attachment.sessionId === runState.canonical(runId) && attachment.turn === "running";
    const busy = (error as { code?: unknown }).code === -32004;
    // A command refused by the running turn is a wait, not a failure: it names the command and keeps the draft.
    const waits = busy && active;
    const message = busy ? waits
      ? `${text.trimStart().split(/\s/, 1)[0]} waits until this turn ends; your draft is kept${pendingApprovals(approvalStore).length ? "\nuse the approve, always allow, or deny buttons on the approval card" : ""}`
      : "commands wait for pending work to finish: tools, approvals, or background agents"
      : error instanceof Error ? error.message : String(error);
    receipts.set(runState.canonical(runId), { text: images.length ? `${message}\nattachments are still attached and were not sent.` : message, tone: waits ? "quiet" : "error", ...(waits && pendingApprovals(approvalStore).length ? { action: { label: "jump to approval", run: focusApproval } } : {}) });
  }, [approvalStore, receipts, runId, runState]);
  // The opening panel already says what the run waits for; the composer note says what that means for sending.
  const panel = problem || (!open && Boolean(present.opening));
  return <div className="dock" data-authority={observer ? "observer" : undefined}><>{panel ? null : <StatusLine phase={phase} observer={observer} />}</><CommandReceiptLine store={receipts} runId={runId} /><DockComposer autoFocus={autoFocus} commands={commands} deliveries={deliveries} readOnly={readOnly} blockedReason={blockedReason} blockedStatic={input.block === "waits-for-active" || state.phase === "not_running"} settingsReason={settingsBlockText(input.settingsBlock)} running={running} vim={vim} onSubmit={onSubmit} onPreparationFailure={onPreparationFailure} onStop={onStop} onImageOpen={onImageOpen} onFileInput={(input) => { fileInput.current = input; }} client={writeClient} sessionId={sessionId} createdWithDefault={record.model.choice === "default"} planMode={record.settings.loaded?.plan_mode === true} runState={runState} runId={runId} grants={grants} permissionsOpenRequest={permissionsOpenRequest} /></div>;
}

/** The last prompt the user sent, so a failed turn can be retried with it. */
function useLastPrompt() {
  const store = useRunStore();
  return useRun(useCallback((state: ReturnType<typeof store.getState>) => {
    const last = [...state.outline].reverse().find((item) => item.kind === "user");
    const item = last && store.getItem(last.id);
    return item?.type === "user" && item.event.type === "user_message" ? item.event.text : null;
  }, [store]));
}

function OpenBody({ state, connection, writes, present, runs, followRequest }: { state: ConnectionState; connection: Connection; writes: WriteClient; present: RunState; runs: SessionManager; followRequest: number }) {
  const open = present.open!;
  const failed = present.openError;
  const offline = state.phase !== "connected";
  const writeClient = state.phase === "connected" && state.authority === "controller" ? writes.get() : null;
  return <><>{offline && (state.phase !== "connecting" || state.lastFailure) && state.phase !== "dropped" ? <ConnectionNotice state={state} connection={connection} compact /> : null}</><>{!open.history.complete ? <p className="note" data-tone="busy" role="status">loading history… {open.history.messages.toLocaleString("en")} loaded</p> : null}</><>{open.syncing ? <p className="note" data-tone="busy" role="status">live updates paused while this run is busy; it will catch up</p> : null}</><>{failed ? <div className="note" data-tone={failed.busy ? "busy" : "danger"} role="alert"><span>{failed.busy ? `this run waits while ${present.active ?? "another run"} has the active zeta turn` : `could not reopen this run: ${failed.message}`}</span> <button type="button" className="ghost" onClick={() => runs.dismissOpenError(failed.id)}>dismiss</button> <button type="button" className="ghost" onClick={() => runs.retryOpen(failed.id)}>try again</button></div> : null}</><Run client={offline ? null : writeClient} open={open} readOnly={Boolean(failed)} observer={state.phase === "connected" && state.authority === "observer"} followRequest={followRequest} /></>;
}
function Body({ state, view, connection, writes, runs, onNewRun, onSelectRun, followRequest }: { state: ConnectionState; view: RunState; connection: Connection; writes: WriteClient; runs: SessionManager; onNewRun(): void; onSelectRun(id: string): void; followRequest: number }) {
  const present = view;
  const offline = state.phase !== "connected";
  const observer = state.phase === "connected" && state.authority === "observer";
  const ownerActions = present.active ? <div className="actions"><button type="button" className="primary" onClick={() => onSelectRun(present.active!)}>go to running run</button>{observer ? null : <button type="button" className="ghost" onClick={() => { const client = writes.get(); if (client) void stopTurn(client); }}>stop running run</button>}</div> : null;
  if (present.open) return <OpenBody state={state} connection={connection} writes={writes} present={present} runs={runs} followRequest={followRequest} />;
  if (offline && (state.phase !== "connecting" || state.lastFailure) && state.phase !== "dropped") return <div className="scroll"><ConnectionNotice state={state} connection={connection} /></div>;
  if (present.opening) return <div className="scroll"><Panel title="opening the run" tone="busy"><p>{present.active ? `this run waits while ${present.active} has the active zeta turn` : !present.opening.loading ? "waiting for zeta to attach this run" : `loading history${present.opening.messages ? ` · ${present.opening.messages.toLocaleString("en")} messages` : ""}`}</p>{ownerActions}</Panel></div>;
  if (present.openError) { const failure = present.openError; return <div className="scroll"><Panel title={failure.busy ? "another run is active" : "could not open this run"} tone={failure.busy ? "warn" : "danger"}><p className="mono">{failure.busy ? `this run waits while ${present.active ?? "another run"} has the active zeta turn` : failure.message}</p>{failure.candidates?.length ? <div className="actions" aria-label="matching runs">{failure.candidates.map((candidate) => candidate.unique ? <a key={candidate.id} className="ghost" href={`?run=${encodeURIComponent(candidate.id)}`}>{candidate.id}</a> : <span key={candidate.id} className="candidate-guidance"><span className="mono">{candidate.id}</span> · type a longer id</span>)}</div> : null}{ownerActions}<div className="actions"><button type="button" className="primary" onClick={() => runs.retryOpen(failure.id)}>try again</button><button type="button" className="ghost" onClick={onNewRun}>new run</button></div></Panel></div>; }
  if (present.active) return <div className="scroll"><Panel title="new run waits for the running run" tone="warn"><p>you can type now. send becomes available when {present.activeTitle} finishes.</p>{ownerActions}</Panel></div>;
  return <div className="scroll"><div className="empty-run" role="note"><h2>start a conversation</h2><p>write below to start. zeta creates the run when you send the first message.</p></div></div>;
}

function Run({ client, open, readOnly, observer, followRequest }: { client: ZetaClient | null; open: OpenRun; readOnly: boolean; observer: boolean; followRequest: number }) {
  const scroll = useRef<HTMLDivElement>(null);
  const [jumpLane, setJumpLane] = useState<HTMLDivElement | null>(null);
  const artifacts = useArtifacts(open.id, open.lease.store);
  const [viewer, setViewer] = useState<any>(null);
  const viewerOpener = useRef<HTMLElement | null>(null);
  const openViewer = useCallback((block: any) => { viewerOpener.current = document.activeElement as HTMLElement | null; setViewer(block); }, []);
  const closeViewer = useCallback(() => { setViewer(null); requestAnimationFrame(() => viewerOpener.current?.focus()); }, []);
  const alwaysAllowed = useSyncExternalStore((listener) => subscribeAlwaysAllowed(open.id, listener), () => getAlwaysAllowed(open.id));
  const decisions = useMemo(() => {
    if (observer) return { observer: true as const };
    if (!client || open.stale || readOnly) return { disabledReason: readOnly ? "opening the run — decisions are paused" : "reconnecting — decisions are disabled until the server confirms this run" };
    const decide = createApprovalDecider(client, open.lease.store);
    return { approve: (requestId: string) => decide("approve", requestId), always: (requestId: string) => decide("approve", requestId, true), deny: (requestId: string) => decide("deny", requestId), alwaysAllowed, markAlways: (toolId: string) => markAlwaysAllowed(open.id, toolId) };
  }, [alwaysAllowed, client, observer, open.lease.store, open.stale, readOnly]);
  return (
    <Decisions.Provider value={decisions}>
      <TestRenderError area="transcript" />
      <ImageViewer.Provider value={openViewer}>
        <Artifacts.Provider value={artifacts}>
          <div ref={scroll} className="scroll" tabIndex={-1} data-stale={open.stale || undefined} data-run-ready={readOnly ? undefined : "true"}>
            <Timeline renderers={renderers} virtual scrollRef={scroll} renderJumpToLatest={(control) => jumpLane ? createPortal(control, jumpLane) : null} followRequest={followRequest} aria-label="run activity" />
            <ArtifactList anchor={null} />
            <EmptyRun />
          </div>
          <div ref={setJumpLane} className="jump-lane" aria-live="polite" />
        </Artifacts.Provider>
      </ImageViewer.Provider>
      {viewer ? <Inspector value={viewer} onClose={closeViewer} /> : null}
    </Decisions.Provider>
  );
}

function ConfirmDialog({ title, confirm, onConfirm, onCancel }: { title: string; confirm: string; onConfirm(): void; onCancel(): void }) {
  const destructive = useRef<HTMLButtonElement>(null);
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => { safe.current?.focus(); const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onCancel(); } if (event.key === "Tab" && event.shiftKey && document.activeElement === destructive.current) { event.preventDefault(); safe.current?.focus(); } else if (event.key === "Tab" && !event.shiftKey && document.activeElement === safe.current) { event.preventDefault(); destructive.current?.focus(); } }; addEventListener("keydown", key); return () => removeEventListener("keydown", key); }, [onCancel]);
  return <div className="confirm-backdrop"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-label={title}><h2>{title}</h2><p>the current turn will be stopped before the new run opens.</p><div className="actions"><button ref={destructive} type="button" className="confirm-danger" onClick={onConfirm}>{confirm}</button><button ref={safe} type="button" className="confirm-primary" onClick={onCancel}>cancel</button></div></div></div>;
}

function Inspector({ value, onClose }: { value: any; onClose(): void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const artifact = value.artifact as Artifact | undefined;
  const url = artifact ? artifactContentUrl(artifact) : value.src ?? value.url;
  const type = artifact?.media_type ?? value.mediaType ?? "image/*";
  const [text, setText] = useState<string | null>(null);
  const [htmlUrl, setHtmlUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!artifact || (!type.startsWith("text/") && type !== "application/json")) return;
    let live = true; void fetch(url).then((response) => response.text()).then((source) => {
      if (!live) return;
      if (type === "text/html") {
        const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'">`;
        setHtmlUrl(URL.createObjectURL(new Blob([csp, source], { type: "text/html" })));
      } else setText(source);
    });
    return () => { live = false; };
  }, [artifact, type, url]);
  useEffect(() => () => { if (htmlUrl) URL.revokeObjectURL(htmlUrl); }, [htmlUrl]);
  useEffect(() => {
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !dialog.current) return;
      const controls = [...dialog.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)')];
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  const rows = type === "text/csv" && text !== null ? text.split(/\r?\n/).slice(0, 200).filter(Boolean).map((line) => line.split(",").slice(0, 50)) : null;
  return <div className="inspector-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={dialog} className="inspector" role="dialog" aria-modal="true" aria-label="file inspector">
    <div className="inspector-bar"><strong>{artifact?.title ?? artifact?.filename ?? value.alt ?? "file"}</strong><a href={url} download={artifact?.filename ?? artifact?.title ?? "artifact"}>download</a><button type="button" onClick={onClose}>close</button></div>
    <div className="inspector-body">
      {type.startsWith("image/") ? <img src={url} alt={artifact?.title ?? value.alt ?? "image"} />
      : type === "application/pdf" ? <iframe title="pdf preview" sandbox="" src={url} />
      : type === "text/html" ? (htmlUrl ? <iframe title="html preview" data-viewer="html" sandbox="" src={htmlUrl} /> : <span>loading…</span>)
      : type === "text/markdown" && text !== null ? <RichMarkdown source={text} streaming={false} />
      : rows ? <table><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell.slice(0, 1000)}</td>)}</tr>)}</tbody></table>
      : text !== null ? <pre>{text.slice(0, 1_000_000)}</pre> : <span>loading…</span>}
    </div>
  </div></div>;
}

/** A run with no rows yet says what to do instead of showing a blank transcript. */
function EmptyRun() {
  const empty = useTimeline().length === 0;
  return empty ? (
    <div className="empty-run" role="note">
      <h2>no messages yet</h2>
      <p>write below to start the first turn.</p>
    </div>
  ) : null;
}

function Panel({ title, tone, children }: { title: string; tone?: string; children: ReactNode }) {
  return (
    <section className="panel" data-tone={tone} aria-labelledby="panel-title">
      <h2 id="panel-title">{title}</h2>
      {children}
    </section>
  );
}

function Copy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
  return (
    <div className="command">
      <code><Code text={value} language="shell" id="serve-command" /></code>
      <button type="button" className="ghost" onClick={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true))}>
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

function formatConnectionNotice(state: ConnectionState, command: string) {
  const lost = "lost" in state && state.lost;
  switch (state.phase) {
    case "connected": return null;
    case "connecting": return state.lastFailure
      ? { title: "zeta serve did not answer", tone: "danger", detail: "hello timed out; retrying now", body: <p>the server accepted the socket but did not finish hello within 15 seconds. check its terminal while gamma retries.</p> }
      : { title: lost ? "reconnecting to zeta serve" : "connecting to zeta serve", tone: "busy", detail: "looking for zeta serve", body: <p>looking for the server through this dev server's handoff.</p> };
    case "dropped": return { title: "connection lost", tone: "danger", detail: "the socket closed", body: <p>the socket to zeta serve closed. the run keeps going on the server; this page reconnects and rebuilds the session from its history.</p> };
    case "not_running": return { title: lost ? "connection lost: zeta serve stopped" : "zeta serve is not running", tone: "danger", detail: "start zeta serve", copy: true, body: <><p>start it with this page's origin in the allowlist. this page connects as soon as it is up.</p><Copy value={command} /></> };
    case "auth_failed": return { title: "auth failed", tone: "danger", detail: state.reason === "origin" ? "this page origin is not allowed" : "controller credential refused; restart zeta serve", copy: true, body: state.reason === "origin" ? <><p>zeta serve does not allow this page's origin <code>{location.origin}</code>. restart it with this origin:</p><Copy value={command} /></> : <><p>zeta serve refused this controller credential. restart zeta serve so the dev server can hand gamma the new credential:</p><Copy value={command} /></> };
    case "unresponsive": return { title: "zeta serve did not answer", tone: "danger", detail: "hello did not finish within 15 seconds", body: <p>the server accepted the socket but did not finish hello within 15 seconds. check its terminal, then retry.</p> };
    case "observer_limit": return { title: "observer limit reached", tone: "warn", detail: "zeta serve has no observer slot available", body: <p>close another observer, then retry.</p> };
    case "incompatible": return { title: "unsupported protocol version", tone: "danger", detail: "zeta serve does not speak protocol 1.2; update zeta", body: <><p>gamma requires zeta protocol 1.2, but the server rejected that version. update zeta, then reload this page to retry.</p><button type="button" className="ghost" onClick={() => location.reload()}>reload and retry</button></> };
  }
}

function ConnectionNotice({ state, connection, compact = false }: { state: ConnectionState; connection: Connection; compact?: boolean }) {
  const wait = useCountdown("retryAt" in state ? state.retryAt : null);
  const command = serveCommand(location.origin, connection.port);
  const retry = wait === null && state.phase !== "observer_limit" ? null : (
    <div className="actions">
      {wait !== null ? <span className="wait" aria-live="off">{wait > 0 ? `retrying in ${wait}s` : "retrying"}</span> : null}
      <button type="button" className="primary" onClick={() => connection.retryNow()}>retry now</button>
    </div>
  );
  const notice = formatConnectionNotice(state, command);
  if (!notice) return null;
  if (compact) {
    return (
      <div className="notice" data-tone={notice.tone} role="status">
        <strong>{notice.title}</strong>
        <span>{notice.detail}</span>
        <span className="wait">{wait === null ? "" : wait > 0 ? `retrying in ${wait}s` : "retrying"}</span>
        {wait !== null || state.phase === "observer_limit" ? <button type="button" className="ghost" onClick={() => connection.retryNow()}>retry now</button> : null}
        {notice.copy ? <Copy value={command} /> : null}
      </div>
    );
  }
  return (
    <Panel title={notice.title} tone={notice.tone}>
      {notice.body}
      {retry}
    </Panel>
  );
}
