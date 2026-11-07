import { createHighlighter } from "@fulcrum/highlight";
import { Markdown, type Fences, type MarkdownProps } from "@fulcrum/markdown/react";
import { MermaidFence } from "@fulcrum/mermaid";
import { Approval, Code, Fallback, FileBlock, HighlightContext, ImageBlock, Message, RunProvider, Timeline, ToolCall, useItemSelector, useRun, useRunStore, useTimeline, type Renderers } from "@fulcrum/react";
import { createRunStore } from "@fulcrum/core";
import type { ZetaClient } from "@fulcrum/zeta";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { createConnection, serveCommand, type Connection, type ConnectionState } from "./connection";
import { createDeliveryManager, stopTurn, type DeliveryManager } from "./delivery";
import { createRun, sessionTitle, type OpenRun, type RunControl, type RunState, type SessionMeta } from "./session";
import { ThemePicker, useTheme } from "./theme";
import { GammaComposer, type Submit } from "./composer";
import { nextRunModel, RunSettings, SettingsMenu, useVimSetting, VimToggle } from "./controls";
import { settingModel, settingsRequest } from "./settings";
import { createRunStateStore, type DraftRunId, type EntryId, type RunId, type RunStateStore } from "./run-state";
import { artifactContentUrl, hostBindings, useArtifacts } from "./host-client";
import type { Artifact } from "./host/types";

const highlight = createHighlighter();
addEventListener("pagehide", () => highlight.dispose(), { once: true });
const fences: Fences = { mermaid: MermaidFence };
const RichMarkdown = (props: MarkdownProps) => <Markdown {...props} highlight={highlight} fences={fences} />;

