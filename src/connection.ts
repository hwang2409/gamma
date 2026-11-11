import { createClient, discoverZeta, webSocketTransport, ZetaError, type ZetaClient, type ZetaDiscovery } from "@fulcrum/zeta";

/**
 * Connection states. Every waiting state carries `attempt` (failures in a row) and `retryAt` (epoch ms of the next
 * automatic try). `lost` marks failures that follow a connection this page had, so the UI can say "connection lost".
 */
export type ConnectionState =
  | { phase: "connecting"; attempt: number; lost: boolean; lastFailure?: "unresponsive" }
  | { phase: "connected" }
  | { phase: "not_running"; attempt: number; retryAt: number; lost: boolean }
  | { phase: "auth_failed"; reason: "origin" | "rejected"; origins: string[]; attempt: number; retryAt: number; lost: boolean }
  | { phase: "busy"; attempt: number; retryAt: number; lost: boolean }
  | { phase: "dropped"; attempt: number; retryAt: number; lost: true }
  | { phase: "unresponsive" | "incompatible"; attempt: number; retryAt: number; lost: boolean };

export type ConnectionEvent =
  | { type: "attempt" }
  | { type: "connected" }
  | { type: "not_running"; now: number }
  | { type: "auth_failed"; reason: "origin" | "rejected"; origins: string[]; now: number }
  | { type: "busy" | "unresponsive" | "incompatible"; now: number }
  | { type: "closed"; now: number };

/** The command that starts a server this page may connect to. The origin is exact: localhost and 127.0.0.1 differ. */
export const serveCommand = (origin: string, port: number) => `zeta serve --ws ${port} --ws-origin ${origin}`;

export const initialConnection: ConnectionState = { phase: "connecting", attempt: 0, lost: false };

/** 0.5 s, 1 s, 2 s, 4 s, 8 s, then every 10 s: quick after a blip, and cheap while the server stays down. */
export const backoff = (attempt: number) => Math.min(10_000, 500 * 2 ** Math.max(0, attempt - 1));

const attemptOf = (state: ConnectionState) => ("attempt" in state ? state.attempt : 0);
const lostOf = (state: ConnectionState) => state.phase === "connected" || ("lost" in state && state.lost);

export function reduceConnection(state: ConnectionState, event: ConnectionEvent): ConnectionState {
  const lost = lostOf(state);
  switch (event.type) {
    case "attempt":
      return state.phase === "connected" ? state : { phase: "connecting", attempt: attemptOf(state), lost, ...(state.phase === "unresponsive" || (state.phase === "connecting" && state.lastFailure === "unresponsive") ? { lastFailure: "unresponsive" as const } : {}) };
    case "connected":
      return { phase: "connected" };
    case "closed":
      return state.phase === "connected" ? { phase: "dropped", attempt: 1, retryAt: event.now + backoff(1), lost: true } : state;

    default: {
      if (state.phase !== "connecting") return state; // failures only finish an attempt in flight
      const attempt = state.attempt + 1;
      const retryAt = event.now + backoff(attempt);
      if (event.type === "auth_failed") return { phase: "auth_failed", reason: event.reason, origins: event.origins, attempt, retryAt, lost };
      return { phase: event.type, attempt, retryAt, lost };
    }
  }
}

export type ConnectionDeps = {
  /** The page origin the server's `--ws-origin` allowlist must contain. */
  origin: string;
  discover?: () => Promise<ZetaDiscovery | null>;
  connect?: (discovery: ZetaDiscovery, opened?: (close: () => void) => void) => Promise<ZetaClient>;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  helloTimeoutMs?: number;
  initialPort?: number;
};

export type Connection = {
  readonly state: ConnectionState;
  /** The live client while `state.phase` is `connected`, else `null`. */
  readonly client: ZetaClient | null;
  /** The websocket port of the last server found, so a restart hint names it; 8765 (zeta's documented port) before any. */
  readonly port: number;
  subscribe(listener: () => void): () => void;
  /** Skips the wait before the next automatic try. */
  retryNow(): void;
  stop(): void;
};

export const FEATURES = ["list_sessions_paging", "approval_history", "approval_reconnect", "delivery_id", "delivery_session_guard", "user_message_event", "user_message_delivery_id", "served_turn_end", "session_host_commands", "new_session_settings", "model_input_ids", "session_grants", "session_history_fidelity", "child_runs", "child_run_history"];

const negotiatedRequests = new WeakMap<ZetaClient, ReadonlySet<string>>();
export const commandRequests = (client: ZetaClient) => negotiatedRequests.get(client) ?? new Set<string>();

