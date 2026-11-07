import { expect, test } from "bun:test";
import { createClient, type Transport, type ZetaClient } from "@fulcrum/zeta";
import { createSessionManager, sessionTitle, type RunState, type SessionMeta } from "../src/session";
import { createRunStateStore, workspaceRunState, type DraftRunId, type EntryId, type RunId } from "../src/run-state";

type Handler = (params: Record<string, unknown>) => unknown;

/** A real zeta client over an in-memory transport; `handlers` answer requests by method. */
async function server(handlers: Record<string, Handler>, features: string[] = []) {
  let deliver!: (text: string) => void;
  let close!: (code?: number) => void;
  const calls: Array<[string, Record<string, unknown>]> = [];
  const transport: Transport = {
    onMessage(callback) { deliver = callback; },
    onClose(callback) { close = callback; },
    close() {},
    send(text) {
      const { id, method, params } = JSON.parse(text);
      calls.push([method, params]);
      queueMicrotask(async () => {
        try {
          const result = method === "hello" ? { protocol_version: "1.2", capabilities: { features } } : await handlers[method]!(params);
          deliver(JSON.stringify({ jsonrpc: "2.0", id, result }));
        } catch (error) {
          deliver(JSON.stringify({ jsonrpc: "2.0", id, error: error as object }));
        }
      });
    },
  };
  const client = createClient(transport, (flush) => flush());
  await client.hello(features);
  const event = (params: Record<string, unknown>) => deliver(JSON.stringify({ jsonrpc: "2.0", method: "event", params }));
  return { client, calls, event, drop: () => close(1006) };
}

function harness(connection: ReturnType<typeof source>, options: { selected?: string; onSelect?(id: string | null): void; bindings?: Parameters<typeof createSessionManager>[2] } = {}) {
  const first = options.selected ?? `draft:${crypto.randomUUID()}`;
  const store = createRunStateStore(8, undefined, undefined, { id: "entry" as EntryId, run: first as RunId });
  store.activate(first, first.startsWith("draft:") ? { choice: "default" } : { choice: "explicit", model: "" });
  const manager = createSessionManager(connection, store, options.bindings);
  store.setEffectExecutor(manager.execute);
  manager.start();
  const select = (id: string) => { store.dispatch({ type: "NAVIGATED", entryId: crypto.randomUUID() as EntryId, runId: id as RunId }); store.activate(id, { choice: "explicit", model: "" }); options.onSelect?.(id); };
  return {
    get state(): RunState { return workspaceRunState(store.getCatalog()); },
    select,
    reset() { const id = `draft:${crypto.randomUUID()}` as DraftRunId; store.dispatch({ type: "NEW_RUN", entryId: crypto.randomUUID() as EntryId, runId: id }); store.activate(id, { choice: "default" }); options.onSelect?.(null); },
    async create(choice: { model?: string; provider?: string; approval_mode?: "ask" | "allow" } = {}) {
      const previous = store.getEntry().run;
      let draft = previous;
      if (!draft.startsWith("draft:")) { draft = `draft:${crypto.randomUUID()}`; store.dispatch({ type: "NEW_RUN", entryId: crypto.randomUUID() as EntryId, runId: draft as DraftRunId }); store.activate(draft, { choice: "default" }); }
      try { const id = await manager.create(draft, choice); options.onSelect?.(id); return id; }
      catch (error) { if (previous !== draft) store.dispatch({ type: "NAVIGATED", entryId: crypto.randomUUID() as EntryId, runId: previous as RunId }); throw error; }
    },
    dispose() { store.dispose(); manager.dispose(); },
  };
}

