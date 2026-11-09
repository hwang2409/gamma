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
type Zeta = { attached: string | null; created: number; turns: Array<{ session: string; text: string; id?: string }>; accepted: Map<string, Map<string, Record<string, unknown>>>; replies: Array<Record<string, unknown>>; evicted: Set<string> };
/** sessionStorage as one browser tab keeps it across a full page back and forward. */
const tabStorage = () => { const items = new Map<string, string>(); return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) }; };

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
    // delivery.py:348-368: the retained status ("delivered" for an accepted send), the outcome of an evicted id, else unknown.
    delivery_status: (params) => {
      const id = params.delivery_id as string;
      if (zeta.evicted.has(id)) return { delivery_id: id, status: "evicted", outcome: "delivered" };
      return { delivery_id: id, status: zeta.attached && zeta.accepted.get(zeta.attached)?.has(id) ? "delivered" : "unknown" };
    },
    ...extra,
  };
}

const FEATURES = ["delivery_id"];

async function world(options: { attached?: string | null; selected?: string; handlers?: (zeta: Zeta) => Record<string, Handler>; offline?: boolean; zeta?: Zeta; tab?: ReturnType<typeof tabStorage> } = {}) {
  const zeta: Zeta = options.zeta ?? { attached: options.attached ?? null, created: 0, turns: [], accepted: new Map(), replies: [], evicted: new Set() };
  const handlers = { ...zetaHandlers(zeta), ...options.handlers?.(zeta) };
  const fake = await server(handlers, FEATURES);
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
        // The reopen's replay disposes the old store before its first history page.
        const page = h.fake.hold("session_history");
        h.select("a"); await page.reached;
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
  {
    name: "22 M1 page restore after zeta took the send: the delivered text never comes back as a draft; one turn",
    async run() {
      const tab = tabStorage();
      const page1 = await openA({ tab });
      const send = page1.fake.hold("send");
      page1.type("dup check");
      void page1.enter();
      await send.reached;
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
    name: "23 M1 page restore before zeta took the send: the restored delivery is sent again with its old id, once",
    async run() {
      const tab = tabStorage();
      const page1 = await openA({ tab });
      const send = page1.fake.hold("send");
      page1.type("never arrived");
      void page1.enter();
      await send.reached;
      await new Promise((resolve) => setTimeout(resolve, 200));
      page1.dispose();
      send.fail({ code: -32603, message: "the page left before zeta read the frame" });
      const first = page1.sends()[0]!.delivery_id;
      const page2 = await world({ selected: "a", zeta: page1.zeta, tab });
      try {
        page2.start(); await page2.live("a");
        await waitFor(() => page2.zeta.turns.length > 0, 2_000);
        expect(page2.zeta.turns).toEqual([{ session: "a", text: "never arrived", id: first as string }]);
        await waitFor(() => page2.text("a") === "", 2_000);
        page2.deliveries.reconcile("a"); // the app reconciles on the run's next store event
        await waitFor(() => page2.store.get("a").deliveries.size === 0, 2_000);
        expect(page2.owner()).toMatchObject({ accept: true });
      } finally { page2.dispose(); }
    },
  },
  {
    name: "24 a failed send's draft keeps its delivery id across a page restore; the retry is a zeta duplicate",
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
        expect(page2.text("a")).toBe("lost reply");
        expect(await page2.enter()).toEqual({ ok: true });
        expect(page2.zeta.turns).toHaveLength(1);
        expect(page2.sends()[0]!.delivery_id).toBe(page1.sends()[0]!.delivery_id);
        expect(page2.text("a")).toBe("");
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
