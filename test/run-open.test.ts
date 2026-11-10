import { expect, test } from "bun:test";
import { createDeliveryManager } from "../src/delivery";
import * as RunState from "../src/run-state";
import { createRunStateStore, workspaceRunState, type DraftRunId, type EntryId, type RunId } from "../src/run-state";
import { createSessionManager } from "../src/session";
import { meta, server, source, waitFor, type Handler, type Hold } from "./zeta-harness";

/**
 * The one table for "which run is open, and can it take input". Each row drives the public factories the app wires
 * (app.tsx: createRunStateStore + createSessionManager + createDeliveryManager) over a real fulcrum client.
 * Base-visible facts (requests, workspaceRunState, draft text, the submit promise) are asserted first; the owner's
 * answer (runInput) is read after them, so an old checkout fails at behavior, not at a missing export.
 */

const rows: Record<string, unknown[]> = {
  a: [{ id: "a1", role: "user", content: [{ type: "text", text: "hello a" }], tool_result: null }, { id: "a2", role: "assistant", content: [{ type: "text", text: "hi" }], tool_result: null }],
  b: [{ id: "b1", role: "user", content: [{ type: "text", text: "hello b" }], tool_result: null }, { id: "b2", role: "assistant", content: [{ type: "text", text: "on it" }], tool_result: null }],
};

/** Zeta's server-side truth: one attached runtime, its accepted delivery ids per session, and every started turn. */
type Zeta = { attached: string | null; created: number; turns: Array<{ session: string; text: string; id?: string }>; accepted: Map<string, Map<string, Record<string, unknown>>>; replies: Array<Record<string, unknown>>; evicted: Set<string>; running?: boolean; steers?: Map<string, { session: string; text: string; status: "queued" | "dropped" }>; lastTurn?: string; history?: Record<string, unknown[]> };
/**
 * zeta ends the running turn: delivery.py:305-312 drops every queued steer (reason turn_end only when the turn completed),
 * and docs/serve-protocol.md:791-808 reports the outcome as status.last_turn_outcome.reason.
 */