type TestRun = ReturnType<typeof harness>;
const present = (view: TestRun) => view.state;
const meta = (id: string, updated: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({ session_id: id, created_at: updated, updated_at: updated, ...extra });
const sessions = [meta("a", "2026-11-01T10:00:00Z", { name: "alpha" }), meta("b", "2026-11-02T10:00:00Z", { first_message_preview: "fix the build" }), meta("c", "2026-11-03T10:00:00Z", { parent_session_id: "b" })];
const history: Record<string, unknown[]> = {
  a: [{ id: "a1", role: "user", content: [{ type: "text", text: "hello a" }], tool_result: null }],
  b: [
    { id: "b1", role: "user", content: [{ type: "text", text: "hello b" }], tool_result: null },
    { id: "b2", role: "assistant", content: [{ type: "text", text: "on it" }], tool_result: null },
  ],
  c: [
    { id: "c1", role: "assistant", content: [{ type: "tool_use", tool_call: { id: "tool-c", name: "bash", arguments: {} } }], tool_result: null },
    { id: "c2", role: "tool_result", content: [{ type: "text", text: "done" }], tool_result: { tool_call_id: "tool-c", content: "done", is_error: false } },
  ],
};

function source(client: ZetaClient | null) {
  const listeners = new Set<() => void>();
  return {
    client,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    set(next: ZetaClient | null) { this.client = next; listeners.forEach((listener) => listener()); },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function handlers(active: string | null, extra: Record<string, Handler> = {}): Record<string, Handler> {
  let current = active;
  return {
    status: () => ({ session: current ? meta(current, "x") : null, state: "idle", pending_approvals: current === "b" || current === "c" ? [{ request_id: "r1", tool_call: { id: "t9", name: "bash", arguments: { command: "rm -rf dist" } }, delegated: false }] : [] }),
    resume: (params) => { current = params.session_id as string; return { session: meta(current, "x") }; },
    session_history: (params) => {
      const rows = history[params.session_id as string] ?? [];
      const offset = params.offset as number;
      return { messages: rows.slice(offset, offset + 1), next_offset: offset + 1 < rows.length ? offset + 1 : null };
    },
    ...extra,
  };
}
const kinds = (state: ReturnType<typeof harness>["state"]) => {
  const store = state.open!.lease.store;
  return store.getOutline().map(({ kind }) => kind);
};

test("titles: the name, else the first prompt, else none", () => {
  expect(sessions.map(sessionTitle)).toEqual(["alpha", "fix the build", null]);
  expect(sessionTitle(null)).toBeNull();
});

test("on connect with no run selected it stays blank and never opens the server's own session", async () => {
  const fake = await server(handlers("b"));
  const view = harness(source(fake.client));
  await tick();
  expect(present(view).open).toBeNull();
  expect(present(view).selected).toBeNull();
  expect(fake.calls.map(([method]) => method)).toEqual(["hello", "status"]);
});

test("a failed replacement keeps the requested selection and never presents the old run", async () => {
  const resumed: string[] = [];
  const selected: string[] = [];
  const fake = await server(handlers("b", { resume: (params) => { resumed.push(params.session_id as string); if (params.session_id === "a") { return { session: meta("a", "x") }; } return { session: meta("b", "x") }; }, session_history: (params) => { if (params.session_id === "a") throw { code: -32602, message: "session log is invalid at line 12" }; return { messages: [], next_offset: null }; } }));
  const view = harness(source(fake.client), { selected: "b", onSelect: (id) => selected.push(id) });
  await tick();
  view.select("a");
  await tick();
  expect(resumed).toEqual(["a"]);
  expect(present(view).open).toBeNull();
  expect(present(view).selected).toBe("a");
  expect(selected).toEqual(["a"]);
  expect(present(view).openError?.message).toBe("session log is invalid at line 12");
});

test("on connect it opens the server's own session without resume, with every history page and its approval", async () => {
  const fake = await server(handlers("b"));
  const view = harness(source(fake.client), { selected: "b" });
  await tick();
  expect(present(view).selected).toBe("b");
  expect(view.state.session?.session_id).toBe("b");
  expect(kinds(view.state)).toEqual(["user", "approval", "message"]);
  expect(fake.calls.map(([method]) => method)).not.toContain("resume");
  expect(fake.calls.filter(([method]) => method === "session_history").map(([, params]) => params.offset)).toEqual([0, 1]);
});

test("the first history page makes the session usable while later pages load", async () => {
  let release!: () => void;
  const later = new Promise<{ messages: unknown[]; next_offset: null }>((resolve) => {
    release = () => resolve({ messages: [{ id: "late", role: "assistant", content: [{ type: "text", text: "later page" }], tool_result: null }], next_offset: null });
  });
  const fake = await server(handlers("b", { session_history: (params) => params.offset === 0
    ? { messages: [{ id: "first", role: "user", content: [{ type: "text", text: "first page" }], tool_result: null }], next_offset: 1 }
    : later }));
  const view = harness(source(fake.client), { selected: "b" });
  await tick();
  expect(present(view).open).toMatchObject({ id: "b", history: { messages: 1, complete: false } });
  expect(kinds(view.state)).toEqual(["user", "approval"]);
  release();
  await tick();
  expect(present(view).open?.history).toEqual({ messages: 2, complete: true });
  expect(kinds(view.state)).toEqual(["user", "approval", "message"]);
});

test("progressive history does not revive a completed approval before its ending page loads", async () => {
  let release!: () => void;
  const later = new Promise<{ messages: unknown[]; next_offset: null }>((resolve) => { release = () => resolve({ messages: [{ id: "end", role: "system", event: "approval_end", request_id: "old", data: { decision: "abort" } }], next_offset: null }); });
  const fake = await server(handlers("b", {
    status: () => ({ session: meta("b", "x"), state: "idle", pending_approvals: [] }),
    session_history: (params) => params.offset === 0
      ? { messages: [{ id: "start", role: "system", event: "approval_request", request_id: "old", tool_call: { id: "old-tool", name: "bash", arguments: {} }, delegated: false }], next_offset: 1 }
      : later,
  }));
  const view = harness(source(fake.client), { selected: "b" });
  await tick();
  expect(present(view).open?.lease.store.getItem("approval:old")).toBeUndefined();
  release();
  await tick();
  expect(present(view).open?.lease.store.getItem("approval:old")).toMatchObject({ type: "approval", ended: { decision: "abort" } });
});

test("a failed later page keeps its first-page approval and exposes the error", async () => {
  const approval = { request_id: "held", tool_call: { id: "held-tool", name: "bash", arguments: {} }, delegated: false };
  const fake = await server(handlers("b", {
    status: () => ({ session: meta("b", "x"), state: "tool", pending_approvals: [approval] }),
    session_history: (params) => {
      if (params.offset === 0) return { messages: [], next_offset: 1 };
      throw { code: -32000, message: "older history failed" };
    },
  }));
  const view = harness(source(fake.client), { selected: "b" });
  await tick();
  expect(present(view).open?.lease.store.getItem("approval:held")).toMatchObject({ type: "approval" });
  expect(present(view).openError?.message).toBe("older history failed");
});

test("selecting another session resumes it, releases the old one, and reports progress", async () => {
  const fake = await server(handlers("b"));
  const selected: string[] = [];
  const view = harness(source(fake.client), { selected: "b", onSelect: (id) => selected.push(id) });
  await tick();
  view.select("a");
  expect(present(view).opening).toEqual({ id: "a", messages: 0 });
  expect(present(view).open).toBeNull();
  expect(present(view).opening).toEqual({ id: "a", messages: 0 });
  await tick();
  expect(selected).toEqual(["a"]);
  expect(present(view).open?.id).toBe("a");
  expect(kinds(view.state)).toEqual(["user"]);
  expect(fake.calls.some(([method, params]) => method === "resume" && params.session_id === "a")).toBe(true);
});

test("switching sessions cancels background history without replacing the new run", async () => {
  let release!: () => void;
  const later = new Promise<{ messages: unknown[]; next_offset: null }>((resolve) => { release = () => resolve({ messages: [], next_offset: null }); });
  const fake = await server(handlers("b", {
    session_history: (params) => {
      if (params.session_id === "b" && params.offset === 0) return { messages: [], next_offset: 1 };
      if (params.session_id === "b") return later;
      return { messages: [{ id: "a", role: "user", content: [{ type: "text", text: "new run" }], tool_result: null }], next_offset: null };
    },
  }));
  const view = harness(source(fake.client), { selected: "b" });
  await tick();
  expect(present(view).open?.id).toBe("b");
  view.select("a");
  await tick();
  expect(present(view).open?.id).toBe("a");
  release();
  await tick();
  expect(present(view).open?.id).toBe("a");
  expect(kinds(view.state)).toEqual(["user"]);
});

test("the newest selection wins when opens overlap", async () => {
  const fake = await server(handlers(null));
  const view = harness(source(fake.client));
  await tick();
  view.select("a");
  view.select("b");
  await tick();
  expect(present(view).open?.id).toBe("b");
  expect(present(view).selected).toBe("b");
});

test("a failed replacement shows only the requested run error", async () => {
  const fake = await server(handlers("b", { resume: (params) => { if (params.session_id === "a") throw { code: -32602, message: "session log is invalid at line 12" }; return {}; } }));
  const view = harness(source(fake.client), { selected: "b" });
  await tick();
  view.select("a");
  await tick();
  expect(present(view).open).toBeNull();
  expect(present(view).openError).toEqual({ id: "a", message: "session log is invalid at line 12", busy: false });
  expect(present(view).opening).toBeNull();
});

test("a busy resume displays the URL-selected cached run and forward restores the active run", async () => {
  let current = "a";
  let blockA = false;
  const fake = await server(handlers("a", {
    status: () => ({ session: meta(current, "x"), state: blockA ? "running" : "idle", pending_approvals: [] }),
    resume: (params) => {
      const id = params.session_id as string;
      if (blockA && id === "a") throw { code: -32004, message: "a turn is already running" };
      current = id;
      return { session: meta(id, "x") };
    },
  }));
  const view = harness(source(fake.client), { selected: "a" });
  await tick();
  view.select("b");
  for (let attempt = 0; attempt < 400 && present(view).open?.id !== "b"; attempt++) await tick();
  expect(present(view).open?.id).toBe("b");
  blockA = true;
  view.select("a");
  for (let attempt = 0; attempt < 400 && !present(view).openError; attempt++) await tick();
  expect(present(view).open?.id).toBe("a");
  expect(view.state.session?.session_id).toBe("a");
  expect(present(view).openError).toMatchObject({ id: "a", busy: true });
  view.select("b"); await tick();
  expect(present(view).open?.id).toBe("b");
  expect(view.state.session?.session_id).toBe("b");
});

test("an active owner is reported as busy and the selection stays", async () => {
  const fake = await server(handlers("b", { status: () => ({ session: meta("b", "x"), state: "running", pending_approvals: [] }), resume: () => { throw { code: -32004, message: "a turn is already running" }; } }));
  const view = harness(source(fake.client));
  await tick();
  view.select("a");
  await tick();
  expect(present(view).openError).toMatchObject({ id: "a", busy: true });
  expect(present(view).selected).toBe("a");
});

test("a drop keeps the old transcript as stale; the reconnect rebuilds it on a fresh store without duplicates", async () => {
  const first = await server(handlers("b"));
  const connection = source(first.client);
  const view = harness(connection, { selected: "b" });
  await tick();
  const before = present(view).open!.lease.store;
  connection.set(null);
  expect(present(view).open).toMatchObject({ id: "b", stale: true });
  const second = await server(handlers("b"));
  connection.set(second.client);
  await tick();
  expect(present(view).open).toMatchObject({ id: "b", stale: false });
  expect(present(view).open!.lease.store).not.toBe(before);
  expect(kinds(view.state)).toEqual(["user", "approval", "message"]);
  const pending = present(view).open!.lease.store.getItem("approval:r1");
  expect(pending?.type).toBe("approval");
  expect(pending && "ended" in pending ? pending.ended : undefined).toBeUndefined();
});

test("a negotiated drop keeps the same approval row in reconnecting state across two drops", async () => {
  const features = ["approval_reconnect"];
  const first = await server(handlers("b"), features);
  const connection = source(first.client);
  const view = harness(connection, { selected: "b" });
  await tick();
  const row = present(view).open!.lease.store.getItem("approval:r1");

  connection.set(null);
  expect(present(view).open!.lease.store.getItem("approval:r1")).toMatchObject({
    id: "approval:r1", request: { state: "reconnecting", status: "reconnecting…" },
  });
  expect(present(view).open!.lease.store.getItem("approval:r1")).not.toBe(row);

  const second = await server(handlers("b"), features);
  connection.set(second.client);
  await tick();
  const reconnected = present(view).open!.lease.store.getItem("approval:r1");
  expect(reconnected?.type === "approval" && reconnected.request.type === "approval_request" ? reconnected.request.state : "missing").toBeUndefined();
  connection.set(null);
  expect(present(view).open!.lease.store.getItem("approval:r1")).toMatchObject({
    id: "approval:r1", request: { state: "reconnecting" },
  });
});

test("an old server drop keeps the legacy pending shape", async () => {
  const first = await server(handlers("b"), []);
  const connection = source(first.client);
  const view = harness(connection, { selected: "b" });
  await tick();
  connection.set(null);
  const approval = present(view).open!.lease.store.getItem("approval:r1");
  expect(approval?.type === "approval" && approval.request.type === "approval_request" ? approval.request.state : "missing").toBeUndefined();
});

test("a fresh idle snapshot removes a formerly pending approval", async () => {
  const first = await server(handlers("b"));
  const connection = source(first.client);
  const view = harness(connection, { selected: "b" });
  await tick();
  connection.set(null);
  expect(present(view).open!.lease.store.getItem("approval:r1")).toMatchObject({ type: "approval" });
  const second = await server(handlers("b", { status: () => ({ session: meta("b", "x"), state: "idle", pending_approvals: [] }) }));
  connection.set(second.client);
  await tick();
  expect(present(view).open!.lease.store.getItem("approval:r1")).toBeUndefined();
});

test("advertised approval history trusts the fresh snapshot", async () => {
  const first = await server(handlers("c"), ["approval_history"]);
  const connection = source(first.client);
  const view = harness(connection, { selected: "c" });
  await tick();
  connection.set(null);
  const second = await server(handlers("c", { status: () => ({ session: meta("c", "x"), state: "idle", pending_approvals: [] }) }), ["approval_history"]);
  connection.set(second.client);
  await tick();
  expect(present(view).open!.lease.store.getItem("approval:r1")).toBeUndefined();
});

test("a running open stays snapshot-only until idle, then reloads one complete message", async () => {
  let statusCalls = 0;
  let historyCalls = 0;
  let emit: ((params: Record<string, unknown>) => void) | null = null;
  const fake = await server(handlers("b", {
    status: () => ({ session: meta("b", "x"), state: ++statusCalls < 2 ? "running" : "idle", pending_approvals: [] }),
    session_history: () => {
      historyCalls++;
      if (historyCalls === 1) queueMicrotask(() => {
        emit?.({ event: "assistant_delta", session_id: "b", delta: " duplicated tail", kind: "assistant" });
        emit?.({ event: "assistant_message", session_id: "b", message: { role: "assistant", content: [{ type: "text", text: "partial duplicated tail" }] } });
      });
      return { messages: [{ id: "m", role: "assistant", content: [{ type: "text", text: historyCalls === 1 ? "partial" : "complete" }], tool_result: null }], next_offset: null };
    },
  }));
  emit = fake.event;
  const view = harness(source(fake.client), { selected: "b" });
  await tick();
  expect(present(view).open?.syncing).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 550));
  const messages = present(view).open!.lease.store.getOutline().map(({ id }) => present(view).open!.lease.store.getItem(id)).filter((item) => item?.type === "message");
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ type: "message", message: { content: [{ type: "text", text: "complete" }] } });
  expect(present(view).open?.syncing).toBe(false);
});

