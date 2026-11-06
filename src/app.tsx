import { createHighlighter } from "@fulcrum/highlight";
import { Markdown, type Fences, type MarkdownProps } from "@fulcrum/markdown/react";
import { MermaidFence } from "@fulcrum/mermaid";
import { Approval, Code, Fallback, FileBlock, HighlightContext, ImageBlock, Message, RunProvider, Timeline, ToolCall, useItemSelector, useRun, useRunStore, useTimeline, type Renderers } from "@fulcrum/react";
import { createRunStore } from "@fulcrum/core";
import type { ZetaClient } from "@fulcrum/zeta";
import { forwardRef, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { createConnection, serveCommand, type Connection, type ConnectionState } from "./connection";
import { createDelivery, stopTurn } from "./delivery";
import { createRun, sessionPresentation, sessionTitle, transitionRun, type OpenRun, type RunControl, type RunState, type SessionMeta } from "./session";
import { ThemePicker, useTheme } from "./theme";
import { GammaComposer, type Submit } from "./composer";
import { nextRunModel, RunSettings, SettingsMenu, useVimSetting, VimToggle } from "./controls";
import { settingModel, settingsRequest } from "./settings";
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
function UserRow({ id }: { id: string }) {
  const intent = useItemSelector(id, (item) => (item?.type === "user" && item.event.type === "user_message" ? item.event.intent : undefined));
  const delivery = useItemSelector(id, (item) => (item?.type === "user" && item.event.type === "user_message" ? item.event.delivery_id : undefined));
  const undelivered = useContext(Undelivered);
  const lost = undelivered.has(intent ?? delivery ?? "");
  const waiting = intent !== undefined;
  return (
    <>
      <Fallback id={id} />
      {waiting ? <p className="undelivered" role="status" aria-label="message queued">queued</p> : null}
      {lost ? <p className="undelivered" role="note">not delivered · the stop ended the turn before zeta took this steer</p> : null}
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
/** The run to resume: `?run=` first (a shared link), else the one this browser had open. */
const initialRun = () => {
  const id = new URLSearchParams(location.search).get("run") ?? localStorage.getItem(RUN);
  if (id) rememberRun(id); // a run reopened from storage is in the url too, so the address can be shared
  return id;
};
const rememberRun = (id: string | null) => {
  const url = new URL(location.href);
  if (id) { url.searchParams.set("run", id); localStorage.setItem(RUN, id); }
  else { url.searchParams.delete("run"); localStorage.removeItem(RUN); }
  history.replaceState(null, "", url);
};

export function App() {
  const [theme, setTheme] = useTheme();
  const [vim, setVim] = useVimSetting();
  const connection = useMemo(() => createConnection({ origin: location.origin }), []);
  const runs = useMemo(() => createRun(connection, { selected: initialRun(), onSelect: rememberRun, bindings: hostBindings }), [connection]);
  useEffect(() => () => { runs.dispose(); connection.stop(); }, [connection, runs]);
  const state = useExternal(connection);
  const view = useExternal(runs);
  const open = sessionPresentation(view.transition).open;
  // A new run remounts the dock (a fresh draft and delivery state) over a fresh empty store.
  const [epoch, setEpoch] = useState(0);
  const blank = useMemo(() => createRunStore(), [epoch]);
  const store = open?.lease.store ?? blank;
  const [yolo, setYolo] = useState(false);
  const [retryTurn, setRetryTurn] = useState<(() => void) | null>(null);
  const [viewer, setViewer] = useState<any>(null);
  const viewerOpener = useRef<HTMLElement | null>(null);
  const openViewer = useCallback((block: any) => { viewerOpener.current = document.activeElement as HTMLElement | null; setViewer(block); }, []);
  const closeViewer = useCallback(() => { setViewer(null); requestAnimationFrame(() => viewerOpener.current?.focus()); }, []);
  const [newRunConfirm, setNewRunConfirm] = useState(false);
  const newRunButton = useRef<HTMLButtonElement>(null);
  const [undelivered, setUndelivered] = useState<ReadonlySet<string>>(() => new Set());
  const onUndelivered = useCallback((intents: string[]) => {
    if (intents.length) setUndelivered((current) => new Set([...current, ...intents]));
  }, []);
  const newRun = useCallback(async () => {
    if (store.getState().agent === "running") {
      setNewRunConfirm(true);
      return;
    }
    runs.reset();
    setYolo(false);
    setUndelivered(new Set());
    setEpoch((value) => value + 1);
  }, [connection, runs, store]);
  const confirmNewRun = useCallback(async () => {
    setNewRunConfirm(false);
    if (connection.client) await stopTurn(connection.client).catch(() => {});
    runs.reset();
    setYolo(false);
    setUndelivered(new Set());
    setEpoch((value) => value + 1);
  }, [connection, newRun]);
  const client = state.phase === "connected" ? connection.client : null;

  return (
    <HighlightContext value={highlight}>
      <ApprovalModeContext value={{ yolo, setYolo }}>
        <RunProvider store={store} highlight={highlight} onRetry={client && open ? () => client.retrySession(open.id) : undefined}>
          <Undelivered value={undelivered}>
          <RetryTurn value={retryTurn}>
            <div className="app">
              <header className="topbar">
                <span className="brand"><span className="brand-mark" aria-hidden="true" /><span className="brand-name">gamma</span></span>
                <RunTitle session={view.session} blank={!sessionPresentation(view.transition).selected} />
                <YoloIndicator className="topbar-yolo" />
                <button ref={newRunButton} type="button" className="ghost new-run" onClick={() => void newRun()} disabled={!sessionPresentation(view.transition).selected}>new run</button>
                <SettingsMenu>
                  <ThemePicker theme={theme} onChange={setTheme} />
                  <VimToggle on={vim} onChange={setVim} />
                </SettingsMenu>
              </header>
              <main className="main">
                <Body state={state} view={view} connection={connection} runs={runs} onNewRun={() => void newRun()} />
                <Dock key={epoch} state={state} view={view} connection={connection} runs={runs} vim={vim} onUndelivered={onUndelivered} onRetryTurn={setRetryTurn} onImageOpen={openViewer} />
                {newRunConfirm ? <ConfirmDialog title="stop the running turn?" confirm="stop and start new run" onConfirm={confirmNewRun} onCancel={() => { setNewRunConfirm(false); newRunButton.current?.focus(); }} /> : null}
                {viewer ? <Inspector ref={(node) => { if (node) node.focus(); }} value={viewer} onClose={closeViewer} /> : null}
              </main>
            </div>
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
    row?.querySelector<HTMLButtonElement>('button[data-action="approve"]:not(:disabled), button:not(:disabled)')?.focus({ preventScroll: true });
  });
}

/**
 * One line over the composer: what the run is doing now. It never carries a problem. Each problem has one home with
 * one action: connection and run-open problems in the main panel, a failed turn on its transcript row, a failed send,
 * steer, or stop in the composer note. While a problem panel shows, the status line is absent.
 */
function StatusLine({ phase }: { phase: RunPhase }) {
  const tone = phase.kind === "approval" ? "warn" : phase.kind === "ready" ? "ok" : "busy";
  const text = { ready: "ready", thinking: "thinking…", connecting: "connecting…", reconnecting: "reconnecting…", opening: "opening the run…", approval: "", running: "" }[phase.kind];
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

async function submitRun({ text, images, steer, connection, runs, delivery, yolo }: { text: string; images: readonly import("./image-queue").QueuedImage[]; steer: boolean; connection: Connection; runs: RunControl; delivery: ReturnType<typeof createDelivery>; yolo: boolean }) {
  const target = connection.client;
  if (!target) throw new Error("not connected to zeta serve");
  if (!transitionRun(runs.state.transition)) {
    const choice = nextRunModel();
    await runs.create(choice.model && target.features.includes("new_session_settings") ? { ...choice, approval_mode: yolo ? "allow" : "ask" } : choice);
    if (!choice.model || !target.features.includes("new_session_settings")) await applyFirstTurnSettings(target, transitionRun(runs.state.transition)!.id, choice, yolo);
  }
  const id = transitionRun(runs.state.transition)!.id;
  if (!images.length) return delivery.submit(target, text, steer);
  return target.request("send_images", { session_id: id, text, images: images.map(({ name, mime_type, data }) => ({ name, mime_type, data })) }, { timeoutMs: 30_000 });
}

function dockPhase(state: ConnectionState, present: ReturnType<typeof sessionPresentation>, open: OpenRun | null, agent: ReturnType<typeof useAgentPhase>, starting: boolean): RunPhase {
  if (state.phase === "connecting" || state.phase === "dropped") return { kind: state.phase === "connecting" && !state.lost ? "connecting" : "reconnecting" };
  if ((present.opening || open?.stale) && !starting) return { kind: open?.stale ? "reconnecting" : "opening" };
  if (agent.kind === "approval") return { kind: "approval" };
  if (agent.kind === "running") return { kind: "running", tool: agent.tool };
  if (agent.kind === "thinking") return { kind: "thinking" };
  return { kind: "ready" };
}

function DockComposer({ readOnly, running, vim, onSubmit, onStop, onImageOpen, client, sessionId, yolo, onYolo }: { readOnly: string | null; running: boolean; vim: boolean; onSubmit: Submit; onStop(): Promise<unknown>; onImageOpen(block: any): void; client: ZetaClient | null; sessionId: string | null; yolo: boolean; onYolo(value: boolean): void }) {
  if (readOnly !== null) return <GammaComposer state="read-only" reason={readOnly} vim={vim} onSubmit={onSubmit} onImageOpen={onImageOpen} />;
  return <GammaComposer state={running ? "steerable" : "idle"} vim={vim} autoFocus onSubmit={onSubmit} onStop={onStop} onImageOpen={onImageOpen} footer={<RunSettings client={client} sessionId={sessionId} yolo={yolo} onYolo={onYolo} />} />;
}

function useDockDelivery(runs: RunControl, running: boolean, client: ZetaClient | null, onUndelivered: (intents: string[]) => void) {
  const delivery = useMemo(() => createDelivery(undefined, (event) => {
    const store = transitionRun(runs.state.transition)?.lease.store;
    const deliveryId = event.type === "user_message" && event.delivery_id;
    if (!store || !deliveryId) return;
    // zeta echoes before replying. an absent echo means the fallback row is provisional and stays queued.
    if (store.hasMessageDelivery(deliveryId)) return;
    store.dispatch(event);
  }), [runs]);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (!running && wasRunning.current && client) delivery.turnEnded(client).then(onUndelivered, () => {});
    wasRunning.current = running;
  }, [running, client, delivery, onUndelivered]);
  return delivery;
}

function useDockRetry(agent: ReturnType<typeof useAgentPhase>, client: ZetaClient | null, delivery: ReturnType<typeof createDelivery>, lastPrompt: string | null, onRetryTurn: Dispatch<SetStateAction<(() => void) | null>>) {
  const failed = agent.kind === "failed" && client && lastPrompt ? lastPrompt : null;
  useEffect(() => {
    onRetryTurn(failed && client ? () => () => void delivery.submit(client, failed, false).catch(() => {}) : null);
    return () => onRetryTurn(null);
  }, [failed, client, delivery, onRetryTurn]);
}

function Dock({ state, view, connection, runs, vim, onUndelivered, onRetryTurn, onImageOpen }: {
  state: ConnectionState; view: RunState; connection: Connection; runs: RunControl; vim: boolean; onUndelivered(intents: string[]): void; onRetryTurn: Dispatch<SetStateAction<(() => void) | null>>; onImageOpen(block: any): void;
}) {
  const present = sessionPresentation(view.transition);
  const open = present.open;
  const blank = !present.selected;
  const client = state.phase === "connected" ? connection.client : null;
  const agent = useAgentPhase();
  const running = agent.kind === "thinking" || agent.kind === "approval" || agent.kind === "running";
  const { yolo, setYolo } = useContext(ApprovalModeContext);
  // This dock's own first send is starting the run: the composer stays put while zeta creates and opens it.
  const [starting, setStarting] = useState(false);
  const delivery = useDockDelivery(runs, running, client, onUndelivered);

  const onSubmit: Submit = useCallback(async (text, images, { steer }) => {
    setStarting(true);
    try { return await submitRun({ text, images, steer, connection, runs, delivery, yolo }); }
    finally { setStarting(false); }
  }, [connection, runs, delivery, yolo]);
  const onStop = useCallback(() => (client ? delivery.stop(client) : Promise.reject(new Error("not connected to zeta serve"))), [client, delivery]);
  const lastPrompt = useLastPrompt();

  useDockRetry(agent, client, delivery, lastPrompt, onRetryTurn);

  const failure = present.openError;
  const problem = (state.phase !== "connected" && state.phase !== "connecting" && state.phase !== "dropped") || Boolean(failure && !failure.restored);
  const phase = dockPhase(state, present, open, agent, starting);
  const readOnly = problem ? "" : !client ? "sending is paused until zeta reconnects" : starting ? null : present.opening || open?.stale ? "sending is paused until the run opens" : null;
  return <div className="dock"><>{problem ? null : <StatusLine phase={phase} />}</><DockComposer readOnly={readOnly} running={running} vim={vim} onSubmit={onSubmit} onStop={onStop} onImageOpen={onImageOpen} client={client} sessionId={blank || starting ? null : open?.id ?? null} yolo={yolo} onYolo={setYolo} /></div>;
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

function OpenBody({ state, connection, present, runs }: { state: ConnectionState; connection: Connection; present: ReturnType<typeof sessionPresentation>; runs: RunControl }) {
  const open = present.open!;
  const failed = present.openError;
  const offline = state.phase !== "connected";
  return <><>{offline && state.phase !== "connecting" && state.phase !== "dropped" ? <ConnectionNotice state={state} connection={connection} compact /> : null}</><>{!open.history.complete ? <p className="note" data-tone="busy" role="status">loading earlier messages… {open.history.messages.toLocaleString("en")} loaded</p> : null}</><>{open.syncing ? <p className="note" data-tone="busy" role="status">live updates paused while this run is busy; it will catch up</p> : null}</><>{failed ? <div className="note" data-tone="danger" role="alert"><span>could not reopen this run: {failed.message}</span> <button type="button" className="ghost" onClick={() => runs.dismissOpenError()}>dismiss</button> <button type="button" className="ghost" onClick={() => runs.select(failed.id)}>try again</button></div> : null}</><Run client={offline ? null : connection.client} open={open} readOnly={Boolean(present.opening || (failed && !failed.restored))} /></>;
}
function Body({ state, view, connection, runs, onNewRun }: { state: ConnectionState; view: RunState; connection: Connection; runs: RunControl; onNewRun(): void }) {
  const present = sessionPresentation(view.transition);
  const offline = state.phase !== "connected";
  if (present.open) return <OpenBody state={state} connection={connection} present={present} runs={runs} />;
  if (offline && state.phase !== "connecting" && state.phase !== "dropped") return <div className="scroll"><ConnectionNotice state={state} connection={connection} /></div>;
  if (present.selected && !present.openError && view.session?.session_id !== present.selected) return <div className="scroll"><Panel title="opening the run" tone="busy"><p>loading history{present.opening?.messages ? ` · ${present.opening.messages.toLocaleString("en")} messages` : ""}</p></Panel></div>;
  if (present.openError) { const failure = present.openError; return <div className="scroll"><Panel title={failure.busy ? "zeta is busy with another run" : "could not open this run"} tone={failure.busy ? "warn" : "danger"}><p className="mono">{failure.busy ? "zeta serve opens a run only when no turn runs. wait for the running turn to end, then try again." : failure.message}</p><div className="actions"><button type="button" className="primary" onClick={() => runs.select(failure.id)}>try again</button><button type="button" className="ghost" onClick={onNewRun}>new run</button></div></Panel></div>; }
  return <div className="scroll"><div className="empty-run" role="note"><h2>new run</h2><p>write below to start. zeta creates the run when you send the first message.</p></div></div>;
}

function Run({ client, open, readOnly }: { client: ZetaClient | null; open: OpenRun; readOnly: boolean }) {
  const scroll = useRef<HTMLDivElement>(null);
  const artifacts = useArtifacts(open.id, open.lease.store);
  const [viewer, setViewer] = useState<any>(null);
  const viewerDialog = useRef<HTMLDivElement>(null);
  const viewerOpener = useRef<HTMLElement | null>(null);
  const openViewer = useCallback((block: any) => { viewerOpener.current = document.activeElement as HTMLElement | null; setViewer(block); }, []);
  const closeViewer = useCallback(() => { setViewer(null); requestAnimationFrame(() => viewerOpener.current?.focus()); }, []);
  useEffect(() => { if (!viewer) return; viewerDialog.current?.focus(); const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") closeViewer(); }; addEventListener("keydown", onKey); return () => removeEventListener("keydown", onKey); }, [viewer, closeViewer]);
  const decisions = useMemo(() => {
    if (!client || open.stale || readOnly) return { disabledReason: readOnly ? "opening the run — decisions are paused" : "reconnecting — decisions are disabled until the server confirms this run" };
    const decide = (method: "approve" | "deny"): Decide => async (request_id) => {
      try {
        return await client.request(method, { request_id }, { timeoutMs: 15_000 });
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
      {viewer ? <Inspector ref={viewerDialog} value={viewer} onClose={closeViewer} /> : null}
    </Decisions.Provider>
  );
}

function ConfirmDialog({ title, confirm, onConfirm, onCancel }: { title: string; confirm: string; onConfirm(): void; onCancel(): void }) {
  const first = useRef<HTMLButtonElement>(null);
  const last = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onCancel(); } if (event.key === "Tab" && event.shiftKey && document.activeElement === first.current) { event.preventDefault(); last.current?.focus(); } else if (event.key === "Tab" && !event.shiftKey && document.activeElement === last.current) { event.preventDefault(); first.current?.focus(); } }; addEventListener("keydown", key); return () => removeEventListener("keydown", key); }, [onCancel]);
  return <div className="confirm-backdrop"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-label={title}><h2>{title}</h2><p>the current turn will be stopped before the new run opens.</p><div className="actions"><button ref={first} type="button" className="primary" onClick={onConfirm}>{confirm}</button><button ref={last} type="button" className="ghost" onClick={onCancel}>cancel</button></div></div></div>;
}

const Inspector = forwardRef<HTMLDivElement, { value: any; onClose(): void }>(function Inspector({ value, onClose }, ref) {
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
  const rows = type === "text/csv" && text !== null ? text.split(/\r?\n/).slice(0, 200).filter(Boolean).map((line) => line.split(",").slice(0, 50)) : null;
  return <div ref={ref} className="inspector" role="dialog" aria-modal="true" aria-label="file inspector" tabIndex={-1}>
    <div className="inspector-bar"><strong>{artifact?.title ?? artifact?.filename ?? value.alt ?? "file"}</strong><a href={url} download={artifact?.filename ?? artifact?.title ?? "artifact"}>download</a><button type="button" onClick={onClose}>close</button></div>
    <div className="inspector-body">
      {type.startsWith("image/") ? <img src={url} alt={artifact?.title ?? value.alt ?? "image"} />
      : type === "application/pdf" ? <iframe title="pdf preview" sandbox="" src={url} />
      : type === "text/html" ? (htmlUrl ? <iframe title="html preview" data-viewer="html" sandbox="" src={htmlUrl} /> : <span>loading…</span>)
      : type === "text/markdown" && text !== null ? <RichMarkdown source={text} streaming={false} />
      : rows ? <table><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell.slice(0, 1000)}</td>)}</tr>)}</tbody></table>
      : text !== null ? <pre>{text.slice(0, 1_000_000)}</pre> : <span>loading…</span>}
    </div>
  </div>;
});

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

