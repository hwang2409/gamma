import { createHighlighter } from "@fulcrum/highlight";
import { Markdown, type Fences, type MarkdownProps } from "@fulcrum/markdown/react";
import { MermaidFence } from "@fulcrum/mermaid";
import { Approval, Code, Composer, Fallback, FileBlock, HighlightContext, ImageBlock, Message, RunProvider, Timeline, useItemSelector, useRun, useRunStore, useTimeline, type Renderers } from "@fulcrum/react";
import type { SessionStore, ZetaClient } from "@fulcrum/zeta";
import { forwardRef, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { createConnection, serveCommand, type Connection, type ConnectionState } from "./connection";
import { createDelivery } from "./delivery";
import { ago, createSessions, sessionPresentation, sessionTitle, topLevel, type OpenRun, type SessionMeta, type Sessions, type SessionsState } from "./session";
import { ThemePicker, useTheme } from "./theme";
import { addImage, readImage, type QueuedImage } from "./image-queue";
import { artifactContentUrl, hostBindings, useArtifacts } from "./host-client";
import type { Artifact } from "./host/types";
import { catalogModels, settingModel, settingsRequest, type SessionSettings } from "./settings";

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
  const undelivered = useContext(Undelivered);
  const lost = intent !== undefined && undelivered.has(intent);
  return (
    <>
      <Fallback id={id} />
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
  return <><Fallback id={id} />{toolId ? <ArtifactList anchor={toolId} /> : null}</>;
}
const ApprovalModeContext = createContext<{ yolo: boolean; setYolo(value: boolean): void }>({ yolo: false, setYolo() {} });
function YoloIndicator({ className = "" }: { className?: string }) {
  const { yolo } = useContext(ApprovalModeContext);
  return yolo ? <strong className={`yolo-indicator ${className}`}>YOLO · auto-approve tools</strong> : null;
}
function ZetaMessage({ id }: { id: string }) {
  const onOpen = useContext(ImageViewer);
  return <Message id={id} markdown={RichMarkdown} onOpen={onOpen ?? undefined} />;
}
const renderers: Renderers = {
  message: ({ id }) => <ZetaMessage id={id} />,
  approval: ZetaApproval,
  user: UserRow,
  tool: ToolWithArtifacts,
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

const hashSession = () => new URLSearchParams(location.hash.slice(1)).get("session");

export function App() {
  const [theme, setTheme] = useTheme();
  const connection = useMemo(() => createConnection({ origin: location.origin }), []);
  const sessions = useMemo(
    () => createSessions(connection, {
      selected: hashSession(),
      onSelect: (id) => history.replaceState(null, "", `#session=${encodeURIComponent(id)}`),
      bindings: hostBindings,
    }),
    [connection],
  );
  useEffect(() => () => { sessions.dispose(); connection.stop(); }, [connection, sessions]);
  const state = useExternal(connection);
  const view = useExternal(sessions);
  const present = sessionPresentation(view.transition);
  const [drawer, setDrawer] = useState(false);
  const [yolo, setYolo] = useState(false);
  const menu = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const runOpener = useRef<Element | null>(null);
  // A session the user just started opens with the composer focused, ready to type.
  const focusComposer = useRef(false);
  const closeDrawer = useCallback(() => { returnFocus.current = true; setDrawer(false); }, []);
  // After the render that drops `inert` from main, so the menu button can take focus again.
  useEffect(() => { if (!drawer && returnFocus.current) { returnFocus.current = false; menu.current?.focus(); } }, [drawer]);
  const select = useCallback((id: string) => {
    runOpener.current = document.activeElement;
    focusComposer.current = false;
    sessions.select(id);
    setDrawer(false);
  }, [sessions]);
  // The drawer stays open until zeta has made the session: a refusal (zeta rejects while a turn runs) shows in the
  // drawer, where the user pressed the button, not in a run hidden behind it.
  const create = useCallback(() => {
    focusComposer.current = true;
    void sessions.create().then(() => {
      if (sessions.state.createError) { focusComposer.current = false; return; }
      setDrawer(false);
    });
  }, [sessions]);
  const current = view.sessions.find((session) => session.session_id === (present.open?.id ?? present.selected));
  useEffect(() => { document.title = current ? `${sessionTitle(current)} · zeta` : "zeta · fulcrum"; }, [current]);

  return (
    <HighlightContext value={highlight}>
      <ApprovalModeContext value={{ yolo, setYolo }}>
      <div className="app" data-drawer={drawer ? "open" : "closed"}>
        <Sidebar
          state={state}
          view={view}
          sessions={sessions}
          onSelect={select}
          onCreate={create}
          open={drawer}
          onClose={closeDrawer}
          footer={<ThemePicker theme={theme} onChange={setTheme} />}
        />
        {drawer ? <button type="button" className="scrim" aria-label="close sessions" tabIndex={-1} onClick={closeDrawer} /> : null}
        <main className="main" inert={drawer || undefined}>
          <header className="topbar">
            <button ref={menu} type="button" className="menu" aria-label="sessions" aria-expanded={drawer} aria-controls="sessions" onClick={() => setDrawer(true)}>
              <span aria-hidden="true" className="menu-icon" />
            </button>
            <RunTitle session={current} view={view} />
            <YoloIndicator className="topbar-yolo" />
          </header>
          <Body state={state} view={view} connection={connection} sessions={sessions} opener={runOpener} focusComposer={focusComposer} onCreate={create} onOpenDrawer={() => setDrawer(true)} />
        </main>
      </div>
      </ApprovalModeContext>
    </HighlightContext>
  );
}

function ConnectionBadge({ state }: { state: ConnectionState }) {
  const [word, tone] =
    state.phase === "connected" ? ["connected", "ok"]
    : state.phase === "connecting" ? [state.lost ? "reconnecting" : "connecting", "busy"]
    : state.phase === "dropped" ? ["connection lost", "danger"]
    : state.phase === "not_running" ? ["not running", "danger"]
    : state.phase === "auth_failed" ? ["auth failed", "danger"]
    : state.phase === "busy" ? ["in use", "warn"]
    : ["unsupported", "danger"];
  return <span className="badge" data-tone={tone} role="status">{word}</span>;
}

function Sidebar({ state, view, sessions, onSelect, onCreate, open, onClose, footer }: {
  state: ConnectionState; view: SessionsState; sessions: Sessions; onSelect(id: string): void; onCreate(): void; open: boolean; onClose(): void; footer: ReactNode;
}) {
  const list = useRef<HTMLUListElement>(null);
  const rows = useMemo(() => topLevel(view.sessions), [view.sessions]);
  const present = sessionPresentation(view.transition);
  const selected = present.open?.id ?? present.selected;
  // The drawer takes focus when it opens, on the session on screen.
  useEffect(() => {
    if (!open) return;
    (list.current?.querySelector<HTMLElement>("[tabindex='0']") ?? list.current?.closest("aside")?.querySelector<HTMLElement>("button"))?.focus();
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, onClose]);
  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && open) { event.preventDefault(); onClose(); return; }
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button.session") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: buttons.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
  };
  const focusable = rows.some((row) => row.session_id === selected) ? selected : rows[0]?.session_id;
  const now = Date.now();
  return (
    <aside id="sessions" className="sidebar" onKeyDown={onKey} role={open ? "dialog" : undefined} aria-modal={open || undefined} aria-label="sessions">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">zeta</span>
        <span className="brand-sub">fulcrum</span>
        <ConnectionBadge state={state} />
      </div>
      <div className="list-head">
        <h2>sessions</h2>
        <span className="count">{rows.length ? rows.length : ""}</span>
        <button type="button" className="ghost" onClick={() => void sessions.refresh()} disabled={state.phase !== "connected"}>refresh</button>
        <NewSession state={state} view={view} onCreate={onCreate} className="accent" />
      </div>
      <nav className="list" aria-label="sessions" data-catalog-ready={view.listReady ? "true" : "false"}>
        {view.listError ? <p className="note" data-tone="danger">could not list sessions: {view.listError} <button type="button" className="ghost" onClick={() => void sessions.refresh()}>retry</button></p> : null}
        {view.createError ? <p className="note" data-tone="danger" role="alert">could not start a session: {view.createError}</p> : null}
        {view.listLoading ? <p className="note" role="status">{view.listSlow ? "still loading sessions…" : "loading sessions…"}</p> : null}
        {state.phase === "connected" && !rows.length && !view.listLoading && !view.listError ? <p className="note">no sessions yet. start one with new session.</p> : null}
        <ul ref={list}>
          {rows.map((session) => (
            <SessionRow key={session.session_id} session={session} now={now} selected={session.session_id === selected} focusable={session.session_id === focusable} opening={present.opening?.id === session.session_id || present.openError?.id === session.session_id} server={state.phase === "connected" ? view.server : null} store={state.phase === "connected" && present.open?.id === session.session_id && !present.open.stale ? present.open.lease.store : null} onSelect={onSelect} />
          ))}
        </ul>
        {view.nextOffset !== null ? <button type="button" className="ghost more" onClick={() => void sessions.loadMore()}>load more sessions</button> : null}
      </nav>
      <div className="sidebar-foot">{footer}</div>
    </aside>
  );
}