test("snapshot-only mode discovers an approval that starts after history loads", async () => {
  let statusCalls = 0;
  const fake = await server(handlers("b", {
    status: () => ({
      session: meta("b", "x"),
      state: ++statusCalls >= 2 ? "tool" : "running",
      pending_approvals: statusCalls >= 2 ? [{ request_id: "late", tool_call: { id: "late-tool", name: "bash", arguments: { command: "bun test" } }, delegated: false }] : [],
    }),
  }));
  const connection = source(fake.client);
  const view = harness(connection, { selected: "b" });
  await new Promise((resolve) => setTimeout(resolve, 550));
  expect(present(view).open!.lease.store.getItem("approval:late")).toMatchObject({ type: "approval", request: { request_id: "late" } });
  connection.set(null);
});

test("live events after the open land in the open store", async () => {
  const fake = await server(handlers("b"));
  const view = harness(source(fake.client), { selected: "b" });
  await tick();
  fake.event({ event: "assistant_delta", session_id: "b", delta: "streaming", kind: "assistant" });
  expect(kinds(view.state)).toEqual(["user", "approval", "message", "message"]);
});

// zeta's `new_session` answers `{ session: <full metadata> }` and makes it the server's session (server.py).
test("create starts a session with new_session and opens it without resume", async () => {
  let current: string | null = null;
  const created = meta("new-1", "2026-11-04T10:00:00Z", { name: "", cwd: "/tmp/project", model: "qwen3.6:35b" });
  const fake = await server(handlers(null, {
    new_session: () => { current = created.session_id; return { session: created }; },
    status: () => ({ session: current ? created : null, state: "idle", pending_approvals: [] }),
    session_history: () => ({ messages: [], next_offset: null }),
  }));
  const selected: string[] = [];
  const view = harness(source(fake.client), { onSelect: (id) => selected.push(id) });
  await tick();
  await view.create();
  await tick();
  expect(fake.calls.find(([method]) => method === "new_session")).toEqual(["new_session", {}]);
  expect(fake.calls.map(([method]) => method)).not.toContain("resume");
  expect(view.state.session?.session_id).toBe("new-1");
  expect(present(view).open?.id).toBe("new-1");
  expect(present(view).selected).toBe("new-1");
  expect(selected).toEqual(["new-1"]);
});

