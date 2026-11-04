import { expect, test } from "bun:test";
import { createClient, type Transport } from "@fulcrum/zeta";
import { openSession } from "../src/session";

type Json = Record<string, any>;
type Handler = (method: string, params: Json, event: (params: Json) => void) => unknown;

async function server(handler: Handler) {
  let receive!: (text: string) => void;
  const calls: Array<[string, Json]> = [];
  const transport: Transport = {
    onMessage(callback) { receive = callback; },
    onClose() {},
    close() {},
    send(text) {
      const { id, method, params = {} } = JSON.parse(text);
      calls.push([method, params]);
      queueMicrotask(async () => {
        const event = (value: Json) => receive(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { session_id: "s", ...value } }));
        try {
          const result = method === "hello"
            ? { protocol_version: "1.2", capabilities: { features: ["delivery_id", "user_message_event", "user_message_delivery_id"] } }
            : await handler(method, params, event);
          receive(JSON.stringify({ jsonrpc: "2.0", id, result }));
        } catch (error) {
          receive(JSON.stringify({ jsonrpc: "2.0", id, error }));
        }
      });
    },
  };
  const client = createClient(transport, (flush) => flush());
  await client.hello([]);
  return { client, calls };
}

const row = (id: string, role: "user" | "assistant", text: string) => ({ id, role, content: [{ type: "text", text }], tool_result: null });
const items = (store: ReturnType<typeof createClient>["store"]) => store.getOutline().map(({ id }) => store.getItem(id));
const texts = (store: ReturnType<typeof createClient>["store"]) => items(store).flatMap((item) => {
  if (item?.type === "message") return [item.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("")];
  if (item?.type === "user" && item.event.type === "user_message") return [item.event.text];
  return [];
});
const idleStatus = { session: { session_id: "s", created_at: "", updated_at: "" }, state: "idle", pending_approvals: [] } as const;

// Review 3's exact loss: both events arrive in the ambiguous first-page window and are absent from that page.
test("an idle replay replaces quarantined live events with one fresh full snapshot", async () => {
  let historyCalls = 0;
  const fake = await server((method, _params, event) => {
    if (method === "status") return idleStatus;
    if (method === "session_history") {
      historyCalls++;
      if (historyCalls === 1) {
        event({ event: "assistant_delta", delta: "lost-during-history", kind: "assistant" });
        event({ event: "user_message", message: { role: "user", content: [{ type: "text", text: "lost-steer" }] }, delivery_id: "delivery-1" });
        return { messages: [row("old", "user", "old")], next_offset: null };
      }
      return { messages: [row("old", "user", "old"), row("assistant", "assistant", "lost-during-history"), row("steer", "user", "lost-steer")], next_offset: null };
    }
    throw new Error(method);
  });

  const opened = await openSession(fake.client, "s");
  await opened.complete;

  expect(texts(opened.lease.store)).toEqual(["old", "lost-during-history", "lost-steer"]);
  expect(fake.calls.filter(([method, params]) => method === "session_history" && params.offset === 0)).toHaveLength(2);
});

test("a quarantined event on a later page forces a tail reconcile", async () => {
  let emitted = false;
  let tailCalls = 0;
  const fake = await server((method, params, event) => {
    if (method === "status") return idleStatus;
    if (method !== "session_history") throw new Error(method);
    if (params.offset === 0) return { messages: [row("old", "user", "old")], next_offset: 1 };
    tailCalls++;
    if (!emitted) {
      emitted = true;
      event({ event: "assistant_delta", delta: "during-page-one", kind: "assistant" });
      return { messages: [row("older", "user", "older")], next_offset: null };
    }
    return { messages: [row("older", "user", "older"), row("assistant", "assistant", "during-page-one")], next_offset: null };
  });

  const opened = await openSession(fake.client, "s");
  await opened.complete;

  expect(texts(opened.lease.store)).toEqual(["old", "older", "during-page-one"]);
  expect(tailCalls).toBe(2);
});