function NewSession({ state, view, onCreate, className }: { state: ConnectionState; view: SessionsState; onCreate(): void; className: string }) {
  const unavailable = state.phase !== "connected" || view.creating;
  return (
    <button type="button" className={className} onClick={() => { if (!unavailable) onCreate(); }} aria-disabled={unavailable || undefined} aria-busy={view.creating || undefined}>
      {view.creating ? "starting…" : "new session"}
    </button>
  );
}

type RowProps = { session: SessionMeta; now: number; selected: boolean; focusable: boolean; onSelect(id: string): void };
type RowStatus = "open" | "running" | "approval" | "opening" | null;

/** The open session's row follows its live run; other rows use the server's last `status`. */
function SessionRow({ server, store, opening, ...row }: RowProps & { server: SessionsState["server"]; store: SessionStore | null; opening: boolean }) {
  const live = server?.id === row.session.session_id;
  const status = opening ? "opening" : !live ? null : server.approvals ? "approval" : server.state === "idle" ? "open" : "running";
  return <Row {...row} status={status} store={store} />;
}

function LiveStatus() {
  const status = useRunStatus();
  const value = status === "idle" ? "open" : status;
  return <span className="state" data-status={value}>{value === "approval" ? "needs approval" : value}</span>;
}

function Row({ session, now, selected, focusable, onSelect, status, store }: RowProps & { status: RowStatus; store: SessionStore | null }) {
  return (
    <li>
      <button type="button" className="session" data-status={status ?? undefined} aria-current={selected ? "true" : undefined} tabIndex={focusable ? 0 : -1} onClick={() => onSelect(session.session_id)}>
        <span className="session-title">{sessionTitle(session)}</span>
        <span className="session-meta">
          <time dateTime={session.updated_at} title={new Date(session.updated_at).toLocaleString()}>{ago(session.updated_at, now)}</time>
          {store ? <RunProvider store={store}><LiveStatus /></RunProvider> : status ? <span className="state" data-status={status}>{status === "approval" ? "needs approval" : status}</span> : null}
          {session.model ? <span className="model">{session.model}</span> : null}
        </span>
      </button>
    </li>
  );
}