test("a failed create keeps the current session and says why", async () => {
  const fake = await server(handlers("b", { new_session: () => { throw { code: -32004, message: "a turn is already running" }; } }));
  const view = harness(source(fake.client), { selected: "b" });
  await tick();
  await expect(view.create()).rejects.toMatchObject({ message: "a turn is already running" });
  expect(present(view).open?.id).toBe("b");
}, 10_000);

test("host commands are rebound on attach, reconnect, resume, and new session", async () => {
  let generation = 0;
  const bound: Array<[string, string]> = [];
  const bindings = {
    register: async (sessionId?: string) => {
      const token = `token-${++generation}`;
      return { registration_id: sessionId ?? `pending-${generation}`, command: { name: "gamma" as const, executable: "/gamma/bin/gamma", summary: "web commands", environment: { GAMMA_API_URL: "http://127.0.0.1:1/api", GAMMA_API_TOKEN: token } } };
    },
    bind: async (registrationId: string, sessionId: string) => { bound.push([registrationId, sessionId]); },
  };
  const first = await server({ ...handlers("b"), new_session: () => ({ session: meta("new", "z") }) }, ["session_host_commands"]);
  const connection = source(first.client);
  const view = harness(connection, { selected: "b", bindings });
  await tick();
  expect(first.calls.find(([method]) => method === "resume")?.[1]).toMatchObject({ session_id: "b", host_commands: [{ name: "gamma", environment: { GAMMA_API_TOKEN: "token-1" } }] });

  const second = await server({ ...handlers("b"), new_session: () => ({ session: meta("new", "z") }) }, ["session_host_commands"]);
  connection.set(second.client); await tick();
  expect(second.calls.find(([method]) => method === "resume")?.[1]).toMatchObject({ session_id: "b", host_commands: [{ environment: { GAMMA_API_TOKEN: "token-2" } }] });

  await view.create(); await tick();
  const created = second.calls.find(([method]) => method === "new_session")?.[1];
  expect(created).toMatchObject({ host_commands: [{ environment: { GAMMA_API_TOKEN: "token-3" } }] });
  expect(bound).toEqual([["pending-3", "new"]]);
  const newResume = second.calls.filter(([method, params]) => method === "resume" && params.session_id === "new").at(-1)?.[1];
  expect(newResume).toMatchObject({ host_commands: [{ environment: { GAMMA_API_TOKEN: "token-4" } }] });
  view.dispose();
});

test("reset releases the run and goes blank; the next create passes the chosen model to new_session", async () => {
  const fake = await server(handlers("b", { new_session: () => ({ session: meta("new", "z") }) }));
  const selected: Array<string | null> = [];
  const view = harness(source(fake.client), { selected: "b", onSelect: (id) => selected.push(id) });
  await tick();
  expect(present(view).open?.id).toBe("b");
  view.reset();
  expect(present(view).open).toBeNull();
  expect(view.state.session).toBeNull();
  expect(selected).toEqual([null]);
  expect(await view.create({ model: "claude-opus-4-6", provider: "claude" })).toBe("new");
  await tick();
  expect(fake.calls.find(([method]) => method === "new_session")?.[1]).toEqual({ model: "claude-opus-4-6", provider: "claude" });
  expect(present(view).open?.id).toBe("new");
});