const endTurn = (zeta: Zeta, reason: "completed" | "user_stop" | "error" | "disconnect") => {
  for (const steer of zeta.steers?.values() ?? []) if (steer.status === "queued") steer.status = "dropped";
  zeta.running = false; zeta.lastTurn = reason;
};
/** sessionStorage as one browser tab keeps it across a full page back and forward. */
const tabStorage = () => { const items = new Map<string, string>(); return { items, getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) }; };
/** Waits for a state without failing, so the row's next assertion names what did not happen. */
const until = async (check: () => boolean, timeout = 2_000) => { for (const end = Date.now() + timeout; !check() && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 5)); };
/** Bounds every test-controlled request latch and releases the held request when the expected arrival is missing. */
const waitForHold = async (name: string, hold: Hold, timeout = 10_000) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([hold.reached, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${name}`)), timeout); })]);
  } catch (error) {
    hold.release();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * zeta 1bf97c3c protocol.py:560-583 (delivery_session_guard): a send or steer whose session_id is not the attached
 * session is refused with data.code session_mismatch before the delivery_id lookup; nothing is recorded or started.
 */
const guard = (zeta: Zeta, params: Record<string, unknown>) => {
  const session = params.session_id;
  if (typeof session === "string" && zeta.attached && session !== zeta.attached) throw { code: -32003, message: "session is not active", data: { code: "session_mismatch", attached_session_id: zeta.attached, session_id: session } };
};

function zetaHandlers(zeta: Zeta, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    // zeta docs/serve-protocol.md `status`: the attached session, or null.
    // docs/serve-protocol.md:791-808: with served_turn_end (fulcrum always asks for it) status carries last_turn_outcome.
    status: () => ({ session: zeta.attached ? meta(zeta.attached, "x") : null, state: "idle", pending_approvals: [], last_turn_outcome: zeta.lastTurn ? { turn_id: "t", reason: zeta.lastTurn } : null }),
    resume: (params) => { zeta.attached = params.session_id as string; return { session: meta(zeta.attached, "x") }; },
    session_history: (params) => {
      const session = params.session_id as string;
      const all = [...(rows[session] ?? []), ...(zeta.history?.[session] ?? [])];
      const offset = params.offset as number;
      return { messages: all.slice(offset, offset + 1), next_offset: offset + 1 < all.length ? offset + 1 : null };
    },
    new_session: () => { zeta.attached = `n${++zeta.created}`; return { session: meta(zeta.attached, "x") }; },
    // zeta src/zeta/server/delivery.py:48-90: `send` targets the attached runtime (the session_id param only feeds the
    // guard above) and returns {accepted, session_id}. delivery.py:383-408 + docs/serve-protocol.md:509-520: a retained id on the same
    // session returns the original result with duplicate:true and starts no turn; the lookup runs before turn checks.
    send: (params) => {
      guard(zeta, params);
      const session = zeta.attached;
      if (!session) throw { code: -32003, message: "no active session" };
      const id = params.delivery_id as string | undefined;
      // delivery.py:401-407: an id whose details were evicted keeps only its outcome and answers -32010 with it.
      if (id && zeta.evicted.has(id)) throw { code: -32010, message: "delivery id already used", data: { outcome: "delivered" } };
      const seen = id ? zeta.accepted.get(session)?.get(id) : undefined;
      const reply = seen ? { ...seen, duplicate: true } : { accepted: true, session_id: session };
      if (!seen) {
        zeta.turns.push({ session, text: params.text as string, ...(id ? { id } : {}) });
        if (id) zeta.accepted.set(session, (zeta.accepted.get(session) ?? new Map()).set(id, reply));
      }
      zeta.replies.push(reply);
      return reply;
    },
    // delivery.py:48-90 + docs/serve-protocol.md:509-520: a steer needs a running turn (-32005 otherwise), is queued
    // ({accepted: true}, no turn), and a retained id answers its first result with duplicate:true.
    steer: (params) => {
      guard(zeta, params);
      const session = zeta.attached;
      if (!session) throw { code: -32003, message: "no active session" };
      const id = params.delivery_id as string;
      const steers = zeta.steers ??= new Map();
      const seen = steers.get(id);
      if (seen) return seen.status === "dropped" ? { accepted: false, duplicate: true, status: "dropped" } : { accepted: true, duplicate: true };
      if (!zeta.running) throw { code: -32005, message: "no turn is running for steering" };
      steers.set(id, { session, text: params.text as string, status: "queued" });
      return { accepted: true };
    },
    // delivery.py:348-368: the retained status ("delivered" for an accepted send), the outcome of an evicted id, else unknown.
    delivery_status: (params) => {
      const id = params.delivery_id as string;
      const steer = zeta.steers?.get(id);
      if (steer && steer.session === zeta.attached) return { delivery_id: id, status: steer.status };
      if (zeta.evicted.has(id)) return { delivery_id: id, status: "evicted", outcome: "delivered" };
      return { delivery_id: id, status: zeta.attached && zeta.accepted.get(zeta.attached)?.has(id) ? "delivered" : "unknown" };
    },
    ...extra,
  };
}

const FEATURES = ["delivery_id", "delivery_session_guard"];
/** zeta publishes the live dropped-steer delivery_status event (with its reason) only to a controller with this feature. */
const FIDELITY = [...FEATURES, "session_history_fidelity"];

async function world(options: { attached?: string | null; selected?: string; handlers?: (zeta: Zeta) => Record<string, Handler>; offline?: boolean; zeta?: Zeta; tab?: ReturnType<typeof tabStorage>; features?: string[] } = {}) {
  const zeta: Zeta = options.zeta ?? { attached: options.attached ?? null, created: 0, turns: [], accepted: new Map(), replies: [], evicted: new Set() };
  const handlers = { ...zetaHandlers(zeta), ...options.handlers?.(zeta) };
  const features = options.features ?? FEATURES;
  const fake = await server(handlers, features);
  const connection = source(options.offline ? null : fake.client);
  const first = options.selected ?? `draft:${crypto.randomUUID()}`;
  const store = createRunStateStore(8, undefined, options.tab, { id: "entry" as EntryId, run: first as RunId });
  const manager = createSessionManager(connection, store);
  const failures = new Map<string, string>();
  const deliveries = createDeliveryManager(() => connection.client, store, manager.execute, manager.abort, (runId, text) => failures.set(store.canonical(runId), text));
  const activate = (id: string) => store.activate(id, id.startsWith("draft:") ? { choice: "default" } : { choice: "explicit", model: "" });
  store.get(first); // app.tsx: the first render reads the run (restoring its saved draft) before the mount effect navigates
  store.dispatch({ type: "NAVIGATED", entryId: "entry" as EntryId, runId: first as RunId });
  activate(first);
  const run = () => store.getEntry().run as string;
  const h = {
    zeta, fake, store, manager, deliveries, connection, failures, features,
    start() { manager.start(); },
    get view() { return workspaceRunState(store.getCatalog()); },
    /** The owner's answer; read only after the base-visible assertions of a row. */
    owner(runId?: string) { return RunState.runInput(store.getCatalog(), runId as RunId | undefined); },
    run,
    select(id: string) { store.dispatch({ type: "NAVIGATED", entryId: crypto.randomUUID() as EntryId, runId: id as RunId }); activate(id); },
    newRun() { const id = `draft:${crypto.randomUUID()}` as DraftRunId; store.dispatch({ type: "NEW_RUN", entryId: crypto.randomUUID() as EntryId, runId: id }); activate(id); return id; },
    type(text: string, runId = run()) { store.edit(runId, { text }); },
    text(runId = run()) { return store.get(runId).text; },
    /** Enter in the composer of the run on screen, as submitRun does for an existing run. */
    async enter(runId = run(), text = store.get(runId).text, deliveryId?: string, steer = false) {
      try { await deliveries.submit(runId, text, steer, deliveryId); return { ok: true as const }; }
      catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
    },
    sends() { return fake.calls.filter(([method]) => method === "send").map(([, params]) => params); },
    asked() { return fake.calls.filter(([method]) => method === "delivery_status").map(([, params]) => params.delivery_id as string); },
    /** Where zeta started each turn: the session list a row asserts with the turn count. */
    landed() { return zeta.turns.map(({ session }) => session); },
    async live(id: string) { await waitFor(() => workspaceRunState(store.getCatalog()).open?.id === id && store.getCatalog().attachment.kind === "attached" && (store.getCatalog().attachment as { sessionId: string }).sessionId === id, 2_000); },
    dispose() { deliveries.dispose(); store.dispose(); manager.dispose(); },
  };
  return h;
}

const targeted = (calls: Array<[string, Record<string, unknown>]>, id: string) => calls.filter(([, params]) => params.session_id === id).map(([method]) => method);
const PAUSED = "sending is paused until the run opens";

async function openA(options: Parameters<typeof world>[0] = {}) {
  const h = await world({ attached: "a", selected: "a", ...options });
  h.start();
  await h.live("a");
  return h;
}

type Row = { name: string; run(): Promise<void> };

test("canonicalization merges cached full-id deliveries and keeps the current prefix draft", () => {
  const prefix = "abcd" as RunState.SessionId;
  const full = "abcd1234-full-session" as RunState.SessionId;
  const open = "prefix-open" as RunState.OperationId;
  let state: RunState.WorkspaceState = { entry: { id: "entry" as EntryId, run: prefix }, runs: new Map(), aliases: new Map(), attachment: { kind: "detached" } };
  const dispatch = (event: RunState.WorkspaceEvent) => { state = RunState.reduceWorkspace(state, event).state; };
  const delivery = (id: string, text: string, operationId: RunState.OperationId) => ({ id, attemptId: id, operationId, method: "send" as const, text, images: [], state: "requesting" as const });
  dispatch({ type: "ENSURE_RUN", runId: prefix });
  dispatch({ type: "OPEN_REQUEST", runId: prefix, operationId: open });
  dispatch({ type: "COMPOSER_EDIT", runId: prefix, text: "newer prefix draft" });
  dispatch({ type: "DELIVERY_BEGIN", runId: prefix, operationId: "prefix-delivery" as RunState.OperationId, delivery: delivery("shared-delivery", "prefix copy", "prefix-delivery" as RunState.OperationId) });
  dispatch({ type: "ENSURE_RUN", runId: full });
  dispatch({ type: "COMPOSER_EDIT", runId: full, text: "older full-id draft" });
  dispatch({ type: "DELIVERY_BEGIN", runId: full, operationId: "full-delivery" as RunState.OperationId, delivery: delivery("shared-delivery", "canonical copy", "full-delivery" as RunState.OperationId) });
  dispatch({ type: "DELIVERY_BEGIN", runId: full, operationId: "full-only" as RunState.OperationId, delivery: delivery("full-only", "pending full-id message", "full-only" as RunState.OperationId) });
  const target = state.runs.get(full)!;
  state = { ...state, runs: new Map(state.runs).set(full, { ...target, lifecycle: { kind: "open", lease: "old-lease" }, open: { id: full, lease: "old-lease", stale: false, history: { messages: 1, complete: true }, syncing: false } } as RunState.RunRecord) };

  const result = RunState.reduceWorkspace(state, { type: "SESSION_CANONICALIZED", runId: prefix, sessionId: full, operationId: open });
  const canonical = result.state.runs.get(full)!;
  expect(result.state.entry.run).toBe(full);
  expect(canonical.text).toBe("newer prefix draft");
  expect([...canonical.deliveries.keys()]).toEqual(["shared-delivery", "full-only"]);
  expect(canonical.deliveries.get("shared-delivery")?.text).toBe("canonical copy");
  expect(result.effects).toEqual([{ type: "release-lease", runId: full }]);
});

const table: Row[] = [
  {
    name: "1 success: the attached run opens without resume and takes one send",
    async run() {
      const h = await openA();
      try {
        expect(targeted(h.fake.calls, "a")).not.toContain("resume");
        expect(h.owner()).toMatchObject({ accept: true, block: null });
        h.type("hi"); expect(await h.enter()).toEqual({ ok: true });
        expect(h.zeta.turns).toEqual([{ session: "a", text: "hi", id: expect.any(String) }]);
        expect(h.text()).toBe("");
      } finally { h.dispose(); }
    },
  },
  {
    name: "2 success: a detached run resumes, then takes its send",
    async run() {
      const h = await world({ attached: "b", selected: "a" });
      try {
        h.start(); await h.live("a");
        expect(targeted(h.fake.calls, "a").slice(0, 2)).toEqual(["resume", "session_history"]);
        h.type("hi"); expect(await h.enter()).toEqual({ ok: true });
        expect(h.zeta.turns.map(({ session }) => session)).toEqual(["a"]);
      } finally { h.dispose(); }
    },
  },
  {
    name: "2a a prefix resume becomes one canonical run before replay or send",
    async run() {
      const prefix = "abcd";
      const full = "abcd1234-full-session";
      const tab = tabStorage();
      const h = await world({
        attached: "b", selected: prefix, tab,
        handlers: (zeta) => ({
          resume: () => { zeta.attached = full; return { session: meta(full, "x") }; },
          session_history: (params) => ({ messages: rows.a, next_offset: null, seen_session_id: params.session_id }),
        }),
      });
      try {
        h.store.get(full);
        h.type("older full-id draft", full);
        h.type("newer prefix draft");
        h.start(); await waitFor(() => Boolean(h.view.open), 2_000);
        expect(h.run()).toBe(full);
        await h.live(full);
        expect(targeted(h.fake.calls, full)).toContain("session_history");
        expect(targeted(h.fake.calls, prefix)).toEqual(["resume"]);
        expect(h.text(full)).toBe("newer prefix draft");
        expect(h.sends()).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const saved = JSON.parse(tab.items.get("gamma-run-drafts") ?? "{}");
        expect(saved[prefix]).toBeUndefined();
        expect(saved[full]?.text).toBe("newer prefix draft");
        expect(await h.enter()).toEqual({ ok: true });
        expect(h.sends()).toEqual([expect.objectContaining({ session_id: full, text: "newer prefix draft" })]);
        expect(h.zeta.turns.map(({ session }) => session)).toEqual([full]);
      } finally { h.dispose(); }
    },
  },
  {
    name: "2b an ambiguous prefix stays unopened and names its candidate routes",
    async run() {
      const h = await world({
        attached: "b", selected: "abcd",
        handlers: () => ({ resume: () => { throw { code: -32602, message: "session id 'abcd' is ambiguous", data: { code: "session_id_ambiguous", session_id: "abcd", candidates: ["abcd1111", "abcd1111", "abcd2222"] } }; } }),
      });
      try {
        h.type("do not send");
        h.start(); await waitFor(() => Boolean(h.view.openError), 2_000);
        expect(h.view.open).toBeNull();
        expect(h.view.openError).toMatchObject({ id: "abcd", candidates: [{ id: "abcd1111", unique: false }, { id: "abcd2222", unique: true }] });
        expect(h.sends()).toEqual([]);
        expect(h.text()).toBe("do not send");
      } finally { h.dispose(); }
    },
  },
  {
    name: "3 route 1: before the first status reply nothing is sent and the draft stays",
    async run() {
      const h = await world({ attached: "b", selected: "a" });
      try {
        const status = h.fake.hold("status");
        h.start(); await waitForHold("status request", status);
        h.type("typed in the attach window");
        const result = await h.enter();
        expect(h.sends()).toEqual([]);
        expect(result.ok).toBe(false);
        expect(h.text()).toBe("typed in the attach window");
        expect(h.owner()).toMatchObject({ accept: false, block: "opening", open: null });
        expect(RunState.inputBlockText("opening", null)).toBe(PAUSED);
        status.release(); await h.live("a");
        expect(await h.enter()).toEqual({ ok: true });
        expect(h.zeta.turns).toHaveLength(1);
        expect(h.text()).toBe("");
      } finally { h.dispose(); }
    },
  },
  ...([["status", 2], ["resume", 1], ["session_history", 1], ["session_history", 2]] as const).map(([method, nth]): Row => ({
    name: `4 cancel at ${method}#${nth} of A's open: B opens, A sends nothing more`,
    async run() {
      const h = await world({ attached: "b", selected: "a" });
      try {
        const held = h.fake.hold(method, nth);
        h.start(); await waitForHold("held request", held);
        h.select("b");
        const before = h.fake.calls.length;
        held.release();
        await h.live("b");
        await waitFor(() => h.view.open?.history.complete === true, 2_000); // b's open finishes its pages (else: syncing)
        expect(targeted(h.fake.calls.slice(before), "a")).toEqual([]);
        expect(h.store.get("a").openOperation).toBeUndefined();
        expect(h.owner()).toMatchObject({ accept: true, block: null });
      } finally { h.dispose(); }
    },
  })),
  {
    name: "5 cancel by new run: the draft takes input and A is not opened further",
    async run() {
      const h = await world({ attached: "b", selected: "a" });
      try {
        const held = h.fake.hold("resume");
        h.start(); await waitForHold("held request", held);
        h.newRun();
        const before = h.fake.calls.length;
        held.release(); await new Promise((resolve) => setTimeout(resolve, 50));
        expect(targeted(h.fake.calls.slice(before), "a")).toEqual([]);
        expect(h.view.selected).toBeNull();
        expect(h.owner()).toMatchObject({ accept: true, block: null });
      } finally { h.dispose(); }
    },
  },
  {
    name: "6 failure at resume: open-failed, no send, try again resumes again",
    async run() {
      const h = await world({ attached: "b", selected: "a", handlers: () => ({ resume: () => { throw { code: -32602, message: "session log is invalid" }; } }) });
      try {
        h.start(); await waitFor(() => Boolean(h.view.openError), 2_000);
        h.type("keep me");
        expect((await h.enter()).ok).toBe(false);
        expect(h.sends()).toEqual([]);
        expect(h.text()).toBe("keep me");
        expect(h.owner()).toMatchObject({ accept: false, block: "open-failed" });
        h.manager.retryOpen("a");
        await waitFor(() => targeted(h.fake.calls, "a").filter((method) => method === "resume").length === 2, 2_000);
      } finally { h.dispose(); }
    },
  },
  {
    name: "7 failure: resume stays busy through fulcrum's retries",
    async run() {
      const h = await world({ attached: "b", selected: "a", handlers: () => ({ resume: () => { throw { code: -32004, message: "a turn is already running" }; } }) });
      try {
        h.start(); await waitFor(() => Boolean(h.view.openError), 4_000);
        expect(h.view.openError?.busy).toBe(true);
        expect(targeted(h.fake.calls, "a").filter((method) => method === "resume")).toHaveLength(4);
        expect(h.sends()).toEqual([]);
        expect(h.owner()).toMatchObject({ accept: false, block: "open-failed" });
      } finally { h.dispose(); }
    },
  },
  {
    name: "8a failure at the first history page: open-failed, no send",
    async run() {
      const h = await world({ attached: "b", selected: "a", handlers: () => ({ session_history: () => { throw { code: -32602, message: "bad page" }; } }) });
      try {
        h.start(); await waitFor(() => Boolean(h.view.openError), 2_000);
        expect(h.view.open).toBeNull();
        expect(h.owner()).toMatchObject({ accept: false, block: "open-failed" });
      } finally { h.dispose(); }
    },
  },
  {
    name: "8b failure at a later page: transcript kept, input paused",
    async run() {
      const h = await world({ attached: "a", selected: "a", handlers: () => ({ session_history: (params) => { if (params.offset === 1) throw { code: -32602, message: "bad page" }; return { messages: rows.a!.slice(0, 1), next_offset: 1 }; } }) });
      try {
        h.start(); await waitFor(() => Boolean(h.view.openError), 2_000);
        expect(h.view.open?.id).toBe("a");
        expect(h.owner()).toMatchObject({ accept: false, block: "open-failed" });
      } finally { h.dispose(); }
    },
  },
  {
    name: "9 refused hello: no client, offline, no run request",
    async run() {
      const h = await world({ attached: "a", selected: "a", offline: true });
      try {
        h.start();
        expect(h.fake.calls.map(([method]) => method)).toEqual(["hello"]);
        expect(h.owner()).toMatchObject({ accept: false, block: "offline" });
        expect(RunState.inputBlockText("offline", null)).toBe("sending is paused until zeta reconnects");
      } finally { h.dispose(); }
    },
  },
  {
    name: "10 reconnect mid-open: the new client opens the run; the old reply is ignored",
    async run() {
      const h = await world({ attached: "a", selected: "a" });
      try {
        const held = h.fake.hold("session_history");
        h.start(); await waitForHold("held request", held);
        const next = await server(zetaHandlers(h.zeta), FEATURES);
        h.connection.set(next.client);
        expect(h.owner()).toMatchObject({ accept: false });
        await h.live("a");
        const before = h.fake.calls.length;
        held.release(); await new Promise((resolve) => setTimeout(resolve, 30));
        expect(h.fake.calls.length).toBe(before);
        expect(targeted(next.calls, "a")).toContain("session_history");
        expect(h.owner()).toMatchObject({ accept: true });
      } finally { h.dispose(); }
    },
  },
  {
    name: "11 restart with an open run: stale transcript stays, input waits, then one send on the new client",
    async run() {
      const h = await openA();
      try {
        const next = await server(zetaHandlers(h.zeta), FEATURES);
        h.connection.set(next.client);
        expect(h.view.open?.stale).toBe(true);
        expect(h.owner()).toMatchObject({ accept: false, block: "reconnecting" });
        await h.live("a");
        expect(h.view.open?.stale).toBe(false);
        h.type("after restart"); expect(await h.enter()).toEqual({ ok: true });
        expect(next.calls.filter(([method]) => method === "send")).toHaveLength(1);
      } finally { h.dispose(); }
    },
  },
  {
    name: "12 route 3: back during a reopen shows no disposed open and sends once after it opens",
    async run() {
      const h = await openA();
      try {
        h.newRun();
        // The reopen's replay disposes the old store before its first history page.
        const page = h.fake.hold("session_history");
        h.select("a"); await waitForHold("session history request", page);
        expect(h.view.open).toBeNull();
        expect(h.view.opening).not.toBeNull();
        expect(h.owner()).toMatchObject({ accept: false, block: "opening" });
        page.release(); await h.live("a");
        h.deliveries.bind("a", h.view.open!.lease.store);
        h.type("after back"); expect(await h.enter()).toEqual({ ok: true });
        expect(h.zeta.turns).toHaveLength(1);
        expect(h.text()).toBe("");
      } finally { h.dispose(); }
    },
  },
  {
    name: "12b busy reopen: the last transcript stays readable, input is blocked, nothing is sent",
    async run() {
      let busy = false;
      const h = await openA({ handlers: (zeta) => ({ resume: (params) => { if (busy && params.session_id === "a") throw { code: -32004, message: "a turn is already running" }; zeta.attached = params.session_id as string; return { session: meta(zeta.attached, "x") }; } }) });
      try {
        h.select("b"); await h.live("b");
        busy = true;
        h.select("a");
        await waitFor(() => Boolean(h.view.openError), 4_000);
        expect(h.view.openError?.busy).toBe(true);
        expect(h.view.open?.id).toBe("a");
        expect(h.view.open!.lease.store.getOutline().length).toBeGreaterThan(0);
        h.type("not while busy", "a");
        expect((await h.enter("a")).ok).toBe(false);
        expect(h.sends()).toEqual([]);
        expect(h.text("a")).toBe("not while busy");
        expect(h.owner()).toMatchObject({ accept: false, block: "open-failed" });
      } finally { h.dispose(); }
    },
  },
  {
    name: "12c round10 flow: a run selected while another turn runs opens once a later status says the turn ended",
    async run() {
      let running = true;
      const h = await world({ attached: "a", selected: "a", handlers: (zeta) => ({ status: () => ({ session: zeta.attached ? meta(zeta.attached, "x") : null, state: running ? "running" : "idle", pending_approvals: [] }) }) });
      try {
        h.start(); await waitFor(() => h.store.getCatalog().attachment.kind === "attached", 2_000);
        h.select("b");
        await waitFor(() => Boolean(h.view.openError?.busy), 2_000);
        running = false;
        await h.manager.refreshStatus();
        await h.live("b");
        expect(h.view.openError).toBeNull();
        expect(h.owner()).toMatchObject({ accept: true });
      } finally { h.dispose(); }
    },
  },
  {
    name: "13 an accepted send whose echo cannot publish is not a failure; one turn, draft consumed",
    async run() {
      const h = await openA();
      try {
        h.deliveries.bind("a", { hasMessageDelivery: () => false, dispatch() { throw new Error("store is disposed"); }, subscribe: () => () => {} });
        h.type("echo throws");
        const first = await h.enter();
        if (!first.ok && h.text()) await h.enter(); // the user presses Enter again on the kept draft
        expect(h.zeta.turns).toHaveLength(1);
        expect(first).toEqual({ ok: true });
        expect(h.text()).toBe("");
      } finally { h.dispose(); }
    },
  },
  {
    name: "14 double Enter with one id: one turn, the repeat is a zeta duplicate",
    async run() {
      const h = await openA();
      try {
        h.type("twice");
        const results = await Promise.all([h.enter("a", "twice", "web-same"), h.enter("a", "twice", "web-same")]);
        expect(results.every((result) => result.ok)).toBe(true);
        expect(h.zeta.turns).toHaveLength(1);
        expect(h.zeta.replies.map((reply) => reply.duplicate === true)).toEqual([false, true]);
      } finally { h.dispose(); }
    },
  },
  {
    name: "15 A1+A2: a retry after a lost reply reuses the delivery id; zeta answers duplicate and starts no second turn",
    async run() {
      let lost = 0;
      const h = await openA({ handlers: (zeta) => ({ send: (params) => { const reply = zetaHandlers(zeta).send!(params); if (lost++ === 0) throw { code: -32603, message: "connection lost before the reply" }; return reply; } }) });
      try {
        h.type("only once");
        const first = await h.enter();
        expect(first.ok).toBe(false);
        expect(h.run()).toBe("a");
        expect(h.text("a")).toBe("only once");
        expect(await h.enter()).toEqual({ ok: true });
        expect(h.zeta.turns).toHaveLength(1);
        const ids = h.sends().map((params) => params.delivery_id);
        expect(ids).toHaveLength(2);
        expect(ids[1]).toBe(ids[0]);
        expect(h.zeta.replies[1]).toMatchObject({ accepted: true, duplicate: true });
        expect(h.text()).toBe("");
      } finally { h.dispose(); }
    },
  },
  {
    name: "16 a dropped refusal resends with a new id",
    async run() {
      let dropped = 0;
      const h = await openA({ handlers: (zeta) => ({ send: (params) => dropped++ === 0 ? { accepted: false, duplicate: true, status: "dropped" } : zetaHandlers(zeta).send!(params) }) });
      try {
        h.type("again");
        expect((await h.enter()).ok).toBe(false);
        expect(await h.enter()).toEqual({ ok: true });
        const ids = h.sends().map((params) => params.delivery_id);
        expect(ids[1]).not.toBe(ids[0]);
        expect(h.zeta.turns).toHaveLength(1);
      } finally { h.dispose(); }
    },
  },
  {
    name: "17 back and forward during an open: one live A, no send",
    async run() {
      const h = await world({ attached: "b", selected: "a" });
      try {
        const held = h.fake.hold("session_history");
        h.start(); await waitForHold("held request", held);
        h.select("b"); h.select("a");
        held.release();
        await h.live("a");
        expect(targeted(h.fake.calls, "a").filter((method) => method === "resume").length).toBeLessThanOrEqual(2);
        expect(h.sends()).toEqual([]);
        expect(h.owner()).toMatchObject({ accept: true });
      } finally { h.dispose(); }
    },
  },
  {
    name: "18 route 2: selecting B during A's in-flight send opens B once the send settles",
    async run() {
      const h = await openA();
      try {
        const send = h.fake.hold("send");
        h.type("from a");
        const sent = h.enter();
        await waitForHold("send request", send);
        h.select("b");
        send.release();
        expect(await sent).toEqual({ ok: true });
        await h.live("b");
        expect(targeted(h.fake.calls, "b")).toContain("resume");
        expect(h.owner()).toMatchObject({ accept: true });
      } finally { h.dispose(); }
    },
  },
  {
    name: "19 route 2: selecting B during a draft's new_session opens B after the new run's send",
    async run() {
      const h = await world({ attached: null });
      try {
        h.start(); await waitFor(() => h.store.getCatalog().attachment.kind === "detached", 2_000);
        const draft = h.run();
        const created = h.fake.hold("new_session");
        h.type("first message");
        const id = h.manager.create(draft);
        await waitForHold("new session request", created);
        h.select("b");
        created.release();
        const session = await id;
        expect(await h.enter(session, "first message")).toEqual({ ok: true });
        await h.live("b");
        expect(h.zeta.turns.map(({ session: target }) => target)).toEqual([session]);
      } finally { h.dispose(); }
    },
  },
  {
    name: "20 a fresh run: new_session, then one send to the new id",
    async run() {
      const h = await world({ attached: null });
      try {
        h.start(); await waitFor(() => h.store.getCatalog().attachment.kind === "detached", 2_000);
        expect(h.owner()).toMatchObject({ accept: true });
        h.type("hello");
        const session = await h.manager.create(h.run());
        expect(await h.enter(session, "hello")).toEqual({ ok: true });
        expect(h.zeta.turns).toEqual([{ session, text: "hello", id: expect.any(String) }]);
      } finally { h.dispose(); }
    },
  },
  {
    name: "21 executor guard: zeta attached to another run gets nothing; the draft stays with the run on screen",
    async run() {
      const h = await openA();
      try {
        h.zeta.attached = "b";
        await h.manager.refreshStatus();
        h.type("for a only");
        const result = await h.enter();
        expect(h.sends()).toEqual([]);
        expect(result.ok).toBe(false);
        expect(h.text("a")).toBe("for a only");
        expect(h.zeta.turns).toEqual([]);
        expect(result).toEqual({ ok: false, error: "this run is not open yet; your message is still in the draft" });
      } finally { h.dispose(); }
    },
  },
  {
    name: "22 M1 page restore after zeta took the send: the delivered text never comes back as a draft; one turn",
    async run() {
      const tab = tabStorage();
      const page1 = await openA({ tab });
      const send = page1.fake.hold("send");
      page1.type("dup check");
      void page1.enter();
      await waitForHold("send request", send);
      await new Promise((resolve) => setTimeout(resolve, 200)); // the user presses back 200 ms later
      page1.dispose(); // a full page navigation: zeta still takes the send, its reply reaches no page
      send.release(); await waitFor(() => page1.zeta.turns.length === 1, 2_000);
      // Back loads B's page in the same tab; its store saves its own state into the shared sessionStorage.
      const back = await world({ selected: "b", zeta: page1.zeta, tab });
      back.start(); await back.live("b"); back.dispose();
      const page2 = await world({ selected: "a", zeta: page1.zeta, tab });
      try {
        page2.start(); await page2.live("a");
        await waitFor(() => page2.store.get("a").deliveries.size === 0, 2_000);
        expect(page2.text("a")).toBe("");
        if (page2.text("a")) await page2.enter(); // what the user does with a ready draft
        expect(page2.zeta.turns).toHaveLength(1);
        expect(page2.owner()).toMatchObject({ accept: true });
      } finally { page2.dispose(); }
    },
  },
  {
    name: "23 M1 page restore before zeta took the send: the draft comes back with its old id and nothing is sent until Enter; then one turn in a",
    async run() {
      const tab = tabStorage();
      const page1 = await openA({ tab });
      const send = page1.fake.hold("send");
      page1.type("never arrived");
      void page1.enter();
      await waitForHold("send request", send);
      await new Promise((resolve) => setTimeout(resolve, 200));
      page1.dispose();
      send.fail({ code: -32603, message: "the page left before zeta read the frame" });
      const first = page1.sends()[0]!.delivery_id;
      const page2 = await world({ selected: "a", zeta: page1.zeta, tab });
      try {
        page2.start(); await page2.live("a");
        await until(() => page2.asked().includes(first as string), 2_000);
        await until(() => page2.store.get("a").deliveries.size === 0, 2_000);
        expect(page2.sends()).toEqual([]);
        expect(page2.zeta.turns).toEqual([]);
        expect(page2.text("a")).toBe("never arrived");
        expect(await page2.enter()).toEqual({ ok: true });
        expect(page2.sends().map((params) => params.delivery_id)).toEqual([first]);
        expect(page2.landed()).toEqual(["a"]);
        expect(page2.text("a")).toBe("");
      } finally { page2.dispose(); }
    },
  },
  {
    name: "24 M-a a lost reply that landed: after a page restore the open asks the saved id, zeta says delivered, the draft is cleared; one turn in a",
    async run() {
      const tab = tabStorage();
      let lost = 0;
      const page1 = await openA({ tab, handlers: (zeta) => ({ send: (params) => { const reply = zetaHandlers(zeta).send!(params); if (lost++ === 0) throw { code: -32603, message: "connection lost before the reply" }; return reply; } }) });
      page1.type("lost reply");
      expect((await page1.enter()).ok).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 200));
      page1.dispose();
      const page2 = await world({ selected: "a", zeta: page1.zeta, tab });
      try {
        page2.start(); await page2.live("a");
        await until(() => page2.asked().includes(page1.sends()[0]!.delivery_id as string), 2_000);
        await until(() => page2.text("a") === "", 2_000);
        if (page2.text("a")) await page2.enter(); // what the user does with a ready draft
        expect(page2.sends()).toEqual([]);
        expect(page2.landed()).toEqual(["a"]);
        expect(page2.store.get("a").retryDelivery).toBeUndefined();
      } finally { page2.dispose(); }
    },
  },
  {
    name: "25 a retry of an id whose details zeta evicted (-32010 with data.outcome) settles as delivered: one turn, draft cleared",
    async run() {
      let lost = 0;
      const h = await openA({ handlers: (zeta) => ({ send: (params) => { const reply = zetaHandlers(zeta).send!(params); if (lost++ === 0) { zeta.evicted.add(params.delivery_id as string); throw { code: -32603, message: "connection lost before the reply" }; } return reply; } }) });
      try {
        h.type("evicted");
        expect((await h.enter()).ok).toBe(false);
        expect(await h.enter()).toEqual({ ok: true });
        expect(h.zeta.turns).toHaveLength(1);
        expect(h.text()).toBe("");
        expect(h.store.get("a").retryDelivery).toBeUndefined();
      } finally { h.dispose(); }
    },
  },
  {
    name: "26 an image retry whose id zeta evicted (-32010) settles as delivered instead of failing on every Enter",
    async run() {
      let calls = 0;
      const h = await openA({ handlers: (zeta) => ({ send_images: (params) => {
        // delivery.py:383-407 via send_images: the first attempt lands and its reply is lost; the retry finds only the outcome.
        if (calls++ === 0) { zeta.turns.push({ session: zeta.attached!, text: params.text as string, id: params.delivery_id as string }); throw { code: -32603, message: "connection lost before the reply" }; }
        throw { code: -32010, message: "delivery id already used", data: { outcome: "delivered" } };
      } }) });
      try {
        const image = { name: "a.png", mime_type: "image/png", data: "AAAA", url: "blob:a" } as unknown as import("../src/image-queue").QueuedImage;
        h.type("pic");
        const firstId = h.store.deliveryIdFor("a", "pic", [image]);
        expect(await h.manager.sendImages("a", firstId, "pic", [image]).then(() => true, () => false)).toBe(false);
        const retryId = h.store.deliveryIdFor("a", "pic", [image]);
        expect(retryId).toBe(firstId);
        expect(await h.manager.sendImages("a", retryId, "pic", [image]).then(() => true, () => false)).toBe(true);
        expect(h.zeta.turns).toHaveLength(1);
        expect(h.store.get("a").retryDelivery).toBeUndefined();
      } finally { h.dispose(); }
    },
  },
  {
    name: "27 a non-busy open failure retries once when zeta reconnects (base retried on every status)",
    async run() {
      let failPage = true;
      const h = await world({ attached: "a", selected: "a", handlers: (zeta) => ({ session_history: (params) => { if (failPage && params.offset === 1) throw { code: -32602, message: "bad page" }; return zetaHandlers(zeta).session_history!(params); } }) });
      try {
        h.start(); await waitFor(() => Boolean(h.view.openError), 2_000);
        await h.manager.refreshStatus();
        expect(h.view.openError?.message).toBe("bad page"); // a plain status does not retry a real failure
        failPage = false;
        const next = await server(zetaHandlers(h.zeta), FEATURES);
        h.connection.set(next.client);
        await h.live("a");
        expect(h.view.openError).toBeNull();
        expect(h.owner()).toMatchObject({ accept: true });
      } finally { h.dispose(); }
    },
  },
];