function RunTitle({ session, view }: { session: SessionMeta | undefined; view: SessionsState }) {
  const present = sessionPresentation(view.transition);
  if (!session) return <div className="run-title"><h1>{present.selected ? "session" : "zeta"}</h1></div>;
  return (
    <div className="run-title">
      <h1 title={sessionTitle(session)}>{sessionTitle(session)}</h1>
      <p className="run-meta">
        {present.open?.id === session.session_id && !present.open.stale ? (
          <RunProvider store={present.open.lease.store}><RunStatus /></RunProvider>
        ) : null}
        {session.model ? <span>{session.model}</span> : null}
        {session.cwd ? <span className="cwd" title={session.cwd}>{session.cwd.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~")}</span> : null}
      </p>
    </div>
  );
}

/** A run blocked on an approval is waiting for the user, not running. Approvals are few, so this reads only them. */
function useRunStatus(): "idle" | "running" | "approval" {
  const store = useRunStore();
  return useRun(useCallback((state: ReturnType<typeof store.getState>) => {
    if (state.agent !== "running") return "idle";
    const waiting = Object.values(state.toolApprovals).some((id) => { const item = store.getItem(id); return item?.type === "approval" && !item.ended; });
    return waiting ? "approval" : "running";
  }, [store]));
}

function RunStatus() {
  const status = useRunStatus();
  return <span className="state" data-status={status}>{status === "approval" ? "waiting for approval" : status}</span>;
}

/** Refreshes the list when a run ends, so times and titles stay current without polling. */
function RefreshOnIdle({ sessions }: { sessions: Sessions }) {
  const agent = useRun((state) => state.agent);
  const prior = useRef(agent);
  useEffect(() => {
    if (prior.current === "running" && agent !== "running") void sessions.refresh();
    prior.current = agent;
  }, [agent, sessions]);
  return null;
}

function sessionName(view: SessionsState, id: string) {
  const session = view.sessions.find((item) => item.session_id === id);
  return session ? sessionTitle(session) : "session";
}

function OpenRunBody({ state, view, connection, sessions, opener, focusComposer }: {
  state: ConnectionState; view: SessionsState; connection: Connection; sessions: Sessions; opener: React.RefObject<Element | null>; focusComposer: React.RefObject<boolean>;
}) {
  const offline = state.phase !== "connected";
  const present = sessionPresentation(view.transition);
  const open = present.open!;
  const replacing = Boolean(present.opening && present.opening.id !== open.id);
  const failed = present.openError;
  return (
    <>
      {offline ? <ConnectionNotice state={state} connection={connection} compact /> : null}
      {replacing ? <p className="note" data-tone="busy" role="status">opening {sessionName(view, present.opening!.id)}…</p> : null}
      {!replacing && !open.history.complete ? <p className="note" data-tone="busy" role="status">loading earlier messages… {open.history.messages.toLocaleString("en")} loaded</p> : null}
      {!replacing && open.syncing ? <p className="note" data-tone="busy" role="status">live updates paused while this session is busy; it will catch up</p> : null}
      {failed ? <div className="note" data-tone="danger" role="alert"><span>could not open {sessionName(view, failed.id)}: {failed.message}</span> <button type="button" className="ghost" onClick={() => sessions.dismissOpenError()}>dismiss</button> <button type="button" className="ghost" onClick={() => sessions.select(failed.id)}>try again</button></div> : null}
      <Run client={offline ? null : connection.client} sessions={sessions} open={open} opener={opener} focusComposer={focusComposer} readOnly={Boolean(replacing || (failed && !failed.restored))} ready={open.id === present.selected && !present.opening} />
    </>
  );
}

function OpeningPanel({ view }: { view: SessionsState }) {
  const opening = sessionPresentation(view.transition).opening!;
  return <Panel title={`opening ${sessionName(view, opening.id)}`} tone="busy"><p>loading history{opening.messages ? ` · ${opening.messages.toLocaleString("en")} messages` : ""}</p></Panel>;
}

function FailurePanel({ view, sessions }: { view: SessionsState; sessions: Sessions }) {
  const failure = sessionPresentation(view.transition).openError!;
  const running = view.server?.id && view.server.id !== failure.id ? view.server.id : null;
  if (!failure.busy) return <Panel title="could not open this session" tone="danger"><p className="mono">{failure.message}</p><div className="actions"><button type="button" className="primary" onClick={() => sessions.select(failure.id)}>try again</button></div></Panel>;
  return (
    <Panel title="zeta is busy with another session" tone="warn">
      <p>zeta serve opens a session only when no turn runs. wait for the running turn to end, or open the running session.</p>
      <div className="actions">
        {running ? <button type="button" className="primary" onClick={() => sessions.select(running)}>open the running session</button> : null}
        <button type="button" className="ghost" onClick={() => sessions.select(failure.id)}>try again</button>
      </div>
    </Panel>
  );
}

function EmptyPanel({ state, view, onCreate, onOpenDrawer }: { state: ConnectionState; view: SessionsState; onCreate(): void; onOpenDrawer(): void }) {
  const any = view.sessions.length > 0;
  return (
    <Panel title={any ? "choose a session" : "start a session"} tone="busy">
      <p>{any ? "pick a session from the list to follow its run, or start a new one." : "this zeta has no sessions yet. start one to write to zeta."}</p>
      {view.createError ? <p className="mono" role="alert">could not start a session: {view.createError}</p> : null}
      <div className="actions">
        <NewSession state={state} view={view} onCreate={onCreate} className="primary" />
        {any ? <button type="button" className="ghost only-narrow" onClick={onOpenDrawer}>show sessions</button> : null}
      </div>
    </Panel>
  );
}

function Body({ state, view, connection, sessions, opener, focusComposer, onCreate, onOpenDrawer }: {
  state: ConnectionState; view: SessionsState; connection: Connection; sessions: Sessions; opener: React.RefObject<Element | null>; focusComposer: React.RefObject<boolean>; onCreate(): void; onOpenDrawer(): void;
}) {
  const present = sessionPresentation(view.transition);
  if (present.open) return <OpenRunBody state={state} view={view} connection={connection} sessions={sessions} opener={opener} focusComposer={focusComposer} />;
  if (state.phase !== "connected") return <ConnectionNotice state={state} connection={connection} />;
  if (present.opening) return <OpeningPanel view={view} />;
  if (present.openError) return <FailurePanel view={view} sessions={sessions} />;
  return <EmptyPanel state={state} view={view} onCreate={onCreate} onOpenDrawer={onOpenDrawer} />;
}

function Run({ client, sessions, open, opener, focusComposer, readOnly, ready }: { client: ZetaClient | null; sessions: Sessions; open: OpenRun; opener: React.RefObject<Element | null>; focusComposer: React.RefObject<boolean>; readOnly: boolean; ready: boolean }) {
  const scroll = useRef<HTMLDivElement>(null);
  const artifacts = useArtifacts(open.id, open.lease.store);
  const [viewer, setViewer] = useState<any>(null);
  const viewerDialog = useRef<HTMLDivElement>(null);
  const viewerOpener = useRef<HTMLElement | null>(null);
  const openViewer = useCallback((block: any) => { viewerOpener.current = document.activeElement as HTMLElement | null; setViewer(block); }, []);
  const closeViewer = useCallback(() => { setViewer(null); requestAnimationFrame(() => viewerOpener.current?.focus()); }, []);
  useEffect(() => { if (!viewer) return; viewerDialog.current?.focus(); const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") closeViewer(); }; addEventListener("keydown", onKey); return () => removeEventListener("keydown", onKey); }, [viewer, closeViewer]);
  const decisions = useMemo(() => {
    if (!client || open.stale || readOnly) return { disabledReason: readOnly ? "opening another session — decisions are paused" : "reconnecting — decisions are disabled until the server confirms this session" };
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
  useLayoutEffect(() => {
    if (focusComposer.current) {
      focusComposer.current = false;
      scroll.current?.parentElement?.querySelector<HTMLTextAreaElement>(".dock textarea")?.focus({ preventScroll: true });
    } else if (!opener.current?.closest("#sessions") && (document.activeElement === opener.current || document.activeElement === document.body)) scroll.current?.focus({ preventScroll: true });
  }, [open.lease.store, opener, focusComposer]);
  const [undelivered, setUndelivered] = useState<ReadonlySet<string>>(() => new Set());
  const onUndelivered = useCallback((intents: string[]) => {
    if (intents.length) setUndelivered((current) => new Set([...current, ...intents]));
  }, []);
  return (
    <Decisions.Provider value={decisions}>
      <Undelivered value={undelivered}>
        <ImageViewer.Provider value={openViewer}>
        <Artifacts.Provider value={artifacts}>
        <RunProvider store={open.lease.store} highlight={highlight} onRetry={client ? () => client.retrySession(open.id) : undefined}>
          <RefreshOnIdle sessions={sessions} />
          {client && !readOnly ? <SettingsBar client={client} /> : null}
          <div ref={scroll} className="scroll" tabIndex={-1} data-stale={open.stale || undefined} data-run-ready={ready ? "true" : undefined}>
            <Timeline renderers={renderers} virtual scrollRef={scroll} aria-label="session activity" />
            <ArtifactList anchor={null} />
            <EmptyRun />
          </div>
          <RunComposer key={open.id} client={open.stale || readOnly ? null : client} store={open.lease.store} onUndelivered={onUndelivered} readOnly={readOnly} />
        </RunProvider>
        </Artifacts.Provider>
        </ImageViewer.Provider>
        {viewer ? <Inspector ref={viewerDialog} value={viewer} onClose={closeViewer} /> : null}
      </Undelivered>
    </Decisions.Provider>
  );
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

/** A session with no rows yet says what to do instead of showing a blank run. */
function EmptyRun() {
  const empty = useTimeline().length === 0;
  return empty ? (
    <div className="empty-run" role="note">
      <h2>empty session</h2>
      <p>no messages yet. write to zeta below to start a run.</p>
    </div>
  ) : null;
}

const offline = () => Promise.reject(new Error("not connected to zeta serve"));

function ModelPicker({ value, models, onChange }: { value: string; models: string[]; onChange(value: string): void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); button.current?.focus(); } };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [open]);
  return <div className="model-picker">
    <span>model</span>
    <button ref={button} type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>{value || "choose model"}</button>
    {open ? <div role="listbox" aria-label="model">{models.map((model) => <button type="button" role="option" aria-selected={model === value} key={model} onClick={() => { onChange(model); setOpen(false); button.current?.focus(); }}>{model}</button>)}</div> : null}
  </div>;
}

/** Persistent session settings supplied by zeta, not browser-local preferences. */
function SettingsBar({ client }: { client: ZetaClient }) {
  const supported = (name: string) => client.features.includes(name);
  const { setYolo } = useContext(ApprovalModeContext);
  const [settings, setSettings] = useState<SessionSettings>({});
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      if (supported("session_settings")) {
        const next = settingModel(await client.request("session_settings"));
        setSettings(next);
        setYolo(next.approval_mode === "allow");
      } else setYolo(false);
      if (supported("model_catalog")) setModels(catalogModels(await client.request("model_catalog")));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "settings unavailable"); }
  }, [client]);
  useEffect(() => { void load(); const off = client.onClose(() => { setSettings({}); setYolo(false); }); return off; }, [client, load, setYolo]);
  const change = async (patch: Partial<SessionSettings>) => { setError(""); try { await client.request("set_settings", settingsRequest(settings, patch)); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "could not change settings"); } };
  if (!supported("session_settings") && !supported("model_catalog")) return <p className="note">settings are not supported by this server</p>;
  const yolo = settings.approval_mode === "allow";
  return <div className="settings-bar" aria-label="session settings">
    {supported("model_catalog") && models.length ? <ModelPicker value={settings.model ?? ""} models={models} onChange={(model) => void change({ model })} /> : null}
    {supported("set_settings") ? <button type="button" className="toggle" aria-pressed={yolo} onClick={() => { if (!yolo && !confirm("allow tools to run automatically in this session?")) return; void change({ approval_mode: yolo ? "ask" : "allow" }); }}>{yolo ? "YOLO · auto-approve tools" : "Ask"}</button> : null}
    {error ? <span role="alert">{error}</span> : null}
  </div>;
}

