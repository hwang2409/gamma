import { expect, test } from "bun:test";
import { createDeliveryManager } from "../src/delivery";
import * as RunState from "../src/run-state";
import { createRunStateStore, workspaceRunState, type DraftRunId, type EntryId, type RunId } from "../src/run-state";
import { createSessionManager } from "../src/session";
import { meta, server, source, waitFor, type Handler } from "./zeta-harness";

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
type Zeta = { attached: string | null; created: number; turns: Array<{ session: string; text: string; id?: string }>; accepted: Map<string, Map<string, Record<string, unknown>>>; replies: Array<Record<string, unknown>> };

function zetaHandlers(zeta: Zeta, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    // zeta docs/serve-protocol.md `status`: the attached session, or null.
    status: () => ({ session: zeta.attached ? meta(zeta.attached, "x") : null, state: "idle", pending_approvals: [] }),
    resume: (params) => { zeta.attached = params.session_id as string; return { session: meta(zeta.attached, "x") }; },
    session_history: (params) => {
      const all = rows[params.session_id as string] ?? [];
      const offset = params.offset as number;
      return { messages: all.slice(offset, offset + 1), next_offset: offset + 1 < all.length ? offset + 1 : null };
    },
    new_session: () => { zeta.attached = `n${++zeta.created}`; return { session: meta(zeta.attached, "x") }; },
    // zeta src/zeta/server/delivery.py:48-90: `send` has no session_id param; it targets the attached runtime and
    // returns {accepted, session_id}. delivery.py:383-408 + docs/serve-protocol.md:509-520: a retained id on the same
    // session returns the original result with duplicate:true and starts no turn; the lookup runs before turn checks.
    send: (params) => {
      const session = zeta.attached;
      if (!session) throw { code: -32003, message: "no active session" };
      const id = params.delivery_id as string | undefined;
      const seen = id ? zeta.accepted.get(session)?.get(id) : undefined;
      const reply = seen ? { ...seen, duplicate: true } : { accepted: true, session_id: session };
      if (!seen) {
        zeta.turns.push({ session, text: params.text as string, ...(id ? { id } : {}) });
        if (id) zeta.accepted.set(session, (zeta.accepted.get(session) ?? new Map()).set(id, reply));
      }
      zeta.replies.push(reply);
      return reply;
    },
    ...extra,
  };
}

const FEATURES = ["delivery_id"];

async function world(options: { attached?: string | null; selected?: string; handlers?: (zeta: Zeta) => Record<string, Handler>; offline?: boolean } = {}) {
  const zeta: Zeta = { attached: options.attached ?? null, created: 0, turns: [], accepted: new Map(), replies: [] };
  const handlers = { ...zetaHandlers(zeta), ...options.handlers?.(zeta) };
  const fake = await server(handlers, FEATURES);
  const connection = source(options.offline ? null : fake.client);
  const first = options.selected ?? `draft:${crypto.randomUUID()}`;
  const store = createRunStateStore(8, undefined, undefined, { id: "entry" as EntryId, run: first as RunId });
  const manager = createSessionManager(connection, store);
  const failures = new Map<string, string>();
  const deliveries = createDeliveryManager(() => connection.client, store, manager.execute, manager.abort, (runId, text) => failures.set(store.canonical(runId), text));
  const activate = (id: string) => store.activate(id, id.startsWith("draft:") ? { choice: "default" } : { choice: "explicit", model: "" });
  store.dispatch({ type: "NAVIGATED", entryId: "entry" as EntryId, runId: first as RunId });
  activate(first);
  const run = () => store.getEntry().run as string;
  const h = {
    zeta, fake, store, manager, deliveries, connection, failures,
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
    async enter(runId = run(), text = store.get(runId).text, deliveryId?: string) {
      try { await deliveries.submit(runId, text, false, deliveryId); return { ok: true as const }; }
      catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
    },
    sends() { return fake.calls.filter(([method]) => method === "send").map(([, params]) => params); },
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
    name: "3 route 1: before the first status reply nothing is sent and the draft stays",
    async run() {
      const h = await world({ attached: "b", selected: "a" });
      try {
        const status = h.fake.hold("status");
        h.start(); await status.reached;
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
        h.start(); await held.reached;
        h.select("b");
        const before = h.fake.calls.length;
        held.release();
        await h.live("b");
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
        h.start(); await held.reached;
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
        h.start(); await held.reached;
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
        const status = h.fake.hold("status");
        h.select("a"); await status.reached;
        expect(h.view.open).toBeNull();
        expect(h.view.opening).not.toBeNull();
        expect(h.owner()).toMatchObject({ accept: false, block: "opening" });
        status.release(); await h.live("a");
        h.deliveries.bind("a", h.view.open!.lease.store);
        h.type("after back"); expect(await h.enter()).toEqual({ ok: true });
        expect(h.zeta.turns).toHaveLength(1);
        expect(h.text()).toBe("");
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
        h.start(); await held.reached;
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
        await send.reached;
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
        await created.reached;
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
];

for (const row of table) test(row.name, () => row.run(), 10_000);