for (const row of table) test(row.name, () => row.run(), 10_000);

/** The draft's delivery note as the composer shows it; read after a row's behavior assertions (the owner module is new). */
const noteOf = async (record: RunState.RunRecord) => (await import("../src/delivery-owner").catch(() => null))?.deliveryNote(record) ?? "(no note)";
/** Everything the tab saved, whatever keys hold it. */
const saved = (tab: ReturnType<typeof tabStorage>) => [...tab.items.values()].join("\n");
/** One run's saved entries under every key, to compare before and after another page. */
const savedFor = (tab: ReturnType<typeof tabStorage>, run: string) => [...tab.items].map(([key, value]) => { try { return [key, JSON.parse(value)?.[run] ?? null]; } catch { return [key, null]; } });
const lostReply = (zeta: Zeta, times = 1) => { let lost = 0; return { send: (params: Record<string, unknown>) => { const reply = zetaHandlers(zeta).send!(params); if (lost++ < times) throw { code: -32603, message: "connection lost before the reply" }; return reply; } }; };
/** A steer zeta queued in a's running turn, then the turn ends with `reason`; the app asks on the run's next store event. */
async function steerThenEnd(h: Awaited<ReturnType<typeof world>>, text: string, reason: Parameters<typeof endTurn>[1], ask = true) {
  h.zeta.running = true;
  h.type(text);
  expect(await h.enter("a", text, undefined, true)).toEqual({ ok: true });
  const intent = [...h.store.get("a").deliveries.keys()][0]!;
  expect(h.store.get("a").deliveries.get(intent)?.state).toBe("queued");
  await steerEnds(h, reason, ask);
  return intent;
}
/** zeta ends a's running turn with `reason`, dropping its queued steers; the app asks on the run's next store event. */
async function steerEnds(h: Awaited<ReturnType<typeof world>>, reason: Parameters<typeof endTurn>[1], ask = true) {
  const dropped = [...h.zeta.steers!].filter(([, steer]) => steer.status === "queued").map(([id]) => id);
  endTurn(h.zeta, reason);
  // zeta delivery.py:305-325 (_finalize_turn): each dropped steer's event_contract.delivery_status_row (event_contract.py:11-33,
  // with the drop reason) is published live, but publish_controller sends it only with required_feature="session_history_fidelity".
  const wire = { completed: "turn_end", error: "failed", user_stop: "abort", disconnect: "disconnect" }[reason];
  if (h.features.includes("session_history_fidelity")) for (const id of dropped) h.fake.event({ event: "delivery_status", session_id: "a", id: `delivery-${id}`, role: "system", delivery_id: id, method: "steer", status: "dropped", content: [{ type: "text", text: `steer dropped: ${wire}` }], reason: wire });
  if (ask) h.deliveries.reconcile("a");
}
const QUEUED_IMAGE = { url: "blob:look", name: "look.png", mime_type: "image/png", data: "", size: 1, width: 1, height: 1 };
/** a's running turn with one queued steer, then the user's stop: the steer's row says the stop ended the turn. */
async function stoppedSteer(h: Awaited<ReturnType<typeof world>>, text: string) {
  h.zeta.running = true;
  h.type(text);
  expect(await h.enter("a", text, undefined, true)).toEqual({ ok: true });
  const intent = [...h.store.get("a").deliveries.keys()][0]!;
  await h.deliveries.stop("a");
  await until(() => h.store.get("a").deliveries.get(intent)?.state === "dropped", 2_000);
  expect(h.store.get("a").deliveries.get(intent)?.why).toBe("stop");
  return intent;
}
// zeta docs/serve-protocol.md `abort`: ends the running turn; delivery.py:305-312 drops its queued steers.
const abortable = (zeta: Zeta) => ({ abort: () => { endTurn(zeta, "user_stop"); return {}; } });
const settledSends = async (h: Awaited<ReturnType<typeof world>>, count: number) => { await until(() => h.sends().length >= count, 2_000); await new Promise((resolve) => setTimeout(resolve, 30)); };