test("the fourth quarantined event survives the reconciliation bound", async () => {
  let historyCalls = 0;
  const fake = await server((method, _params, event) => {
    if (method === "status") return idleStatus;
    if (method !== "session_history") throw new Error(method);
    historyCalls++;
    if (historyCalls <= 4)
      event({ event: "user_message", text: `event-${historyCalls}`, mode: "send", delivery_id: `d${historyCalls}` });
    return {
      messages: Array.from({ length: Math.min(historyCalls - 1, 4) }, (_, index) => row(`event-${index + 1}`, "user", `event-${index + 1}`)),
      next_offset: null,
    };
  });

  const opened = await openSession(fake.client, "s");
  await opened.complete;

  expect(texts(opened.lease.store)).toEqual(["event-1", "event-2", "event-3", "event-4"]);
  expect(historyCalls).toBe(5);
});

test("a thousand-page replay reconciles only its tail", async () => {
  const pageCount = 1_000;
  const offsets: number[] = [];
  let emitted = false;
  const fake = await server((method, params, event) => {
    if (method === "status") return idleStatus;
    if (method !== "session_history") throw new Error(method);
    const offset = params.offset as number;
    offsets.push(offset);
    if (offset === 500 && !emitted) {
      emitted = true;
      event({ event: "user_message", text: "late", mode: "send", delivery_id: "late" });
    }
    const last = offset === pageCount - 1;
    return {
      messages: [row(`row-${offset}`, "user", last && offsets.length > pageCount ? "tail updated" : `row ${offset}`)],
      next_offset: last ? null : offset + 1,
    };
  });

  const opened = await openSession(fake.client, "s");
  await opened.complete;

  expect(offsets).toHaveLength(pageCount + 1);
  expect(offsets.filter((offset) => offset === 0)).toHaveLength(1);
  expect(offsets.slice(pageCount)).toEqual([pageCount - 1]);
  expect(texts(opened.lease.store).at(-1)).toBe("tail updated");
});

test("a changed tail boundary causes exactly one full reload", async () => {
  const offsets: number[] = [];
  let pageTwoCalls = 0;
  const fake = await server((method, params, event) => {
    if (method === "status") return idleStatus;
    if (method !== "session_history") throw new Error(method);
    const offset = params.offset as number;
    offsets.push(offset);
    if (offset === 1 && pageTwoCalls === 0) event({ event: "assistant_delta", delta: "rewind", kind: "assistant" });
    if (offset === 2 && ++pageTwoCalls === 1) return { messages: [row("old-2", "user", "old 2")], next_offset: null };
    if (offset === 2) return { messages: [row("different", "user", "different")], next_offset: null };
    if (pageTwoCalls === 0) return { messages: [row(`old-${offset}`, "user", `old ${offset}`)], next_offset: offset + 1 };
    return { messages: [row(`new-${offset}`, "user", `new ${offset}`)], next_offset: offset === 0 ? 1 : null };
  });

  const opened = await openSession(fake.client, "s");
  await opened.complete;

  expect(offsets).toEqual([0, 1, 2, 2, 0, 1]);
  expect(texts(opened.lease.store)).toEqual(["new 0", "new 1"]);
});

test("a busy replay stays quarantined at the bound and catches up after idle", async () => {
  let historyCalls = 0;
  let statusCalls = 0;
  const fake = await server((method, _params, event) => {
    if (method === "status") {
      statusCalls++;
      return { ...idleStatus, state: statusCalls === 1 || (statusCalls >= 3 && statusCalls <= 5) ? "running" : "idle" };
    }
    if (method !== "session_history") throw new Error(method);
    historyCalls++;
    if (historyCalls <= 4)
      event({ event: "user_message", text: `event-${historyCalls}`, mode: "send", delivery_id: `d${historyCalls}` });
    return {
      messages: Array.from({ length: Math.min(historyCalls - 1, 4) }, (_, index) => row(`event-${index + 1}`, "user", `event-${index + 1}`)),
      next_offset: null,
    };
  });

  const opened = await openSession(fake.client, "s");
  expect(opened.syncing).toBe(true);
  await opened.complete;

  expect(historyCalls).toBe(5);
  expect(texts(opened.lease.store)).toEqual(["event-1", "event-2", "event-3", "event-4"]);
});

