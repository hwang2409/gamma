import { expect, test } from "bun:test";
import { ZetaError, type ZetaClient, type ZetaDiscovery } from "@fulcrum/zeta";
import { backoff, createConnection, FEATURES, initialConnection, reduceConnection, serveCommand, type ConnectionState } from "../src/connection";
import { openSession } from "../src/session";

const ORIGIN = "http://localhost:5180";
const found: ZetaDiscovery = { url: "ws://127.0.0.1:8765/", controller_token: "controller-secret", observer_token: "observer-secret", origins: [ORIGIN] };

test("hello requests session history fidelity", () => {
  expect(FEATURES).toContain("session_history_fidelity");
  expect(FEATURES).toContain("served_turn_end");
});

test("backoff doubles from 0.5 s and stops at 10 s", () => {
  expect([1, 2, 3, 4, 5, 6, 9].map(backoff)).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
});

test("a failure only ends an attempt in flight and counts up", () => {
  let state: ConnectionState = initialConnection;
  state = reduceConnection(state, { type: "not_running", now: 0 });
  expect(state).toEqual({ phase: "not_running", attempt: 1, retryAt: 500, lost: false });
  expect(reduceConnection(state, { type: "unresponsive", now: 5 })).toBe(state);
  state = reduceConnection(reduceConnection(state, { type: "attempt" }), { type: "unresponsive", now: 1000 });
  expect(state).toEqual({ phase: "unresponsive", attempt: 2, retryAt: 2000, lost: false });
});

test("a hello timeout stays visible during the next attempt", () => {
  const timedOut = reduceConnection(initialConnection, { type: "unresponsive", now: 1_000 });
  expect(reduceConnection(timedOut, { type: "attempt" })).toEqual({ phase: "connecting", attempt: 1, lost: false, lastFailure: "unresponsive" });
});

test("a drop stays marked lost, and a protocol mismatch retries after an update", () => {
  let state = reduceConnection(initialConnection, { type: "connected", authority: "controller" });
  state = reduceConnection(state, { type: "closed", now: 100 });
  expect(state).toEqual({ phase: "dropped", attempt: 1, retryAt: 600, lost: true });
  state = reduceConnection(reduceConnection(state, { type: "attempt" }), { type: "not_running", now: 600 });
  expect(state).toMatchObject({ phase: "not_running", attempt: 2, lost: true });
  state = reduceConnection(reduceConnection(state, { type: "attempt" }), { type: "connected", authority: "controller" });
  expect(state).toEqual({ phase: "connected", authority: "controller" });
  const mismatch = reduceConnection(initialConnection, { type: "incompatible", now: 1_000 });
  expect(mismatch).toEqual({ phase: "incompatible", attempt: 1, retryAt: 1_500, lost: false });
  expect(reduceConnection(mismatch, { type: "attempt" })).toEqual({ phase: "connecting", attempt: 1, lost: false });
});

type Fake = ZetaClient & { drop(): void; closed: boolean };
function fakeClient(): Fake {
  let onClose: ((error: unknown) => void) | undefined;
  const client = {
    closed: false,
    onClose(listener: (error: unknown) => void) { onClose = listener; return () => {}; },
    close() { client.closed = true; },
    drop() { onClose?.(new ZetaError("closed", 1006)); },
  };
  return client as unknown as Fake;
}