function ConnectionNotice({ state, connection, compact = false }: { state: ConnectionState; connection: Connection; compact?: boolean }) {
  const wait = useCountdown("retryAt" in state ? state.retryAt : null);
  const command = serveCommand(location.origin, connection.port);
  const retry = wait === null ? null : (
    <div className="actions">
      <span className="wait" aria-live="off">{wait > 0 ? `retrying in ${wait}s` : "retrying"}</span>
      <button type="button" className="primary" onClick={() => connection.retryNow()}>retry now</button>
    </div>
  );
  const lost = "lost" in state && state.lost;
  let title: string;
  let tone = "danger";
  let body: ReactNode;
  switch (state.phase) {
    case "connected":
      return null;
    case "connecting":
      title = lost ? "reconnecting to zeta serve" : "connecting to zeta serve";
      tone = "busy";
      body = <p>looking for the server through this dev server's handoff.</p>;
      break;
    case "dropped":
      title = "connection lost";
      body = <p>the socket to zeta serve closed. the run keeps going on the server; this page reconnects and rebuilds the session from its history.</p>;
      break;
    case "not_running":
      title = lost ? "connection lost: zeta serve stopped" : "zeta serve is not running";
      body = (
        <>
          <p>start it with this page's origin in the allowlist. this page connects as soon as it is up.</p>
          <Copy value={command} />
        </>
      );
      break;
    case "auth_failed":
      title = "auth failed";
      body = state.reason === "origin" ? (
        <>
          <p>zeta serve allows {state.origins.map((origin, index) => <span key={origin}>{index ? ", " : ""}<code>{origin}</code></span>)}, not this page's origin <code>{location.origin}</code>. restart it with this origin:</p>
          <Copy value={command} />
        </>
      ) : (
        <>
          <p>zeta serve is running but refused the token. restart it so the dev server hands over a fresh token:</p>
          <Copy value={command} />
        </>
      );
      break;
    case "busy":
      title = "zeta serve is in use";
      tone = "warn";
      body = <p>zeta serve accepts one client at a time. close the other client (another tab, the playground, or the zeta app) and this page takes over.</p>;
      break;
    case "incompatible":
      title = "unsupported protocol version";
      body = <><p>gamma needs zeta protocol 1.2, but this server offers an older version. update zeta, then retry.</p><button type="button" className="primary" onClick={() => location.reload()}>reload after updating zeta</button></>;
      break;
  }
  if (compact) {
    return (
      <div className="notice" data-tone={tone} role="status">
        <strong>{title}</strong>
        <span className="wait">{wait === null ? "" : wait > 0 ? `retrying in ${wait}s` : "retrying"}</span>
        {wait !== null ? <button type="button" className="ghost" onClick={() => connection.retryNow()}>retry now</button> : null}
        {state.phase === "not_running" || state.phase === "auth_failed" ? <Copy value={command} /> : null}
      </div>
    );
  }
  return (
    <Panel title={title} tone={tone}>
      {body}
      {retry}
    </Panel>
  );
}