test("resolution_pending disables the same approval row with a resolving status", async () => {
  const approval = { request_id: "approval-late", tool_call: { id: "tool-late", name: "bash", arguments: {} }, delegated: false, resolution_pending: "approve" };
  const fake = await server((method) => {
    if (method === "status") return { ...idleStatus, state: "tool", pending_approvals: [approval], pending_approvals_truncated: false };
    if (method === "session_history") return { messages: [], next_offset: null };
    throw new Error(method);
  });

  const opened = await openSession(fake.client, "s");
  const approvalItem = items(opened.lease.store).find((item) => item?.type === "approval");
  expect(approvalItem).toMatchObject({ id: "approval:approval-late", request: { state: "resolving", status: "resolving…" } });
});

test("a truncated 64-entry status keeps pending approvals omitted from the live projection via history", async () => {
  const approvals = Array.from({ length: 65 }, (_, index) => ({ request_id: `approval-${index}`, tool_call: { id: `tool-${index}`, name: "bash", arguments: {} }, delegated: false }));
  const history = approvals.map((approval, index) => ({ id: `row-${index}`, role: "system", event: "approval_request", ...approval }));
  const fake = await server((method) => {
    if (method === "status") return { ...idleStatus, pending_approvals: approvals.slice(0, 64), pending_approvals_truncated: true };
    if (method === "session_history") return { messages: history, next_offset: null };
    throw new Error(method);
  });

  const opened = await openSession(fake.client, "s");
  await opened.complete;
  expect(items(opened.lease.store).filter((item) => item?.type === "approval")).toHaveLength(65);
  expect(items(opened.lease.store).filter((item) => item?.type === "approval").at(-1)?.id).toBe("approval:approval-64");
});

test("the first snapshot exposes an actionable approval while page one is held", async () => {
  let release!: () => void;
  const held = new Promise<unknown>((resolve) => { release = () => resolve({ messages: [], next_offset: null }); });
  const approval = { request_id: "approval-late", tool_call: { id: "tool-late", name: "bash", arguments: {} }, delegated: false };
  let statusCalls = 0;
  const fake = await server((method, params) => {
    if (method === "status") return ++statusCalls === 1 ? { ...idleStatus, state: "tool", pending_approvals: [approval] } : idleStatus;
    if (method === "session_history") return params.offset === 0 ? { messages: [row("old", "user", "old")], next_offset: 1 } : held;
    if (method === "approve") return { accepted: true };
    throw new Error(method);
  });

  const opened = await openSession(fake.client, "s");
  expect(items(opened.lease.store).filter((item) => item?.type === "approval")).toHaveLength(1);
  await expect(fake.client.request("approve", { request_id: "approval-late" })).resolves.toEqual({ accepted: true });
  release();
  await opened.complete;
});

test("a later-page failure keeps the approval visible for the caller to show with the error", async () => {
  const approval = { request_id: "approval-late", tool_call: { id: "tool-late", name: "bash", arguments: {} }, delegated: false };
  const fake = await server((method, params) => {
    if (method === "status") return { ...idleStatus, state: "tool", pending_approvals: [approval] };
    if (method === "session_history" && params.offset === 0) return { messages: [], next_offset: 1 };
    if (method === "session_history") throw { code: -32000, message: "page one failed" };
    throw new Error(method);
  });

  const opened = await openSession(fake.client, "s");
  await expect(opened.complete).rejects.toThrow("page one failed");
  expect(items(opened.lease.store).filter((item) => item?.type === "approval")).toHaveLength(1);
});

test("evicting during progressive paging aborts completion before the held request replies", async () => {
  let release!: () => void;
  const held = new Promise<unknown>((resolve) => { release = () => resolve({ messages: [row("late", "user", "late")], next_offset: null }); });
  const fake = await server((method, params) => {
    if (method === "status") return idleStatus;
    if (method === "session_history") return params.offset === 0 ? { messages: [], next_offset: 1 } : held;
    throw new Error(method);
  });

  const opened = await openSession(fake.client, "s");
  while (fake.calls.filter(([method]) => method === "session_history").length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fake.client.evictSession("s")).toBe(true);
  await expect(opened.complete).rejects.toThrow("request aborted");
  release();
  await Promise.resolve();
  expect(fake.calls.filter(([method]) => method === "session_history")).toHaveLength(2);
});

test("session_replay_seq stops at the future sequence coordinator seam", async () => {
  await expect(openSession({ features: ["session_replay_seq"] } as ReturnType<typeof createClient>, "s1")).rejects.toThrow("session_replay_seq needs the sequence replay coordinator");
});
