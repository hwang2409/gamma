import { expect, test } from "bun:test";
import { ZetaError, type ZetaClient, type ZetaDiscovery } from "@fulcrum/zeta";
import { backoff, createConnection, initialConnection, reduceConnection, serveCommand, type ConnectionState } from "../src/connection";

const ORIGIN = "http://localhost:5180";
const found: ZetaDiscovery = { url: "ws://127.0.0.1:8765/", token: "secret", origins: [ORIGIN] };

test("backoff doubles from 0.5 s and stops at 10 s", () => {
  expect([1, 2, 3, 4, 5, 6, 9].map(backoff)).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
});

test("a failure only ends an attempt in flight and counts up", () => {
  let state: ConnectionState = initialConnection;
  state = reduceConnection(state, { type: "not_running", now: 0 });
  expect(state).toEqual({ phase: "not_running", attempt: 1, retryAt: 500, lost: false });
  expect(reduceConnection(state, { type: "busy", now: 5 })).toBe(state);
  state = reduceConnection(reduceConnection(state, { type: "attempt" }), { type: "busy", now: 1000 });
  expect(state).toEqual({ phase: "busy", attempt: 2, retryAt: 2000, lost: false });
});

test("a drop after a connection is marked lost until it reconnects, and a mismatch is final", () => {
  let state = reduceConnection(initialConnection, { type: "connected" });
  state = reduceConnection(state, { type: "closed", now: 100 });
  expect(state).toEqual({ phase: "dropped", attempt: 1, retryAt: 600, lost: true });
  state = reduceConnection(reduceConnection(state, { type: "attempt" }), { type: "not_running", now: 600 });
  expect(state).toMatchObject({ phase: "not_running", attempt: 2, lost: true });
  state = reduceConnection(reduceConnection(state, { type: "attempt" }), { type: "connected" });
  expect(state).toEqual({ phase: "connected" });
  const final = reduceConnection(initialConnection, { type: "incompatible" });
  expect(reduceConnection(final, { type: "attempt" })).toBe(final);
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

function harness(script: Array<() => Promise<ZetaDiscovery | null>>, connects: Array<() => Promise<ZetaClient>> = []) {
  let clock = 0;
  const timers: Array<{ at: number; run: () => void }> = [];
  const connection = createConnection({
    origin: ORIGIN,
    discover: () => (script.shift() ?? (() => Promise.resolve(null)))(),
    connect: () => (connects.shift() ?? (() => Promise.reject(new ZetaError("connect_failed"))))(),
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
  expect(connection.state).toEqual({ phase: "connected" });
  expect(connection.client).toBe(client);
});

test("an origin missing from the allowlist is named before any socket opens", async () => {
  let opened = false;
  const { connection, settle } = harness([async () => ({ ...found, origins: ["http://localhost:5173"] })], [async () => { opened = true; return fakeClient(); }]);
  await settle();
  expect(connection.state).toMatchObject({ phase: "auth_failed", reason: "origin", origins: ["http://localhost:5173"] });
  expect(opened).toBe(false);
});

test("refused upgrade is auth_failed, busy is busy, version mismatch stops retrying", async () => {
  const refused = harness([async () => found], [() => Promise.reject(new ZetaError("connect_failed"))]);
  await refused.settle();
  expect(refused.connection.state).toMatchObject({ phase: "auth_failed", reason: "rejected" });
  const busy = harness([async () => found], [() => Promise.reject(new ZetaError("busy"))]);
  await busy.settle();
  expect(busy.connection.state.phase).toBe("busy");
  const old = harness([async () => found], [() => Promise.reject(new ZetaError("version_mismatch"))]);
  await old.settle();
  expect(old.connection.state.phase).toBe("incompatible");
  expect(old.timers).toHaveLength(0);
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