/**
 * The delivery owner (src/delivery-owner.ts): one decision for whether and with which id gamma sends. Every row drives
 * the public factories over a real fulcrum client and asserts the fake's turn count and the session each turn landed in.
 */
const owner: Row[] = [
  {
    name: "owner success: the delivery id is saved in the tab before the send leaves; one turn in a",
    async run() {
      const tab = tabStorage();
      const h = await openA({ tab });
      try {
        const send = h.fake.hold("send");
        h.type("hello"); const sent = h.enter();
        const params = await waitForHold("send request", send);
        expect(saved(tab)).toContain(params.delivery_id as string);
        send.release(); expect(await sent).toEqual({ ok: true });
        expect(h.landed()).toEqual(["a"]);
      } finally { h.dispose(); }
    },
  },
  {
    name: "owner lost reply at the raced steer->send fallback: Enter again reuses the id; one turn in a",
    async run() {
      const h = await openA({ handlers: (zeta) => lostReply(zeta) });
      try {
        h.type("raced");
        expect((await h.enter("a", "raced", undefined, true)).ok).toBe(false); // steer -> -32005 -> send, whose reply is lost
        expect(h.text()).toBe("raced");
        expect(await h.enter()).toEqual({ ok: true });
        const ids = h.sends().map((params) => params.delivery_id);
        expect(ids).toEqual([ids[0], ids[0]]);
        expect(h.landed()).toEqual(["a"]);
      } finally { h.dispose(); }
    },
  },
  {
    name: "owner lost reply at delivery_status: nothing changes and nothing is sent; the next ask restores the draft with its id; one turn in a after Enter",
    async run() {
      const tab = tabStorage();
      const page1 = await openA({ tab });
      const send = page1.fake.hold("send");
      page1.type("asked twice"); void page1.enter(); await waitForHold("send request", send);
      page1.dispose(); send.fail({ code: -32603, message: "the page left" });
      const id = page1.sends()[0]!.delivery_id as string;
      const page2 = await world({ selected: "a", zeta: page1.zeta, tab, handlers: (zeta) => { let lost = 0; return { delivery_status: (params) => { if (lost++ === 0) throw { code: -32603, message: "lost" }; return zetaHandlers(zeta).delivery_status!(params); } }; } });
      try {
        page2.start(); await page2.live("a");
        await until(() => page2.asked().length === 1, 2_000); await new Promise((resolve) => setTimeout(resolve, 30));
        expect(page2.sends()).toEqual([]);
        expect(page2.store.get("a").deliveries.size).toBe(1);
        page2.deliveries.reconcile("a");
        await until(() => page2.store.get("a").deliveries.size === 0, 2_000);
        expect(page2.sends()).toEqual([]);
        expect(page2.text()).toBe("asked twice");
        expect(await page2.enter()).toEqual({ ok: true });
        expect(page2.sends().map((params) => params.delivery_id)).toEqual([id]);
        expect(page2.landed()).toEqual(["a"]);
      } finally { page2.dispose(); }
    },
  },
  {
    name: "owner retry after a reload reads the saved id: zeta never took it, the restored draft's Enter sends that id once; one turn in a",
    async run() {
      const tab = tabStorage();
      const page1 = await openA({ tab });
      const send = page1.fake.hold("send");
      page1.type("retry later"); const first = page1.enter(); await waitForHold("send request", send);
      send.fail({ code: -32603, message: "connection lost before the reply" });
      expect((await first).ok).toBe(false);
      const id = page1.sends()[0]!.delivery_id as string;
      page1.dispose();
      const page2 = await world({ selected: "a", zeta: page1.zeta, tab });
      try {
        page2.start(); await page2.live("a");
        await until(() => page2.asked().includes(id), 2_000); await new Promise((resolve) => setTimeout(resolve, 30));
        expect(page2.text()).toBe("retry later");
        expect(page2.sends()).toEqual([]);
        expect(await page2.enter()).toEqual({ ok: true });
        expect(page2.sends().map((params) => params.delivery_id)).toEqual([id]);
        expect(page2.landed()).toEqual(["a"]);
      } finally { page2.dispose(); }
    },
  },
  {
    name: "owner B1 back to another run: a page for b leaves a's saved entry untouched (storage unchanged, no status query, no send); forward restores a's draft; one turn in a",
    async run() {
      const tab = tabStorage();
      const pageA = await world({ attached: "b", selected: "a", tab });
      pageA.start(); await pageA.live("a");
      const send = pageA.fake.hold("send");
      pageA.type("unknown check"); void pageA.enter(); await waitForHold("send request", send);
      pageA.dispose(); send.fail({ code: -32603, message: "the frame never reached zeta" });
      const id = pageA.sends()[0]!.delivery_id as string;
      expect(saved(tab)).toContain(id);
      const beforeA = savedFor(tab, "a");
      // Back: zeta still has a attached when b's page loads, and b's page resumes b.
      const back = await world({ selected: "b", zeta: pageA.zeta, tab });
      try {
        back.start(); await back.live("b"); await new Promise((resolve) => setTimeout(resolve, 50));
        expect(back.sends()).toEqual([]);
        expect(back.asked()).toEqual([]);
        expect(back.zeta.turns).toEqual([]);
        expect(savedFor(tab, "a")).toEqual(beforeA);
      } finally { back.dispose(); }
      const forward = await world({ selected: "a", zeta: pageA.zeta, tab });
      try {
        forward.start(); await forward.live("a");
        await until(() => forward.store.get("a").deliveries.size === 0, 2_000);
        expect(forward.sends()).toEqual([]);
        expect(forward.text()).toBe("unknown check");
        expect(await noteOf(forward.store.get("a"))).toContain("Enter will not run it twice");
        expect(await forward.enter()).toEqual({ ok: true });
        expect(forward.sends().map((params) => params.delivery_id)).toEqual([id]);
        expect(forward.landed()).toEqual(["a"]);
      } finally { forward.dispose(); }
    },
  },
  {
    name: "owner m1 a page back from the bfcache writes only its own runs: a's newer saved draft and id survive b's write",
    async run() {
      const tab = tabStorage();
      const pageB = await world({ attached: "b", selected: "b", tab });
      pageB.start(); await pageB.live("b");
      const pageA = await world({ selected: "a", zeta: pageB.zeta, tab, handlers: (zeta) => lostReply(zeta) });
      try {
        pageA.start(); await pageA.live("a");
        pageA.type("keep me"); expect((await pageA.enter()).ok).toBe(false);
        const id = pageA.sends()[0]!.delivery_id as string;
        pageB.type("b's own draft", "b"); pageB.store.dispatch({ type: "RECONNECT" }); // the restored page's first writes
        expect(saved(tab)).toContain(id);
        expect(pageA.text("a")).toBe("keep me");
        expect(pageB.landed()).toEqual(["a"]);
      } finally { pageA.dispose(); pageB.dispose(); }
    },
  },
  {
    name: "owner reconnect after a lost reply: the reopen asks the saved id, zeta says delivered, the draft clears; one turn in a",
    async run() {
      const h = await openA({ handlers: (zeta) => lostReply(zeta) });
      try {
        h.type("across reconnect"); expect((await h.enter()).ok).toBe(false);
        expect(h.text()).toBe("across reconnect");
        const next = await server(zetaHandlers(h.zeta), FEATURES);
        h.connection.set(next.client);
        await h.live("a");
        await until(() => h.text() === "", 2_000);
        expect(next.calls.filter(([method]) => method === "send")).toEqual([]);
        expect(h.landed()).toEqual(["a"]);
      } finally { h.dispose(); }
    },
  },
  {
    name: "owner duplicate Enter during a lost reply: both use the saved id; one turn in a",
    async run() {
      const h = await openA({ handlers: (zeta) => lostReply(zeta) });
      try {
        h.type("twice"); expect((await h.enter()).ok).toBe(false);
        const results = await Promise.all([h.enter(), h.enter()]);
        expect(results.some((result) => result.ok)).toBe(true);
        expect(new Set(h.sends().map((params) => params.delivery_id)).size).toBe(1);
        expect(h.landed()).toEqual(["a"]);
      } finally { h.dispose(); }
    },
  },
  {
    name: "owner edit before retry: the note says the edit is a new message; Enter sends it with a new id by the user's choice; two turns in a",
    async run() {
      const h = await openA({ handlers: (zeta) => lostReply(zeta) });
      try {
        h.type("first words"); expect((await h.enter()).ok).toBe(false);
        expect(await noteOf(h.store.get("a"))).toContain("Enter will not run it twice");
        h.type("first words, edited");
        expect(await noteOf(h.store.get("a"))).toBe("edited · Enter sends this as a new message");
        expect(await h.enter()).toEqual({ ok: true });
        const ids = h.sends().map((params) => params.delivery_id);
        expect(ids[1]).not.toBe(ids[0]);
        expect(h.landed()).toEqual(["a", "a"]);
      } finally { h.dispose(); }
    },
  },
  {
    name: "owner (a)+(d) a steer dropped at a natural turn end is resent once automatically, with a new id saved before the send; one turn in a",
    async run() {
      const tab = tabStorage();
      const h = await openA({ tab, features: FIDELITY });
      try {
        const send = h.fake.hold("send");
        const intent = await steerThenEnd(h, "late steer", "completed");
        const params = await waitForHold("send request", send);
        expect(params.delivery_id).not.toBe(intent);
        expect(saved(tab)).toContain(params.delivery_id as string);
        send.release(); await settledSends(h, 1);
        expect(h.landed()).toEqual(["a"]);
      } finally { h.dispose(); }
    },
  },
  {
    name: "owner reconnect: a turn_end drop reported live after reconnect is not resent automatically; the button sends one new id into the same run",
    async run() {
      const h = await openA({ features: FIDELITY });
      let status: Hold | undefined;
      try {
        h.zeta.running = true;
        h.type("reconnected turn-end steer");
        expect(await h.enter("a", "reconnected turn-end steer", undefined, true)).toEqual({ ok: true });
        const intent = [...h.store.get("a").deliveries.keys()][0]!;
        h.connection.set(null);
        endTurn(h.zeta, "completed");
        const next = await server(zetaHandlers(h.zeta), FIDELITY);
        status = next.hold("delivery_status");
        h.connection.set(next.client);
        await h.live("a");
        await waitForHold("reconnect status request", status);
        // Zeta delivery.py:305-325 publishes the durable terminal row with its turn_end reason.
        next.event({ event: "delivery_status", session_id: "a", id: `delivery-${intent}`, role: "system", delivery_id: intent, method: "steer", status: "dropped", content: [{ type: "text", text: "steer dropped: turn_end" }], reason: "turn_end" });
        status.release();
        await until(() => next.calls.some(([method]) => method === "send") || h.store.get("a").deliveries.get(intent)?.state === "dropped", 2_000);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(next.calls.filter(([method]) => method === "send")).toEqual([]);
        h.deliveries.resend("a", intent);
        await until(() => h.landed().length === 1, 2_000);
        const sends = next.calls.filter(([method]) => method === "send").map(([, params]) => params);
        expect(sends).toHaveLength(1);
        expect(sends[0]).toMatchObject({ session_id: "a", text: "reconnected turn-end steer" });
        expect(sends[0]!.delivery_id).not.toBe(intent);
        expect(h.landed()).toEqual(["a"]);
      } finally { status?.release(); h.dispose(); }
    },
  },
  {
    name: "owner reconnect: a steer dropped at turn_end while offline is not resent automatically; the button sends one new id into the same run",
    async run() {
      const tab = tabStorage();
      const h = await openA({ tab, features: FIDELITY });
      try {
        h.zeta.running = true;
        h.type("offline turn-end steer");
        expect(await h.enter("a", "offline turn-end steer", undefined, true)).toEqual({ ok: true });
        const intent = [...h.store.get("a").deliveries.keys()][0]!;
        h.connection.set(null);
        endTurn(h.zeta, "completed");
        // Zeta delivery.py:305-325 and history_projection.py persist this terminal row before a later reopen reads it.
        h.zeta.history = { a: [{ id: `delivery-${intent}`, role: "system", event: "delivery_status", delivery_id: intent, method: "steer", status: "dropped", content: [{ type: "text", text: "steer dropped: turn_end" }], reason: "turn_end" }] };
        const next = await server(zetaHandlers(h.zeta), FIDELITY);
        h.connection.set(next.client);
        await h.live("a");
        await until(() => h.store.get("a").deliveries.get(intent)?.state === "dropped" || next.calls.some(([method]) => method === "send"), 2_000);
        expect(next.calls.filter(([method]) => method === "send")).toEqual([]);
        expect(h.store.get("a").deliveries.get(intent)).toMatchObject({ state: "dropped", why: "dropped" });
        h.deliveries.resend("a", intent);
        await until(() => h.landed().length === 1, 2_000);
        const sends = next.calls.filter(([method]) => method === "send").map(([, params]) => params);
        expect(sends).toHaveLength(1);
        expect(sends[0]).toMatchObject({ session_id: "a", text: "offline turn-end steer" });
        expect(sends[0]!.delivery_id).not.toBe(intent);
        expect(saved(tab)).toContain(sends[0]!.delivery_id as string);
        expect(h.landed()).toEqual(["a"]);
      } finally { h.dispose(); }
    },
  },
  ...(["user_stop", "error", "disconnect"] as const).map((reason): Row => ({
    name: `owner (a) a steer dropped by a turn that ended with ${reason} is not resent; the resend button sends it once; one turn in a`,
    async run() {
      const h = await openA({ features: FIDELITY });
      try {
        const intent = await steerThenEnd(h, `dropped by ${reason}`, reason);
        await until(() => h.store.get("a").deliveries.get(intent)?.state === "dropped", 2_000); await new Promise((resolve) => setTimeout(resolve, 30));
        expect(h.sends()).toEqual([]);
        expect(h.zeta.turns).toEqual([]);
        h.deliveries.resend("a", intent); await settledSends(h, 1);
        expect(h.sends()[0]!.delivery_id).not.toBe(intent);
        expect(h.landed()).toEqual(["a"]);
      } finally { h.dispose(); }
    },
  })),
  {
    name: "owner (b) after a reload a steer dropped at a natural turn end is not resent automatically; the button resends it; one turn in a",
    async run() {
      const tab = tabStorage();
      const page1 = await openA({ tab, features: FIDELITY });
      const intent = await steerThenEnd(page1, "steer before reload", "completed", false);
      page1.dispose();
      const page2 = await world({ selected: "a", zeta: page1.zeta, tab, features: FIDELITY });
      try {
        page2.start(); await page2.live("a");
        await until(() => page2.store.get("a").deliveries.get(intent)?.state === "dropped", 2_000); await new Promise((resolve) => setTimeout(resolve, 30));
        expect(page2.sends()).toEqual([]);
        expect(page2.zeta.turns).toEqual([]);
        page2.deliveries.resend("a", intent); await settledSends(page2, 1);
        expect(page2.landed()).toEqual(["a"]);
      } finally { page2.dispose(); }
    },
  },
  {
    name: "owner (b) leaving the run in-app and coming back ends the automatic resend: no send, the row waits for the button; zero turns",
    async run() {
      const h = await openA({ features: FIDELITY });
      try {
        const intent = await steerThenEnd(h, "steer then leave", "completed", false);
        h.select("b"); await h.live("b"); h.select("a"); await h.live("a");
        h.deliveries.reconcile("a");
        await until(() => h.store.get("a").deliveries.get(intent)?.state === "dropped", 2_000); await new Promise((resolve) => setTimeout(resolve, 30));
        expect(h.sends()).toEqual([]);
        expect(h.zeta.turns).toEqual([]);
      } finally { h.dispose(); }
    },
  },
  {
    name: "owner (c) zeta attaches another run while the status answer is on its way: no automatic send; zero turns",
    async run() {
      const h = await openA({ features: FIDELITY });
      try {
        const status = h.fake.hold("delivery_status");
        const intent = await steerThenEnd(h, "steer, then b attaches", "completed");
        await waitForHold("status request", status);
        const reopen = h.fake.hold("resume"); // gamma's reopen of a waits, so zeta keeps b attached when it answers
        h.zeta.attached = "b"; await h.manager.refreshStatus(); await waitForHold("resume request", reopen);
        status.release(); await new Promise((resolve) => setTimeout(resolve, 50));
        expect(h.sends()).toEqual([]);
        expect(h.zeta.turns).toEqual([]);
        expect(h.store.get("a").deliveries.get(intent)?.state).toBe("queued");
        reopen.release();
      } finally { h.dispose(); }
    },
  },
  {
    name: "owner (c) row 2: a resend while zeta has another run attached sends nothing, keeps the row, and says why; zero turns",
    async run() {
      const h = await openA();
      try {
        const intent = await steerThenEnd(h, "stopped steer", "user_stop");
        await until(() => h.store.get("a").deliveries.get(intent)?.state === "dropped", 2_000);
        h.zeta.attached = "b"; await h.manager.refreshStatus();
        h.deliveries.resend("a", intent); await new Promise((resolve) => setTimeout(resolve, 30));
        expect(h.sends()).toEqual([]);
        expect(h.zeta.turns).toEqual([]);
        expect(h.store.get("a").deliveries.get(intent)?.state).toBe("dropped");
        // The message lives as its row, so the row says why the resend did not go; the composer keeps its own hint.
        expect(h.store.get("a").deliveries.get(intent)?.failure).toBe("not sent: zeta has another run attached. resend once this run reopens");
        expect(await noteOf(h.store.get("a"))).toBe("(no note)");
      } finally { h.dispose(); }
    },
  },
  ...([
    ["fails", (zeta: Zeta) => ({ send: () => { throw { code: -32602, message: "invalid params" }; } }), "dropped"],
    ["gets unknown", (zeta: Zeta) => ({ send: () => { throw { code: -32603, message: "the frame never reached zeta" }; } }), "unconfirmed"],
    ["is dropped", (zeta: Zeta) => ({ send: () => ({ accepted: false, duplicate: true, status: "dropped" }) }), "dropped"],
  ] as const).map(([how, handlers, why]): Row => ({
    name: `owner one automatic resend at most: when it ${how}, the row waits for the button; one send, zero turns`,
    async run() {
      let failing = true;
      const h = await openA({ features: FIDELITY, handlers: (zeta) => ({ send: (params) => failing ? (handlers(zeta).send as (params: Record<string, unknown>) => unknown)(params) : zetaHandlers(zeta).send!(params) }) });
      try {
        const intent = await steerThenEnd(h, `auto resend ${how}`, "completed");
        await until(() => h.store.get("a").deliveries.get(intent)?.state === "dropped" && h.sends().length === 1, 2_000);
        h.deliveries.reconcile("a"); await new Promise((resolve) => setTimeout(resolve, 50));
        expect(h.sends()).toHaveLength(1);
        expect(h.zeta.turns).toEqual([]);
        expect(h.store.get("a").deliveries.get(intent)).toMatchObject({ state: "dropped", why });
        failing = false;
        h.deliveries.resend("a", intent); await settledSends(h, 2);
        expect(h.landed()).toEqual(["a"]);
      } finally { h.dispose(); }
    },
  })),
  {
    name: "owner MJ1 turn-end steer -> automatic resend -> lost reply -> reload -> explicit resend reuses the saved id; one turn in a",
    async run() {
      const tab = tabStorage();
      const page1 = await openA({ tab, features: FIDELITY, handlers: (zeta) => lostReply(zeta) });
      const intent = await steerThenEnd(page1, "mj1 steer", "completed");
      await until(() => page1.store.get("a").deliveries.get(intent)?.state === "dropped", 2_000);
      const resent = page1.sends()[0]!.delivery_id as string;
      expect(resent).not.toBe(intent);
      page1.dispose();
      const page2 = await world({ selected: "a", zeta: page1.zeta, tab, handlers: (zeta) => ({ delivery_status: () => { throw { code: -32603, message: "lost" }; } }) });
      try {
        page2.start(); await page2.live("a"); await new Promise((resolve) => setTimeout(resolve, 30));
        expect(page2.sends()).toEqual([]);
        page2.deliveries.resend("a", intent); await settledSends(page2, 1);
        expect(page2.sends().map((params) => params.delivery_id)).toEqual([resent]);
        expect(page2.landed()).toEqual(["a"]);
      } finally { page2.dispose(); }
    },
  },
  {
    name: "owner m-a without session_history_fidelity zeta sends no drop reason: a steer dropped at a completed turn waits for the button (status says completed); 0 automatic sends, then one turn in a",
    async run() {
      const h = await openA();
      try {
        const intent = await steerThenEnd(h, "no reason known", "completed");
        await until(() => h.store.get("a").deliveries.get(intent)?.state === "dropped" || h.sends().length > 0, 2_000); await new Promise((resolve) => setTimeout(resolve, 50));
        expect(h.sends()).toEqual([]);
        expect(h.zeta.turns).toEqual([]);
        expect(h.store.get("a").deliveries.get(intent)?.state).toBe("dropped");
        h.deliveries.resend("a", intent); await settledSends(h, 1);
        expect(h.landed()).toEqual(["a"]);
      } finally { h.dispose(); }
    },
  },
  {
    name: "owner m-a the rule reads this steer's drop reason, not the last turn: dropped by a failed turn, then a later turn completed; 0 automatic sends",
    async run() {
      const h = await openA({ features: FIDELITY });
      try {
        const intent = await steerThenEnd(h, "dropped by a failure", "error", false);
        h.zeta.lastTurn = "completed"; // a newer turn completed before gamma asked
        h.deliveries.reconcile("a");
        await until(() => h.store.get("a").deliveries.get(intent)?.state === "dropped" || h.sends().length > 0, 2_000); await new Promise((resolve) => setTimeout(resolve, 50));
        expect(h.sends()).toEqual([]);
        expect(h.zeta.turns).toEqual([]);
      } finally { h.dispose(); }
    },
  },
  {
    name: "owner B-1 a page back from the bfcache is a new page life: its steer dropped at a natural turn end is not resent by itself; the button sends it; one turn in a",
    async run() {
      const h = await openA({ features: FIDELITY });
      try {
        h.zeta.running = true;
        h.type("steer before back-forward");
        expect(await h.enter("a", "steer before back-forward", undefined, true)).toEqual({ ok: true });
        const intent = [...h.store.get("a").deliveries.keys()][0]!;
        h.store.dispatch({ type: "PAGE_RESTORED" } as RunState.WorkspaceEvent); // app.tsx: pageshow with event.persisted
        await steerEnds(h, "completed");
        await until(() => h.store.get("a").deliveries.get(intent)?.state === "dropped" || h.sends().length > 0, 2_000); await new Promise((resolve) => setTimeout(resolve, 50));
        expect(h.sends()).toEqual([]);
        expect(h.zeta.turns).toEqual([]);
        h.deliveries.resend("a", intent); await settledSends(h, 1);
        expect(h.landed()).toEqual(["a"]);
      } finally { h.dispose(); }
    },
  },
  {
    name: "owner m-b a blocked Enter keeps the draft's inherited retry id: after a lost reply landed, zeta attaches b, Enter is blocked, then Enter in a dedupes; one turn in a",
    async run() {
      // The reopen's delivery_status reply is lost too, so only the kept retry id can dedupe the next Enter.
      const h = await openA({ handlers: (zeta) => ({ ...lostReply(zeta), delivery_status: () => { throw { code: -32603, message: "lost" }; } }) });
      try {
        h.type("keep my id"); expect((await h.enter()).ok).toBe(false); // zeta took it; the reply was lost
        const id = h.sends()[0]!.delivery_id as string;
        const reopen = h.fake.hold("resume"); // zeta keeps b attached while gamma waits to reopen a
        h.zeta.attached = "b"; await h.manager.refreshStatus(); await waitForHold("resume request", reopen);
        expect((await h.enter()).ok).toBe(false);
        expect(h.sends()).toHaveLength(1);
        reopen.release(); await h.live("a");
        expect(await h.enter()).toEqual({ ok: true });
        expect(h.sends().map((params) => params.delivery_id)).toEqual([id, id]);
        expect(h.landed()).toEqual(["a"]);
      } finally { h.dispose(); }
    },
  },
  {
    name: "owner m-c two pages of one tab hold run a: the older page writes only entries it changed, so the newer page's draft for a survives",
    async run() {
      const tab = tabStorage();
      const older = await world({ selected: "a", tab, offline: true });
      const newer = await world({ selected: "a", tab, offline: true });
      try {
        older.type("older draft"); await new Promise((resolve) => setTimeout(resolve, 150));
        newer.type("newer draft"); await new Promise((resolve) => setTimeout(resolve, 150));
        expect(saved(tab)).toContain("newer draft");
        older.type("older's own b", "b"); older.store.dispatch({ type: "RECONNECT" }); // the older page's next writes
        expect(saved(tab)).toContain("newer draft");
        expect(saved(tab)).not.toContain("older draft");
      } finally { older.dispose(); newer.dispose(); }
    },
  },
  {
    name: "owner session guard: zeta attached b behind gamma's back; the send names a, zeta refuses it (session_mismatch), the draft goes back to a with its id and the note, 0 turns; after a reopens, Enter lands once in a",
    async run() {
      const h = await openA();
      try {
        h.zeta.attached = "b"; // another client attached b; gamma has not heard yet
        h.type("only for a");
        expect((await h.enter()).ok).toBe(false);
        expect(h.zeta.turns).toEqual([]);
        expect(h.text("a")).toBe("only for a");
        const id = h.fake.calls.filter(([method]) => method === "send").map(([, params]) => params.delivery_id)[0] as string;
        expect(h.fake.calls.filter(([method]) => method === "send")).toHaveLength(1);
        expect(await noteOf(h.store.get("a"))).toContain("nothing was sent");
        await h.manager.refreshStatus(); await h.live("a");
        expect(await h.enter()).toEqual({ ok: true });
        expect(h.sends().map((params) => params.delivery_id)).toEqual([id, id]);
        expect(h.landed()).toEqual(["a"]);
      } finally { h.dispose(); }
    },
  },
];