function RunComposer({ client, store, onUndelivered, readOnly }: { client: ZetaClient | null; store: SessionStore; onUndelivered(intents: string[]): void; readOnly: boolean }) {
  const running = useRun((state) => state.agent === "running");
  const [images, setImages] = useState<QueuedImage[]>([]);
  const imagesRef = useRef<QueuedImage[]>([]);
  const [imageError, setImageError] = useState("");
  const addFiles = useCallback(async (files: FileList | File[]) => {
    let queue = imagesRef.current;
    for (const file of [...files]) {
      try { queue = addImage(queue, await readImage(file)); setImageError(""); }
      catch (error) { setImageError(error instanceof Error ? error.message : "could not add image"); }
    }
    imagesRef.current = queue;
    setImages(queue);
  }, []);
  const removeImage = (index: number) => { URL.revokeObjectURL(imagesRef.current[index].url); imagesRef.current = imagesRef.current.filter((_, item) => item !== index); setImages(imagesRef.current); };
  const delivery = useMemo(() => createDelivery(undefined, (event) => {
    const deliveryId = event.type === "user_message" && event.delivery_id;
    if (deliveryId && !store.hasMessageDelivery(deliveryId)) store.dispatch(event);
  }), [store]);
  const wasRunning = useRef(running);
  useEffect(() => {
    // shortcut: a resend that fails is not shown; upgrade when the composer can take a host-reported error.
    if (!running && wasRunning.current && client) delivery.turnEnded(client).then(onUndelivered, () => {});
    wasRunning.current = running;
  }, [running, client, delivery, onUndelivered]);
  const onSubmit = useCallback((text: string, { steer }: { steer: boolean }) => {
    if (!client) return offline();
    if (!images.length) return delivery.submit(client, text, steer);
    const request = client.request("send_images", { text, images: images.map(({ name, mime_type, data }) => ({ name, mime_type, data })) });
    request.then(() => { images.forEach((image) => URL.revokeObjectURL(image.url)); imagesRef.current = []; setImages([]); }, (error) => setImageError(error instanceof Error ? error.message : "could not send images"));
    return request;
  }, [client, delivery, images]);
  const onStop = useCallback(() => (client ? delivery.stop(client) : offline()), [client, delivery]);
  return (
    <div className="dock" onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void addFiles(files); } }} onDrop={(event) => { event.preventDefault(); void addFiles(event.dataTransfer.files); }} onDragOver={(event) => event.preventDefault()}>
      {images.length ? <div className="image-queue" aria-label="queued images">{images.map((image, index) => <figure key={`${image.name}-${index}`}><img src={image.url} alt={image.name} /><button type="button" onClick={() => removeImage(index)} aria-label={`remove ${image.name}`}>remove</button></figure>)}</div> : null}
      {imageError ? <p className="note" role="alert">{imageError}</p> : null}
      {client ? <label className="attach-button">add image<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.currentTarget.value = ""; }} /></label> : null}
      <YoloIndicator className="composer-yolo" />
      {client ? (
        <Composer state={running ? "steerable" : "idle"} label="message zeta" placeholder={running ? "steer the running turn" : "message zeta"} onSubmit={onSubmit} onStop={onStop} />
      ) : (
        <Composer state="read-only" reason={readOnly ? "opening another session · sending is paused" : "reconnecting · sending is paused until the server confirms this session"} label="message zeta" onSubmit={onSubmit} />
      )}
    </div>
  );
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
      body = <p>this zeta does not speak protocol 1.0 to 1.2. update zeta or fulcrum, then reload.</p>;
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