// Renderers stay module-level so appends never re-render every row; approvals reach the live client through context.
type Decide = (requestId: string) => Promise<unknown>;
const Decisions = createContext<{ approve?: Decide; deny?: Decide; disabledReason?: string } | null>(null);
function ZetaApproval({ id }: { id: string }) {
  const decide = useContext(Decisions);
  return <Approval id={id} onApprove={decide?.approve} onDeny={decide?.deny} disabledReason={decide?.disabledReason} />;
}
// The intents of steers a stop dropped: zeta never gave them to the agent, so their rows must not look delivered.
const Undelivered = createContext<ReadonlySet<string>>(new Set());
const WaitingDeliveries = createContext<ReadonlySet<string>>(new Set());
const ResendDelivery = createContext<((intent: string) => void) | null>(null);
function UserRow({ id }: { id: string }) {
  const intent = useItemSelector(id, (item) => (item?.type === "user" && item.event.type === "user_message" ? item.event.intent : undefined));
  const delivery = useItemSelector(id, (item) => (item?.type === "user" && item.event.type === "user_message" ? item.event.delivery_id : undefined));
  const undelivered = useContext(Undelivered);
  const waitingDeliveries = useContext(WaitingDeliveries);
  const resend = useContext(ResendDelivery);
  const identity = intent ?? delivery ?? (id.startsWith("user:intent:") ? id.slice("user:intent:".length) : id.startsWith("user:delivery:") ? id.slice("user:delivery:".length) : "");
  const lost = undelivered.has(identity);
  const waiting = waitingDeliveries.has(identity) && !lost;
  return (
    <>
      <Fallback id={id} />
      {waiting ? <p className="queued-delivery" role="status" aria-label="message queued">queued</p> : null}
      <p className="undelivered" data-empty={!lost || undefined} data-reserve={identity || undefined} data-user-id={id} role={lost ? "note" : undefined} aria-hidden={!lost || undefined}>{lost ? <>not delivered · the stop ended the turn before zeta took this steer {resend ? <button type="button" className="ghost" onClick={() => resend(identity)}>resend</button> : null}</> : "\u00a0"}</p>
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
  return <><ToolCall id={id} />{toolId ? <ArtifactList anchor={toolId} /> : null}</>;
}
const ApprovalModeContext = createContext<{ yolo: boolean; setYolo(value: boolean): void }>({ yolo: false, setYolo() {} });
function YoloIndicator({ className = "" }: { className?: string }) {
  const { yolo } = useContext(ApprovalModeContext);
  return yolo ? <strong className={`yolo-indicator ${className}`} title="tools run without asking">YOLO</strong> : null;
}
function ZetaMessage({ id }: { id: string }) {
  const onOpen = useContext(ImageViewer);
  return <Message id={id} markdown={RichMarkdown} onOpen={onOpen ?? undefined} />;
}
// A failed turn's one action: send its prompt again, offered on the error row while it is the last row.
const RetryTurn = createContext<(() => void) | null>(null);
function ErrorRow({ id }: { id: string }) {
  const retry = useContext(RetryTurn);
  const last = useRun(useCallback((state: { outline: readonly { id: string }[] }) => state.outline.at(-1)?.id === id, [id]));
  return (
    <div className="turn-error">
      <Fallback id={id} />
      {retry && last ? <button type="button" className="ghost turn-retry" onClick={retry}>retry</button> : null}
    </div>
  );
}
const renderers: Renderers = {
  message: ({ id }) => <ZetaMessage id={id} />,
  approval: ZetaApproval,
  user: UserRow,
  tool: ToolWithArtifacts,
  error: ErrorRow,
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
type BrowserEntry = { gammaEntryId: string; run: string };
const draftId = () => `draft:${crypto.randomUUID()}`;
const entryId = () => crypto.randomUUID();
const writeEntry = (entry: BrowserEntry, mode: "push" | "replace") => {
  const url = new URL(location.href);
  url.searchParams.set("run", entry.run);
  localStorage.setItem(RUN, entry.run);
  history[mode === "push" ? "pushState" : "replaceState"]({ ...history.state, ...entry }, "", url);
};
const initialEntry = (): BrowserEntry => {
  const state = history.state as Partial<BrowserEntry> | null;
  const run = new URLSearchParams(location.search).get("run") ?? localStorage.getItem(RUN) ?? draftId();
  const entry = { gammaEntryId: typeof state?.gammaEntryId === "string" ? state.gammaEntryId : entryId(), run };
  writeEntry(entry, "replace");
  return entry;
};

export function App() {
  const [theme, setTheme] = useTheme();
  const [vim, setVim] = useVimSetting();
  const connection = useMemo(() => createConnection({ origin: location.origin, initialPort: Number(import.meta.env.VITE_ZETA_PORT) || 8765 }), []);
  const firstEntry = useMemo(initialEntry, []);
  const runState = useMemo(() => createRunStateStore(8, localStorage, sessionStorage, { id: firstEntry.gammaEntryId as EntryId, run: firstEntry.run as RunId }), [firstEntry]);
  const selectedEntry = useSyncExternalStore(runState.subscribe, runState.getEntry);
  const browserEntry = { gammaEntryId: selectedEntry.id, run: selectedEntry.run };
  const selectedSession = firstEntry.run.startsWith("draft:") ? null : firstEntry.run;
  const runs = useMemo(() => createRun(connection, { selected: selectedSession, bindings: hostBindings }), [connection, selectedSession]);
  useEffect(() => {
    const activate = (id: string) => {
      const nextModel = nextRunModel().model;
      runState.activate(id, id.startsWith("draft:") ? nextModel ? { choice: "explicit", model: nextModel } : { choice: "default" } : { choice: "explicit", model: "" });
    };
    runState.dispatch({ type: "NAVIGATED", entryId: firstEntry.gammaEntryId as EntryId, runId: firstEntry.run as RunId });
    activate(firstEntry.run);
    const pop = (event: PopStateEvent) => {
      const raw = new URLSearchParams(location.search).get("run") ?? draftId();
      const canonical = runState.canonical(raw);
      const state = event.state as Partial<BrowserEntry> | null;
      const next = { gammaEntryId: typeof state?.gammaEntryId === "string" ? state.gammaEntryId : entryId(), run: canonical };
      if (canonical !== raw || !state?.gammaEntryId) writeEntry(next, "replace");
      runState.dispatch({ type: "NAVIGATED", entryId: next.gammaEntryId as EntryId, runId: canonical as RunId }); activate(canonical);
      if (canonical.startsWith("draft:")) runs.reset(); else runs.select(canonical);
    };
    addEventListener("popstate", pop);
    return () => { removeEventListener("popstate", pop); runState.dispose(); runs.dispose(); connection.stop(); };
  }, [connection, firstEntry.run, runState, runs]);
  const state = useExternal(connection);
  const view = useExternal(runs);
  const open = view.open;
  // A new run remounts the dock (a fresh draft and delivery state) over a fresh empty store.
  const [epoch, setEpoch] = useState(0);
  const blank = useMemo(() => createRunStore(), [epoch]);
  const store = open?.lease.store ?? blank;
  const selectedRecord = useSyncExternalStore(runState.subscribe, () => runState.get(browserEntry.run));
  const landedNotice = useSyncExternalStore(runState.subscribe, runState.getNotice);
  const yolo = selectedRecord.settings.kind === "ready" && selectedRecord.settings.approval_mode === "allow";
  const setYolo = useCallback((value: boolean) => runState.setApprovalMode(browserEntry.run, value ? "allow" : "ask"), [browserEntry.run, runState]);
  const [retryTurn, setRetryTurn] = useState<(() => void) | null>(null);
  const [viewer, setViewer] = useState<any>(null);
  const viewerOpener = useRef<HTMLElement | null>(null);
  const openViewer = useCallback((block: any) => { viewerOpener.current = document.activeElement as HTMLElement | null; setViewer(block); }, []);
  const closeViewer = useCallback(() => { setViewer(null); requestAnimationFrame(() => viewerOpener.current?.focus()); }, []);
  const deliveries = useMemo(() => createDeliveryManager(() => connection.client), [connection]);
  const deliveryVersion = useSyncExternalStore(deliveries.subscribe, () => { const marks = deliveries.marks(runState.canonical(browserEntry.run)); return `${marks.waiting.size}:${marks.undelivered.size}`; });
  void deliveryVersion;
  const deliveryMarks = deliveries.marks(runState.canonical(browserEntry.run));
  // Context values must change identity when the manager mutates its internal sets.
  const undelivered = new Set(deliveryMarks.undelivered);
  const waitingDeliveries = new Set(deliveryMarks.waiting);
  const previousActive = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousActive.current;
    if (view.active) previousActive.current = view.active;
    if (previous && !view.active && state.phase === "connected") { previousActive.current = null; void deliveries.turnEnded(previous); }
    if (state.phase === "connected" && view.attached) void deliveries.reconcile(view.attached);
  }, [deliveries, state.phase, view.active, view.attached]);
  useEffect(() => () => deliveries.dispose(), [deliveries]);
  const newRun = useCallback(() => {
    const next = { gammaEntryId: entryId(), run: draftId() };
    writeEntry(next, "push"); runState.dispatch({ type: "NEW_RUN", entryId: next.gammaEntryId as EntryId, runId: next.run as DraftRunId }); runState.activate(next.run, nextRunModel().model ? { choice: "explicit", model: nextRunModel().model! } : { choice: "default" });
    runs.reset(); setEpoch((value) => value + 1);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.dock textarea[aria-label="message"]')?.focus());
  }, [runState, runs]);
  const onCreated = useCallback((from: string, sessionId: string) => {
    const currentEntry = runState.getEntry();
    const current = { gammaEntryId: currentEntry.id, run: currentEntry.run };
    deliveries.promote(from, sessionId);
    runState.promote(from, sessionId);
    if (current.run !== from) return;
    const next = { ...current, run: sessionId };
    writeEntry(next, "replace");
  }, [deliveries, runState]);
  const selectRun = useCallback((id: string) => {
    const next = { gammaEntryId: entryId(), run: id };
    writeEntry(next, "push"); runState.dispatch({ type: "NAVIGATED", entryId: next.gammaEntryId as EntryId, runId: id as RunId }); runState.activate(id, { choice: "explicit", model: "" }); runs.select(id);
  }, [runState, runs]);
  const client = state.phase === "connected" ? connection.client : null;

  return (
    <HighlightContext value={highlight}>
      <ApprovalModeContext value={{ yolo, setYolo }}>
        <RunProvider store={store} highlight={highlight} onRetry={client && open ? () => client.retrySession(open.id) : undefined}>
          <Undelivered value={undelivered}>
          <RetryTurn value={retryTurn}>
            <WaitingDeliveries value={waitingDeliveries}>
            <ResendDelivery value={(intent) => void deliveries.resend(browserEntry.run, intent)}>
            <div className="app">
              <header className="topbar">
                <span className="brand"><span className="brand-mark" aria-hidden="true" /><span className="brand-name">gamma</span></span>
                <RunTitle session={view.session} blank={!view.selected} />
                <YoloIndicator className="topbar-yolo" />
                <button type="button" className="ghost new-run" aria-label="new run" onClick={() => void newRun()}><span className="new-run-label">new run</span><span className="new-run-short" aria-hidden="true">+</span></button>
                <SettingsMenu>
                  <ThemePicker theme={theme} onChange={setTheme} />
                  <VimToggle on={vim} onChange={setVim} />
                </SettingsMenu>
              </header>
              <main className="main">
                {landedNotice ? <div className="landed-notice" role="status">your message started run {landedNotice.runId} <button type="button" className="ghost" onClick={() => { runState.dismissNotice(); selectRun(landedNotice.runId); }}>open</button><button type="button" className="ghost" onClick={() => runState.dismissNotice()}>dismiss</button></div> : null}
                <Body state={state} view={view} connection={connection} runs={runs} onNewRun={newRun} onSelectRun={selectRun} />
                <Dock key={browserEntry.run} runId={browserEntry.run} runState={runState} onCreated={onCreated} deliveries={deliveries} pendingDelivery={waitingDeliveries.size > 0} state={state} view={view} connection={connection} runs={runs} vim={vim} onRetryTurn={setRetryTurn} onImageOpen={openViewer} />
                {viewer ? <Inspector value={viewer} onClose={closeViewer} /> : null}
              </main>
            </div>
            </ResendDelivery>
            </WaitingDeliveries>
          </RetryTurn>
          </Undelivered>
        </RunProvider>
      </ApprovalModeContext>
    </HighlightContext>
  );
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

function RunTitle({ session, blank }: { session: SessionMeta | null; blank: boolean }) {
  const prompt = useFirstPrompt();
  const title = sessionTitle(session) ?? prompt;
  useEffect(() => { document.title = title ? `${title} · gamma` : "gamma"; }, [title]);
  return (
    <div className="run-title">
      <h1 title={title ?? undefined}>{title ?? (blank ? "new run" : "run")}</h1>
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
export async function applyFirstTurnSettings(target: ZetaClient, sessionId: string, choice: { model?: string; provider?: string }, yolo: boolean) {
  const approval_mode = yolo ? "allow" : "ask";
  const current = settingModel(await target.request("session_settings", { session_id: sessionId }));
  await target.request("set_settings", { session_id: sessionId, ...settingsRequest(current, { approval_mode }) });
}

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
function StatusLine({ phase }: { phase: RunPhase }) {
  const tone = phase.kind === "approval" ? "warn" : phase.kind === "ready" ? "ok" : "busy";
  const text = { ready: "ready", thinking: "working…", connecting: "connecting…", reconnecting: "reconnecting…", opening: "opening the run…", approval: "", running: "" }[phase.kind];
  return (
    <div className="status-line" data-state={phase.kind} data-tone={tone} role="status">
      {phase.kind === "approval" ? (
        <button type="button" className="status-link" onClick={focusApproval}>waiting for your approval</button>
      ) : (
        <span className="status-text">{phase.kind === "running" ? `running ${phase.tool}` : text}</span>
      )}
    </div>
  );
}

async function submitRun({ text, images, steer, deliveryId, connection, runs, deliveries, yolo, runId, onCreated }: { text: string; images: readonly import("./image-queue").QueuedImage[]; steer: boolean; deliveryId: string; connection: Connection; runs: RunControl; deliveries: DeliveryManager; yolo: boolean; runId: string; onCreated(from: string, sessionId: string): void }) {
  const target = connection.client;
  if (!target) throw new Error("not connected to zeta serve");
  let id = runs.state.open?.id;
  const release = id ? null : runs.holdAttachment();
  try {
    if (!id) {
      const choice = nextRunModel();
      try { id = await runs.create(choice.model && target.features.includes("new_session_settings") ? { ...choice, approval_mode: yolo ? "allow" : "ask" } : choice); }
      catch (cause) {
        if ((cause as { code?: unknown }).code === -32004) throw new Error("another run has the active zeta turn; wait for it to finish, then send again");
        throw cause;
      }
      onCreated(runId, id);
      if (!choice.model || !target.features.includes("new_session_settings")) await applyFirstTurnSettings(target, id, choice, yolo);
    }
    if (!images.length) return await deliveries.submit(id, text, steer, deliveryId);
    return await runs.sendImages(id, deliveryId, text, images.map(({ name, mime_type, data }) => ({ name, mime_type, data })));
  } finally { release?.(); }
}

function dockPhase(state: ConnectionState, present: RunState, open: OpenRun | null, agent: ReturnType<typeof useAgentPhase>, starting: boolean): RunPhase {
  if (state.phase === "connecting" || state.phase === "dropped") return { kind: state.phase === "connecting" && !state.lost ? "connecting" : "reconnecting" };
  if ((present.opening || open?.stale) && !starting) return { kind: open?.stale ? "reconnecting" : "opening" };
  if (agent.kind === "approval") return { kind: "approval" };
  if (agent.kind === "running") return { kind: "running", tool: agent.tool };
  if (agent.kind === "thinking") return { kind: "thinking" };
  return { kind: "ready" };
}

function DockComposer({ readOnly, blockedReason, running, vim, onSubmit, onStop, onImageOpen, client, runs, sessionId, yolo, onYolo, runState, runId, createdWithDefault }: { readOnly: string | null; blockedReason: string | null; running: boolean; vim: boolean; onSubmit: Submit; onStop(): Promise<unknown>; onImageOpen(block: any): void; client: ZetaClient | null; runs: RunControl; sessionId: string | null; yolo: boolean; onYolo(value: boolean): void; runState: RunStateStore; runId: string; createdWithDefault: boolean }) {
  if (readOnly !== null) return <GammaComposer state="read-only" reason={readOnly} vim={vim} onSubmit={onSubmit} onImageOpen={onImageOpen} store={runState} runId={runId} />;
  return <GammaComposer state={running ? "steerable" : "idle"} blockedReason={blockedReason ?? undefined} vim={vim} autoFocus onSubmit={onSubmit} onStop={running ? onStop : undefined} onImageOpen={onImageOpen} store={runState} runId={runId} footer={<RunSettings available={Boolean(client)} runs={runs} sessionId={sessionId} createdWithDefault={createdWithDefault} running={running} yolo={yolo} onYolo={onYolo} store={runState} runId={runId} />} />;
}


function useDockRetry(agent: ReturnType<typeof useAgentPhase>, client: ZetaClient | null, deliveries: DeliveryManager, runId: string, lastPrompt: string | null, onRetryTurn: Dispatch<SetStateAction<(() => void) | null>>) {
  const failed = agent.kind === "failed" && client && lastPrompt ? lastPrompt : null;
  useEffect(() => {
    onRetryTurn(failed && client ? () => () => void deliveries.submit(runId, failed, false).catch(() => {}) : null);
    return () => onRetryTurn(null);
  }, [failed, client, deliveries, runId, onRetryTurn]);
}

function dockReadOnlyReason(displayed: string | null, active: string | null) {
  return active && displayed !== active ? "this run is read-only while another run has the active zeta turn; stop it or wait" : null;
}

function dockBlockedReason(state: ConnectionState, present: RunState, open: OpenRun | null) {
  if (state.phase === "not_running") return "sending is paused until zeta serve runs again";
  if (state.phase !== "connected") return "sending is paused until zeta reconnects";
  if (present.openError) return "sending is paused until the run opens";
  return present.opening || open?.stale ? "sending is paused until the run opens" : null;
}

function Dock({ state, view, connection, runs, vim, onRetryTurn, onImageOpen, runState, runId, onCreated, deliveries, pendingDelivery }: {
  state: ConnectionState; view: RunState; connection: Connection; runs: RunControl; vim: boolean; onRetryTurn: Dispatch<SetStateAction<(() => void) | null>>; onImageOpen(block: any): void; runState: RunStateStore; runId: string; onCreated(from: string, sessionId: string): void; deliveries: DeliveryManager; pendingDelivery: boolean;
}) {
  const present = view;
  const open = present.open;
  const blank = !present.selected;
  const client = state.phase === "connected" ? connection.client : null;
  const agent = useAgentPhase();
  const agentRunning = agent.kind === "thinking" || agent.kind === "approval" || agent.kind === "running";
  const running = agentRunning && open?.id === view.active;
  const { yolo, setYolo } = useContext(ApprovalModeContext);
  // This dock's own first send is starting the run: the composer stays put while zeta creates and opens it.
  const [starting, setStarting] = useState(false);
  useEffect(() => { deliveries.bind(runId, open?.lease.store); }, [deliveries, runId, open?.lease.store]);
  const record = useSyncExternalStore(runState.subscribe, () => runState.get(runId));

  const onSubmit: Submit = useCallback(async (text, images, { steer, deliveryId }) => {
    if (runId.startsWith("draft:")) runState.dispatch({ type: "FIRST_SEND", runId: runId as DraftRunId, operationId: crypto.randomUUID() as import("./run-state").OperationId });
    setStarting(true);
    try { return await submitRun({ text, images, steer, deliveryId, connection, runs, deliveries, yolo, runId, onCreated }); }
    finally { setStarting(false); }
  }, [connection, runs, deliveries, yolo, runId, onCreated]);
  const onStop = useCallback(async () => { await deliveries.stop(runId); await runs.refreshStatus(); }, [deliveries, runId, runs]);
  const lastPrompt = useLastPrompt();

  useDockRetry(agent, client, deliveries, runId, lastPrompt, onRetryTurn);

  const failure = present.openError;
  const problem = (state.phase !== "connected" && state.phase !== "connecting" && state.phase !== "dropped") || Boolean(failure);
  const phase = dockPhase(state, present, open, agent, starting);
  const readOnly = blank ? null : dockReadOnlyReason(open?.id ?? null, view.active);
  const blockedReason = starting ? null : pendingDelivery ? "sending waits while the previous message is pending or retrying" : view.active && blank ? `sending waits for the active run ${view.active}` : dockBlockedReason(state, present, open);
  const sessionId = blank || starting || view.attached !== open?.id ? null : open.id;
  return <div className="dock"><>{problem ? null : <StatusLine phase={phase} />}</><DockComposer runs={runs} readOnly={readOnly} blockedReason={blockedReason} running={running} vim={vim} onSubmit={onSubmit} onStop={onStop} onImageOpen={onImageOpen} client={client} sessionId={sessionId} createdWithDefault={record.model.choice === "default"} yolo={yolo} onYolo={setYolo} runState={runState} runId={runId} /></div>;
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

function OpenBody({ state, connection, present, runs }: { state: ConnectionState; connection: Connection; present: RunState; runs: RunControl }) {
  const open = present.open!;
  const failed = present.openError;
  const offline = state.phase !== "connected";
  return <><>{offline && (state.phase !== "connecting" || state.lastFailure) && state.phase !== "dropped" ? <ConnectionNotice state={state} connection={connection} compact /> : null}</><>{!open.history.complete ? <p className="note" data-tone="busy" role="status">loading earlier messages… {open.history.messages.toLocaleString("en")} loaded</p> : null}</><>{open.syncing ? <p className="note" data-tone="busy" role="status">live updates paused while this run is busy; it will catch up</p> : null}</><>{failed ? <div className="note" data-tone={failed.busy ? "busy" : "danger"} role="alert"><span>{failed.busy ? `this run waits while ${present.active ?? "another run"} has the active zeta turn` : `could not reopen this run: ${failed.message}`}</span> <button type="button" className="ghost" onClick={() => runs.dismissOpenError()}>dismiss</button> <button type="button" className="ghost" onClick={() => runs.select(failed.id)}>try again</button></div> : null}</><Run client={offline ? null : connection.client} open={open} readOnly={Boolean(failed)} /></>;
}
function Body({ state, view, connection, runs, onNewRun, onSelectRun }: { state: ConnectionState; view: RunState; connection: Connection; runs: RunControl; onNewRun(): void; onSelectRun(id: string): void }) {
  const present = view;
  const offline = state.phase !== "connected";
  const ownerActions = present.active ? <div className="actions"><button type="button" className="primary" onClick={() => onSelectRun(present.active!)}>go to running run</button><button type="button" className="ghost" onClick={() => connection.client && void stopTurn(connection.client)}>stop running run</button></div> : null;
  if (present.open) return <OpenBody state={state} connection={connection} present={present} runs={runs} />;
  if (offline && (state.phase !== "connecting" || state.lastFailure) && state.phase !== "dropped") return <div className="scroll"><ConnectionNotice state={state} connection={connection} /></div>;
  if (present.selected && !present.openError && view.session?.session_id !== present.selected) return <div className="scroll"><Panel title="opening the run" tone="busy"><p>{present.active ? `this run waits while ${present.active} has the active zeta turn` : `loading history${present.opening?.messages ? ` · ${present.opening.messages.toLocaleString("en")} messages` : ""}`}</p>{ownerActions}</Panel></div>;
  if (present.openError) { const failure = present.openError; return <div className="scroll"><Panel title={failure.busy ? "another run is active" : "could not open this run"} tone={failure.busy ? "warn" : "danger"}><p className="mono">{failure.busy ? `this run waits while ${present.active ?? "another run"} has the active zeta turn` : failure.message}</p>{ownerActions}<div className="actions"><button type="button" className="primary" onClick={() => runs.select(failure.id)}>try again</button><button type="button" className="ghost" onClick={onNewRun}>new run</button></div></Panel></div>; }
  if (present.active) return <div className="scroll"><Panel title="new run waits for the running run" tone="warn"><p>you can type now. send becomes available when {present.active} finishes.</p>{ownerActions}</Panel></div>;
  return <div className="scroll"><div className="empty-run" role="note"><h2>start a conversation</h2><p>write below to start. zeta creates the run when you send the first message.</p></div></div>;
}

function Run({ client, open, readOnly }: { client: ZetaClient | null; open: OpenRun; readOnly: boolean }) {
  const scroll = useRef<HTMLDivElement>(null);
  const artifacts = useArtifacts(open.id, open.lease.store);
  const [viewer, setViewer] = useState<any>(null);
  const viewerOpener = useRef<HTMLElement | null>(null);
  const openViewer = useCallback((block: any) => { viewerOpener.current = document.activeElement as HTMLElement | null; setViewer(block); }, []);
  const closeViewer = useCallback(() => { setViewer(null); requestAnimationFrame(() => viewerOpener.current?.focus()); }, []);
  const decisions = useMemo(() => {
    if (!client || open.stale || readOnly) return { disabledReason: readOnly ? "opening the run — decisions are paused" : "reconnecting — decisions are disabled until the server confirms this run" };
    const decide = (method: "approve" | "deny"): Decide => async (request_id) => {
      try {
        const result = await client.request(method, { request_id }, { timeoutMs: 15_000 });
        // The decision response is durable. End the reopened snapshot row even if its live approval_end was quarantined.
        open.lease.store.dispatch({ type: "approval_end", request_id, data: { decision: method === "approve" ? "allow" : "deny" } });
        return result;
      } catch (error) {
        if ((error as { code?: unknown }).code === -32006) throw new Error("this approval expired while you were disconnected");
        throw error;
      }
    };
    return { approve: decide("approve"), deny: decide("deny") };
  }, [client, open.stale, readOnly]);
  return (
    <Decisions.Provider value={decisions}>
      <ImageViewer.Provider value={openViewer}>
        <Artifacts.Provider value={artifacts}>
          <div ref={scroll} className="scroll" tabIndex={-1} data-stale={open.stale || undefined} data-run-ready={readOnly ? undefined : "true"}>
            <Timeline renderers={renderers} virtual scrollRef={scroll} aria-label="run activity" />
            <ArtifactList anchor={null} />
            <EmptyRun />
          </div>
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
    case "busy": return { title: "zeta serve is in use", tone: "warn", detail: "another client has the controller", body: <p>zeta serve accepts one client at a time. close the other client (another tab, the playground, or the zeta app) and this page takes over.</p> };
    case "incompatible": return { title: "unsupported protocol version", tone: "danger", detail: "zeta serve does not speak protocol 1.2; update zeta", body: <><p>gamma requires zeta protocol 1.2, but the server rejected that version. update zeta, then reload this page to retry.</p><button type="button" className="ghost" onClick={() => location.reload()}>reload and retry</button></> };
  }
}

function ConnectionNotice({ state, connection, compact = false }: { state: ConnectionState; connection: Connection; compact?: boolean }) {
  const wait = useCountdown("retryAt" in state ? state.retryAt : null);
  const command = serveCommand(location.origin, connection.port);
  const retry = wait === null ? null : (
    <div className="actions">
      <span className="wait" aria-live="off">{wait > 0 ? `retrying in ${wait}s` : "retrying"}</span>
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
        {wait !== null ? <button type="button" className="ghost" onClick={() => connection.retryNow()}>retry now</button> : null}
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