function harness(script: Array<() => Promise<ZetaDiscovery | null>>, connects: Array<(role: "controller" | "observer") => Promise<ZetaClient>> = []) {
  let clock = 0;
  const timers: Array<{ at: number; run: () => void }> = [];
  const connection = createConnection({
    origin: ORIGIN,
    discover: () => (script.shift() ?? (() => Promise.resolve(null)))(),
    connect: (_discovery, role) => (connects.shift() ?? (() => Promise.reject(new ZetaError("connect_failed"))))(role),
    now: () => clock,
    setTimer: (run, ms) => { const timer = { at: clock + ms, run }; timers.push(timer); return timer; },
    clearTimer: (timer) => { const index = timers.indexOf(timer as never); if (index >= 0) timers.splice(index, 1); },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const advance = async (ms: number) => {
    clock += ms;
    for (const timer of timers.filter((candidate) => candidate.at <= clock)) { timers.splice(timers.indexOf(timer), 1); timer.run(); }
    await settle();
  };
  return { connection, settle, advance, timers };
}

test("server not running, then started: it connects on the next scheduled try", async () => {
  const client = fakeClient();
  const { connection, settle, advance } = harness([async () => null, async () => found], [async () => client]);
  await settle();
  expect(connection.state).toMatchObject({ phase: "not_running", attempt: 1 });
  await advance(499);
  expect(connection.state.phase).toBe("not_running");
  await advance(1);
  expect(connection.state).toEqual({ phase: "connected", authority: "controller" });
  expect(connection.client).toBe(client);
});

test("an origin missing from the allowlist is named before any socket opens", async () => {
  let opened = false;
  const { connection, settle } = harness([async () => ({ ...found, origins: ["http://localhost:5173"] })], [async () => { opened = true; return fakeClient(); }]);
  await settle();
  expect(connection.state).toMatchObject({ phase: "auth_failed", reason: "origin", origins: ["http://localhost:5173"] });
  expect(opened).toBe(false);
});

test("refused upgrade is auth_failed, two occupied roles reach the observer limit, and version mismatch waits before retrying", async () => {
  const refused = harness([async () => found], [() => Promise.reject(new ZetaError("connect_failed"))]);
  await refused.settle();
  expect(refused.connection.state).toMatchObject({ phase: "auth_failed", reason: "rejected" });
  const busy = harness([async () => found], [() => Promise.reject(new ZetaError("busy")), () => Promise.reject(new ZetaError("busy"))]);
  await busy.settle();
  expect(busy.connection.state.phase).toBe("observer_limit");
  const old = harness([async () => found], [() => Promise.reject(new ZetaError("version_mismatch"))]);
  await old.settle();
  expect(old.connection.state.phase).toBe("incompatible");
  expect(old.timers).toHaveLength(1);
});

test("a refused controller hello retries once as an observer and keeps that authority", async () => {
  const observer = fakeClient();
  const replacement = fakeClient();
  const roles: Array<"controller" | "observer"> = [];
  const { connection, settle, advance } = harness([async () => found, async () => found], [
    async (role) => { roles.push(role); throw new ZetaError("busy", -32001); },
    async (role) => { roles.push(role); return observer; },
    async (role) => { roles.push(role); return replacement; },
  ]);
  await settle();
  expect(roles).toEqual(["controller", "observer"]);
  expect(connection.state).toEqual({ phase: "connected", authority: "observer" });

  observer.drop();
  await advance(500);
  expect(roles).toEqual(["controller", "observer", "observer"]);
  expect(connection.state).toEqual({ phase: "connected", authority: "observer" });
});

test("a refused observer hello waits for an explicit retry", async () => {
  const roles: Array<"controller" | "observer"> = [];
  const { connection, settle, advance, timers } = harness([async () => found, async () => found], [
    async (role) => { roles.push(role); throw new ZetaError("busy", -32001); },
    async (role) => { roles.push(role); throw new ZetaError("busy", -32001); },
    async (role) => { roles.push(role); throw new ZetaError("busy", -32001); },
  ]);
  await settle();
  expect(connection.state).toMatchObject({ phase: "observer_limit" });
  expect(timers).toHaveLength(0);
  await advance(10_000);
  expect(roles).toEqual(["controller", "observer"]);
  connection.retryNow();
  await settle();
  expect(roles).toEqual(["controller", "observer", "observer"]);
});

test("a drop reconnects with a new client, and retryNow skips the wait", async () => {
  const first = fakeClient();
  const second = fakeClient();
  const { connection, settle, advance } = harness([async () => found, async () => null, async () => found], [async () => first, async () => second]);
  await settle();
  first.drop();
  expect(connection.state).toMatchObject({ phase: "dropped", lost: true });
  expect(connection.client).toBeNull();
  await advance(500);
  expect(connection.state).toMatchObject({ phase: "not_running", attempt: 2, lost: true });
  connection.retryNow();
  await settle();
  expect(connection.state.phase).toBe("connected");
  expect(connection.client).toBe(second);
  first.drop(); // a late close from the old socket must not tear down the new one
  expect(connection.state.phase).toBe("connected");
});

test("hello timeout closes its open socket before retrying", async () => {
  let closed = false;
  const connection = createConnection({
    origin: ORIGIN,
    discover: async () => found,
    connect: (_discovery, _role, opened) => { opened?.(() => { closed = true; }); return new Promise(() => {}); },
    helloTimeoutMs: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(closed).toBe(true);
  expect(connection.state.phase).toBe("unresponsive");
  connection.stop();
});

test("stop closes the client and ignores attempts still in flight", async () => {
  let resolve!: (value: ZetaDiscovery | null) => void;
  const { connection, settle } = harness([() => new Promise((done) => { resolve = done; })], [async () => fakeClient()]);
  connection.stop();
  resolve(found);
  await settle();
  expect(connection.state.phase).toBe("connecting");
  expect(connection.client).toBeNull();
});

// The banner's `zeta serve --ws <port>` names the port this page last reached, not a fixed default.
test("port is the last discovered server's port, and stays after the server goes away", async () => {
  const client = fakeClient();
  const { connection, settle, advance } = harness([async () => ({ ...found, url: "ws://127.0.0.1:18765/" }), async () => null], [async () => client]);
  expect(connection.port).toBe(8765);
  await settle();
  expect(connection.port).toBe(18765);
  client.drop();
  await advance(500);
  expect(connection.state.phase).toBe("not_running");
  expect(connection.port).toBe(18765);
  expect(serveCommand("http://localhost:5180", connection.port)).toBe("zeta serve --ws 18765 --ws-origin http://localhost:5180");
});

/**
 * Zeta's hello answer, as zeta 0f29a2b3 builds it: server.py:658-660 accepts the requested features that its FEATURES
 * tuple lists, in that order, and server.py:681-684 echoes them in capabilities.features. protocol.py:234-264 is that
 * tuple (session_replay_seq at :257), so a real zeta grants every listed feature gamma asks for.
 */
const ZETA_FEATURES = ["session_cwd", "new_session_settings", "user_message_event", "user_message_delivery_id", "send_images_delivery_id", "list_sessions_paging", "memory_updated", "live_config_changed", "ping", "assistant_reset", "model_input_ids", "projects", "projects-memory-v2", "abort_scope", "turn_context", "delivery_id", "serve_observers", "approval_history", "approval_reconnect", "session_history_backward", "session_host_commands", "session_history_fidelity", "session_replay_seq", "child_run_history", "served_turn_end", "content_read", "session_grants", "path_completion", "child_runs", "delivery_session_guard", "run_work"];

test("a session opens over the real hello against a zeta that offers session_replay_seq", async () => {
  const session = { session_id: "s1", created_at: "", updated_at: "" };
  const handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
    hello: (params) => ({ protocol_version: "1.2", capabilities: { requests: ["status", "resume", "session_history"], notifications: ["event"], features: ZETA_FEATURES.filter((name) => (params.features as string[]).includes(name)) } }),
    status: () => ({ session: null, state: "idle", pending_approvals: [] }),
    resume: () => ({ session }),
    session_history: () => ({ messages: [{ id: "m1", role: "assistant", content: [{ type: "text", text: "hi" }], tool_result: null }], next_offset: null }),
  };
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => server.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "zeta.v1" } }) ? undefined : new Response("upgrade required", { status: 426 }),
    websocket: {
      message(socket, text) {
        const { id, method, params } = JSON.parse(String(text));
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: handlers[method]!(params ?? {}) }));
      },
    },
  });
  const connection = createConnection({ origin: ORIGIN, discover: async () => ({ ...found, url: `ws://127.0.0.1:${fake.port}/` }) });
  try {
    const deadline = Date.now() + 5_000;
    while (!connection.client && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connection.state.phase).toBe("connected");
    const opened = await openSession(connection.client!, "s1");
    expect(opened.session?.session_id).toBe("s1");
    await opened.complete;
    opened.lease.release();
  } finally {
    connection.stop();
    fake.stop(true);
  }
});