async function connectController(discovery: ZetaDiscovery, opened?: (close: () => void) => void) {
  const url = new URL(discovery.url);
  for (const key of [...url.searchParams.keys()]) if (key.toLowerCase() === "token") url.searchParams.delete(key);
  let transport;
  try { transport = await webSocketTransport(url.toString(), ["zeta.v1", `zeta.bearer.${discovery.controller_token}`]); }
  catch { throw new ZetaError("connect_failed"); }
  opened?.(() => transport.close());
  const client = createClient(transport, undefined, (handshaken, code) => new ZetaError(handshaken ? "closed" : "connect_failed", code));
  try { const hello = await client.hello(FEATURES, "controller"); negotiatedRequests.set(client, new Set(hello.capabilities?.requests ?? [])); }
  catch (error) {
    transport.close();
    const code = (error as { code?: unknown }).code;
    throw new ZetaError(code === -32001 ? "busy" : code === -32002 ? "version_mismatch" : "connect_failed", typeof code === "number" ? code : undefined);
  }
  return client;
}

/**
 * Finds the server through the dev-server handoff, connects, and reconnects with backoff after any failure or drop.
 * A fresh client per connection means a fresh store per session, so a reconnect rebuilds history instead of
 * appending to what the old socket left behind.
 */
export function createConnection({
  origin,
  discover = discoverZeta,
  connect = connectController,
  now = Date.now,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  helloTimeoutMs = 15_000,
  initialPort = 8765,
}: ConnectionDeps): Connection {
  let state = initialConnection;
  let client: ZetaClient | null = null;
  let port = initialPort;
  let timer: unknown = null;
  let generation = 0;
  let stopped = false;
  const listeners = new Set<() => void>();
  const send = (event: ConnectionEvent) => {
    const next = reduceConnection(state, event);
    if (next === state) return;
    state = next;
    if ("retryAt" in state) schedule(state.retryAt - now());
    listeners.forEach((listener) => listener());
  };
  const schedule = (ms: number) => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; void attempt(); }, Math.max(0, ms));
  };
  const attempt = async () => {
    if (stopped || state.phase === "connected") return;
    const mine = ++generation;
    send({ type: "attempt" });
    const current = () => mine === generation && !stopped;
    let discovery: ZetaDiscovery | null;
    try {
      discovery = await discover();
    } catch {
      discovery = null; // the dev server itself is unreachable: same remedy as a stopped zeta
    }
    if (!current()) return;
    if (!discovery) return send({ type: "not_running", now: now() });
    port = Number(new URL(discovery.url).port) || port;
    // An origin the allowlist lacks fails at the upgrade with no detail, so name it before trying.
    if (discovery.origins.length && !discovery.origins.includes(origin))
      return send({ type: "auth_failed", reason: "origin", origins: discovery.origins, now: now() });
    let next: ZetaClient;
    let timedOut = false;
    let closePending = () => {};
    let connectTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      next = await Promise.race([
        connect(discovery, (close) => { closePending = close; }).then((value) => { if (timedOut) value.close(); return value; }),
        new Promise<never>((_, reject) => { connectTimeout = setTimeout(() => { timedOut = true; closePending(); reject(new Error("hello timeout")); }, helloTimeoutMs); }),
      ]);
      clearTimeout(connectTimeout);
    } catch (error) {
      clearTimeout(connectTimeout);
      if (!current()) return;
      if (timedOut) return send({ type: "unresponsive", now: now() });
      const kind = error instanceof ZetaError ? error.kind : "connect_failed";
      if (kind === "busy") return send({ type: "busy", now: now() });
      if (kind === "version_mismatch") return send({ type: "incompatible", now: now() });
      // The process runs and the origin is allowed, so a refused upgrade means the token was refused.
      return send({ type: "auth_failed", reason: "rejected", origins: discovery.origins, now: now() });
    }
    if (!current()) return next.close();
    client = next;
    next.onClose(() => {
      if (client !== next) return;
      client = null;
      send({ type: "closed", now: now() });
    });
    send({ type: "connected" });
  };
  void attempt();
  return {
    get state() { return state; },
    get client() { return client; },
    get port() { return port; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retryNow() {
      if (state.phase === "connected" || state.phase === "connecting" || stopped) return;
      if (timer !== null) { clearTimer(timer); timer = null; }
      void attempt();
    },
    stop() {
      stopped = true;
      generation++;
      if (timer !== null) clearTimer(timer);
      const open = client;
      client = null;
      open?.close();
    },
  };
}
