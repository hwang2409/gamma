import { connectZeta, discoverZeta, ZetaError, type ZetaClient, type ZetaDiscovery } from "@fulcrum/zeta";

/**
 * Connection states. Every waiting state carries `attempt` (failures in a row) and `retryAt` (epoch ms of the next
 * automatic try). `lost` marks failures that follow a connection this page had, so the UI can say "connection lost".
 */
export type ConnectionState =
  | { phase: "connecting"; attempt: number; lost: boolean }
  | { phase: "connected" }
  | { phase: "not_running"; attempt: number; retryAt: number; lost: boolean }
  | { phase: "auth_failed"; reason: "origin" | "rejected"; origins: string[]; attempt: number; retryAt: number; lost: boolean }
  | { phase: "busy"; attempt: number; retryAt: number; lost: boolean }
  | { phase: "dropped"; attempt: number; retryAt: number; lost: true }
  | { phase: "incompatible"; lost: boolean };

export type ConnectionEvent =
  | { type: "attempt" }
  | { type: "connected" }
  | { type: "not_running"; now: number }
  | { type: "auth_failed"; reason: "origin" | "rejected"; origins: string[]; now: number }
  | { type: "busy"; now: number }
  | { type: "incompatible" }
  | { type: "closed"; now: number };

/** The command that starts a server this page may connect to. The origin is exact: localhost and 127.0.0.1 differ. */
export const serveCommand = (origin: string, port: number) => `zeta serve --ws ${port} --ws-origin ${origin}`;

export const initialConnection: ConnectionState = { phase: "connecting", attempt: 0, lost: false };

/** 0.5 s, 1 s, 2 s, 4 s, 8 s, then every 10 s: quick after a blip, and cheap while the server stays down. */
export const backoff = (attempt: number) => Math.min(10_000, 500 * 2 ** Math.max(0, attempt - 1));

const attemptOf = (state: ConnectionState) => ("attempt" in state ? state.attempt : 0);
const lostOf = (state: ConnectionState) => state.phase === "connected" || ("lost" in state && state.lost);

export function reduceConnection(state: ConnectionState, event: ConnectionEvent): ConnectionState {
  if (state.phase === "incompatible") return state; // a protocol mismatch needs a new build, not a retry
  const lost = lostOf(state);
  switch (event.type) {
    case "attempt":
      return state.phase === "connected" ? state : { phase: "connecting", attempt: attemptOf(state), lost };
    case "connected":
      return { phase: "connected" };
    case "closed":
      return state.phase === "connected" ? { phase: "dropped", attempt: 1, retryAt: event.now + backoff(1), lost: true } : state;
    case "incompatible":
      return { phase: "incompatible", lost };
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
  connect?: (discovery: ZetaDiscovery) => Promise<ZetaClient>;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
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

export const FEATURES = ["list_sessions_paging", "approval_history", "approval_reconnect", "delivery_id", "user_message_event", "user_message_delivery_id", "session_replay_seq", "session_host_commands", "new_session_settings"];

/**
 * Finds the server through the dev-server handoff, connects, and reconnects with backoff after any failure or drop.
 * A fresh client per connection means a fresh store per session, so a reconnect rebuilds history instead of
 * appending to what the old socket left behind.
 */
export function createConnection({
  origin,
  discover = discoverZeta,
  connect = (discovery) => connectZeta({ url: discovery.url, token: discovery.controller_token, role: "controller", features: FEATURES }),
  now = Date.now,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}: ConnectionDeps): Connection {
  let state = initialConnection;
  let client: ZetaClient | null = null;
  let port = 8765;
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
    if (stopped || state.phase === "connected" || state.phase === "incompatible") return;
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
    try {
      next = await connect(discovery);
    } catch (error) {
      if (!current()) return;
      const kind = error instanceof ZetaError ? error.kind : "connect_failed";
      if (kind === "busy") return send({ type: "busy", now: now() });
      if (kind === "version_mismatch") return send({ type: "incompatible" });
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