const fix3: Row[] = [
  {
    name: "fix3 ux-m1 a session_mismatch note tells the user to reopen this run (gamma neither reopens nor retries by itself)",
    async run() {
      const h = await openA();
      try {
        h.zeta.attached = "b";
        h.type("only for a");
        expect((await h.enter()).ok).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(h.sends()).toHaveLength(1);
        expect(targeted(h.fake.calls, "a")).not.toContain("resume");
        expect(await noteOf(h.store.get("a"))).toContain("reopen this run");
      } finally { h.dispose(); }
    },
  },
  {
    name: "fix3 M3 a session_mismatch refusal survives a reload as 'nothing was sent', not 'this may already be sent' (zeta answers unknown for the id)",
    async run() {
      const tab = tabStorage();
      const page1 = await openA({ tab });
      page1.zeta.attached = "b";
      page1.type("only for a");
      expect((await page1.enter()).ok).toBe(false);
      const id = page1.sends()[0]!.delivery_id as string;
      await new Promise((resolve) => setTimeout(resolve, 150)); // the tab save
      page1.dispose();
      const page2 = await world({ selected: "a", zeta: page1.zeta, tab });
      try {
        page2.start(); await page2.live("a");
        await until(() => page2.asked().includes(id)); await new Promise((resolve) => setTimeout(resolve, 30));
        expect(page2.asked()).toContain(id); // zeta answers unknown: it never recorded this id
        expect(page2.sends()).toEqual([]);
        expect(page2.text("a")).toBe("only for a");
        const note = await noteOf(page2.store.get("a"));
        expect(note).not.toContain("may already be sent");
        expect(note).toContain("nothing was sent");
        expect(await page2.enter()).toEqual({ ok: true });
        expect(page2.sends().map((params) => params.delivery_id)).toEqual([id]);
        expect(page2.landed()).toEqual(["a"]);
      } finally { page2.dispose(); }
    },
  },
  {
    name: "fix3 M3 guard: a refusal of an id an earlier attempt may have delivered stays 'this may already be sent' after a reload",
    async run() {
      const tab = tabStorage();
      const page1 = await openA({ tab, handlers: (zeta) => lostReply(zeta) });
      page1.type("maybe sent");
      expect((await page1.enter()).ok).toBe(false); // zeta took it; the reply was lost
      page1.zeta.attached = "b";
      expect((await page1.enter()).ok).toBe(false); // the same id, refused by the guard
      expect(page1.sends()).toHaveLength(2);
      await new Promise((resolve) => setTimeout(resolve, 150));
      page1.dispose();
      const page2 = await world({ selected: "a", zeta: page1.zeta, tab, handlers: () => ({ delivery_status: () => { throw { code: -32603, message: "lost" }; } }) });
      try {
        page2.start(); await page2.live("a"); await new Promise((resolve) => setTimeout(resolve, 30));
        expect(page2.text("a")).toBe("maybe sent");
        expect(await noteOf(page2.store.get("a"))).toContain("this may already be sent");
      } finally { page2.dispose(); }
    },
  },
  {
    name: "fix3 M2 a session_mismatch on a resend click: the row keeps its reason and says why, the composer keeps its hint, one request, no retry",
    async run() {
      const h = await openA({ handlers: abortable });
      try {
        const intent = await stoppedSteer(h, "stopped then mismatched");
        h.zeta.attached = "b"; // another client attached b; gamma has not heard yet
        h.deliveries.resend("a", intent); await settledSends(h, 1); await new Promise((resolve) => setTimeout(resolve, 100));
        expect(h.sends()).toHaveLength(1);
        expect(h.zeta.turns).toEqual([]);
        const row = h.store.get("a").deliveries.get(intent);
        expect(row?.state).toBe("dropped");
        expect(row?.why).toBe("stop");
        expect(row?.failure).toBe("not sent: zeta had another run attached. reopen this run and resend");
        expect(h.text("a")).toBe("");
        expect(await noteOf(h.store.get("a"))).toBe("(no note)");
      } finally { h.dispose(); }
    },
  },
  {
    name: "fix3 ux-m2 a resend click zeta answers with a definite error: the row keeps its reason and says 'resend failed: <reason>'; no retry",
    async run() {
      let failing = true;
      const h = await openA({ handlers: (zeta) => ({ ...abortable(zeta), send: (params) => { if (failing) throw { code: -32602, message: "invalid params" }; return zetaHandlers(zeta).send!(params); } }) });
      try {
        const intent = await stoppedSteer(h, "stopped then failed");
        h.deliveries.resend("a", intent); await settledSends(h, 1); await new Promise((resolve) => setTimeout(resolve, 100));
        expect(h.sends()).toHaveLength(1);
        const row = h.store.get("a").deliveries.get(intent);
        expect(row?.state).toBe("dropped");
        expect(row?.why).toBe("stop");
        expect(row?.failure).toBe("resend failed: invalid params");
        failing = false;
        h.deliveries.resend("a", intent); await settledSends(h, 2);
        expect(h.landed()).toEqual(["a"]);
        expect(h.store.get("a").deliveries.get(intent)?.failure).toBeUndefined();
      } finally { h.dispose(); }
    },
  },
  {
    name: "fix3 ux-m5 the new-run note names the active run by its title, not its session id",
    async run() {
      const h = await world({ attached: "b", handlers: (zeta) => ({ status: () => ({ session: meta("b", "x", { name: "the b run" }), state: "running", pending_approvals: [], last_turn_outcome: null }) }) });
      try {
        h.start(); await until(() => h.view.active === "b");
        expect(h.view.active).toBe("b");
        expect(RunState.inputBlockText("waits-for-active", (h.view as { activeTitle?: string | null }).activeTitle ?? null)).toBe("sending waits for the active run the b run");
        expect(h.owner().block).toBe("waits-for-active");
      } finally { h.dispose(); }
    },
  },
  {
    name: "fix3 review-m-1 -32003 with data.code host_binding_required is a generic failure, not the session_mismatch note",
    async run() {
      const h = await openA({ handlers: () => ({ send: () => { throw { code: -32003, message: "host binding required", data: { code: "host_binding_required" } }; } }) });
      try {
        h.type("needs a binding");
        expect(await h.enter()).toEqual({ ok: false, error: "host binding required" });
        expect(h.sends()).toHaveLength(1);
        expect(h.text("a")).toBe("needs a binding");
        expect(await noteOf(h.store.get("a"))).not.toContain("another run attached");
      } finally { h.dispose(); }
    },
  },
  {
    name: "fix3 review-m-1 a send_images session_mismatch: note, draft and attachments kept, one request, no retry",
    async run() {
      // zeta serve-protocol.md send_images under delivery_session_guard: the same guard as send (protocol.py:560-583).
      const h = await openA({ handlers: (zeta) => ({ send_images: (params) => { guard(zeta, params); zeta.turns.push({ session: zeta.attached!, text: params.text as string }); return { accepted: true }; } }) });
      try {
        h.zeta.attached = "b";
        h.store.edit("a", { text: "look at this", attachments: [QUEUED_IMAGE as never] });
        const failed = await h.manager.sendImages("a", "img-1", "look at this", [QUEUED_IMAGE as never]).then(() => null, (error: Error) => error.message);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(h.fake.calls.filter(([method]) => method === "send_images")).toHaveLength(1);
        expect(h.zeta.turns).toEqual([]);
        expect(failed).toContain("nothing was sent");
        expect(h.text("a")).toBe("look at this");
        expect(h.store.get("a").attachments).toHaveLength(1);
        expect(await noteOf(h.store.get("a"))).toContain("nothing was sent");
      } finally { h.dispose(); }
    },
  },
  {
    name: "fix3 review-m-2 an opaque send {input_id} session_mismatch takes the same note path: no command failure, draft back, one request",
    async run() {
      const h = await openA();
      try {
        h.zeta.attached = "b";
        h.type("/review x");
        const failed = await h.deliveries.submitOpaque("a", "input-1", "/review x", "/review x", "op-1").then(() => null, (error: Error) => error.message);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(h.sends()).toHaveLength(1);
        expect(h.sends()[0]).toMatchObject({ input_id: "input-1", session_id: "a" });
        expect(h.failures.get("a")).toBeUndefined();
        expect(failed).toContain("nothing was sent");
        expect(h.text("a")).toBe("/review x");
        expect(await noteOf(h.store.get("a"))).toContain("nothing was sent");
      } finally { h.dispose(); }
    },
  },
  {
    name: "fix3 review-m-3 a send_images blocked before it leaves gamma keeps the draft's id with a note, like handleDelivery",
    async run() {
      const h = await openA();
      try {
        const reopen = h.fake.hold("resume"); // gamma knows zeta attached b and waits to reopen a
        h.zeta.attached = "b"; await h.manager.refreshStatus(); await waitForHold("resume request", reopen);
        h.store.edit("a", { text: "look at this", attachments: [QUEUED_IMAGE as never] });
        const failed = await h.manager.sendImages("a", "img-2", "look at this", [QUEUED_IMAGE as never]).then(() => null, (error: Error) => error.message);
        expect(h.fake.calls.filter(([method]) => method === "send_images")).toEqual([]);
        expect(failed).toContain("not open yet");
        expect(h.text("a")).toBe("look at this");
        expect(await noteOf(h.store.get("a"))).toContain("not open yet");
        expect(h.store.get("a").retryDelivery?.id).toBe("img-2");
        reopen.release();
      } finally { h.dispose(); }
    },
  },
];

for (const row of owner) test(row.name, () => row.run(), 10_000);
for (const row of fix3) test(row.name, () => row.run(), 10_000);
