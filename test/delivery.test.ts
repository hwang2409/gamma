import { expect, test } from "bun:test";
import { createClient, fromZetaHistory, type Transport } from "@fulcrum/zeta";
import { createDelivery, createDeliveryManager, stopTurn } from "../src/delivery";
import { createRunStateStore } from "../src/run-state";
import { composerMethods } from "../scripts/fake-zeta";
import { createWriteClient, ObserverWriteError } from "../src/write-client";

type Reply = { result?: unknown; error?: { code: number; message: string; data?: unknown } };

/** A real zeta client over an in-memory transport; `answer` replies to each request by method. */
async function server(answer: (method: string, params: Record<string, unknown>) => Reply, features = ["delivery_id", "user_message_event", "user_message_delivery_id"], echo = true) {
  let deliver!: (text: string) => void;
  const calls: Array<[string, Record<string, unknown>]> = [];
  const transport: Transport = {
    onMessage(callback) { deliver = callback; },
    onClose() {},
    close() {},
    send(text) {
      const { id, method, params } = JSON.parse(text);
      if (method !== "hello") calls.push([method, params]);
      queueMicrotask(() => {
        // As zeta does, an accepted send or steer is echoed to the session before the reply.
        const reply = method === "hello" ? { result: { protocol_version: "1.2", capabilities: { features } } } : answer(method, params);
        if (echo && (method === "send" || method === "steer") && (reply.result as { accepted?: boolean } | undefined)?.accepted)
          deliver(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "user_message", session_id: "s", text: params.text, mode: method, attachments: [], ...(params.delivery_id === undefined ? {} : { delivery_id: params.delivery_id }) } }));
        deliver(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
      });
    },
  };
  const client = createClient(transport, (flush) => flush());
  await client.hello(features);
  return { client, calls };
}
const ok = { result: { accepted: true } };
const writes = (client: any, authority: () => "controller" | "observer" = () => "controller") => createWriteClient(() => ({ client, authority: authority() }));
/**
 * The executor sends only for the run zeta is attached to (decideSend); a status reply attaches "s". Deliveries are asked
 * about only once this page shows "s" live, so its open completes here too (the OPEN_OK asks about saved deliveries).
 */
const attach = (state: ReturnType<typeof createRunStateStore>) => {
  state.dispatch({ type: "RECONNECT" }); state.dispatch({ type: "STATUS", sessionId: "s" as any, turn: "idle" });
  const operationId = state.requestOpen("s");
  state.dispatch({ type: "OPEN_OK", runId: "s" as any, operationId, open: { id: "s", lease: { release() {} } as never, stale: false, history: { messages: 0, complete: true }, syncing: false } });
};
const memoryStorage = () => {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

test("fake reconnect history keeps the accepted steer and its terminal delivery status", async () => {
  let active = false;
  const fake = composerMethods(async () => {}, { get: () => active, set: (value) => { active = value; } });
  const before = fake.history.length;
  fake.handle("send", { text: "start", delivery_id: "fake-send" }, "s-reconnect", () => {}, ["delivery_id"]);
  await Promise.resolve();
  active = true;
  fake.handle("steer", { text: "drop me", delivery_id: "fake-steer" }, "s-reconnect", () => {}, ["delivery_id"]);
  fake.handle("abort", {}, "s-reconnect", () => {}, ["delivery_id"]);
  const rows = fake.history.slice(before);
  expect(rows.some((row) => JSON.stringify(row).includes("drop me"))).toBe(true);
  const adapted = fromZetaHistory(rows);
  expect(adapted.some((event) => event.type === "delivery_status" && event.delivery_id === "fake-steer" && event.status === "dropped")).toBe(true);
  expect(adapted.some((event) => event.type === "error")).toBe(false);
});

test("a reload reconciles a queued steer from durable status; a dropped one waits for the user's resend", async () => {
  let dropped = false;
  const { client, calls } = await server((method) => method === "delivery_status" ? { result: { status: dropped ? "dropped" : "queued" } } : ok);
  const storage = memoryStorage();
  const beforeState = createRunStateStore(8, undefined, storage, { id: "e" as any, run: "s" as any });
  const before = createDeliveryManager(() => client, writes(client), beforeState);
  attach(beforeState);
  await before.submit("s", "survive reload", true, "intent-1");
  before.dispose(); beforeState.dispose();
  dropped = true;
  const afterState = createRunStateStore(8, undefined, storage, { id: "e" as any, run: "s" as any });
  const after = createDeliveryManager(() => client, writes(client), afterState);
  afterState.activate("s");
  attach(afterState);
  await Bun.sleep(10);
  // The open asks once; a reloaded page never resends by itself: the steer waits as a dropped row.
  expect(calls.map(([method]) => method)).toEqual(["steer", "delivery_status"]);
  expect(afterState.get("s").deliveries.get("intent-1")).toMatchObject({ state: "dropped", spent: true });
  after.resend("s", "intent-1");
  await Bun.sleep(10);
  const retryId = (calls.at(-1)?.[1] as { delivery_id?: string }).delivery_id;
  expect(calls.map(([method]) => method)).toEqual(["steer", "delivery_status", "send"]);
  expect(retryId).not.toBe("intent-1");
  expect(afterState.get("s").deliveries.get("intent-1")?.state).toBe("queued");
});

test("write client refuses every mutation after an observer transition and passes them as controller", async () => {
  const mutating = [
    "new_session", "resume", "send", "steer", "send_images", "approve", "deny", "abort", "rename_session",
    "delete_session", "repair_transcript", "switch_branch", "fork_message", "set_settings", "set_compaction",
    "slash_run", "set_turn_context", "account_logout", "account_refresh", "account_switch", "login_start",
    "login_cancel", "project_inbox", "clear_steering", "revoke_session_grants", "child_run_list", "child_run_send",
  ];
  const requests: string[] = [];
  const client = { request: async (method: string) => { requests.push(method); return {}; } } as any;
  let authority: "controller" | "observer" = "controller";
  const access = writes(client, () => authority);
  const facade = access.get()!;

  authority = "observer";
  for (const method of mutating) expect(() => facade.request(method as never, {} as never)).toThrow(ObserverWriteError);
  expect(requests).toEqual([]);

  authority = "controller";
  for (const method of mutating) await facade.request(method as never, {} as never);
  expect(requests).toEqual(mutating);
});

test("controller work cannot write after authority changes to observer", async () => {
  let dropped = false;
  const { client, calls } = await server((method) => method === "delivery_status" ? { result: { status: dropped ? "dropped" : "queued" } } : ok);
  const storage = memoryStorage();
  const controllerState = createRunStateStore(8, undefined, storage, { id: "e" as any, run: "s" as any });
  let authority: "controller" | "observer" = "controller";
  const access = writes(client, () => authority);
  const controller = createDeliveryManager(() => client, access, controllerState);
  attach(controllerState);
  await controller.submit("s", "dropped delivery", true, "intent-1");
  controller.dispose(); controllerState.dispose();

  dropped = true;
  const observerState = createRunStateStore(8, undefined, storage, { id: "e" as any, run: "s" as any });
  authority = "observer";
  const observer = createDeliveryManager(() => client, access, observerState);
  observerState.activate("s");
  attach(observerState);
  await Bun.sleep(10);
  observerState.edit("s", { text: "draft kept while observing" });
  calls.length = 0;
  expect(() => observer.resend("s", "intent-1")).toThrow(ObserverWriteError);
  expect(() => observer.submit("s", "failed turn retry", false)).toThrow(ObserverWriteError);
  await Bun.sleep(10);

  expect(calls).toEqual([]);
  expect(observerState.get("s").text).toBe("draft kept while observing");
  observer.dispose(); observerState.dispose();
});

test("send and steer go to their methods with a delivery id when the feature is negotiated", async () => {
  const { client, calls } = await server(() => ok);
  const delivery = createDelivery();
  await delivery.submit(client, "hello", false, "id-1", "s");
  await delivery.submit(client, "also this", true, "id-2", "s");
  expect(calls).toEqual([["send", { text: "hello", session_id: "s", delivery_id: "id-1" }], ["steer", { text: "also this", session_id: "s", delivery_id: "id-2" }]]);
});

test("without the feature no delivery id is sent", async () => {
  const { client, calls } = await server(() => ok, []);
  await createDelivery().submit(client, "hello", false, "id-1", "s");
  expect(calls).toEqual([["send", { text: "hello", session_id: "s" }]]);
});

test("a turn that ends before a steer lands sends it instead, and one that starts before a send steers, with the same id", async () => {
  const { client, calls } = await server((method) => (method === "steer" ? { error: { code: -32005, message: "no turn is running" } } : ok));
  await createDelivery().submit(client, "late steer", true, "id-1", "s");
  const busy = await server((method) => (method === "send" ? { error: { code: -32004, message: "a turn is already running" } } : ok));
  await createDelivery().submit(busy.client, "early send", false, "id-1", "s");
  expect(calls).toEqual([["steer", { text: "late steer", session_id: "s", delivery_id: "id-1" }], ["send", { text: "late steer", session_id: "s", delivery_id: "id-1" }]]);
  expect(busy.calls).toEqual([["send", { text: "early send", session_id: "s", delivery_id: "id-1" }], ["steer", { text: "early send", session_id: "s", delivery_id: "id-1" }]]);
});

test("a dropped steer is an error and the retry gets a fresh id; an evicted id reports its outcome", async () => {
  let reply: Reply = { result: { accepted: false, duplicate: true, status: "dropped" } };
  const { client, calls } = await server(() => reply);
  const delivery = createDelivery();
  await expect(delivery.submit(client, "steer me", true, "id-1", "s")).rejects.toThrow("dropped");
  reply = { error: { code: -32010, message: "evicted", data: { outcome: "delivered" } } };
  await delivery.submit(client, "steer me", true, "id-2", "s");
  reply = { error: { code: -32010, message: "evicted", data: { outcome: "dropped" } } };
  await expect(delivery.submit(client, "again", true, "id-3", "s")).rejects.toThrow("dropped");
  expect(calls.map(([, params]) => params.delivery_id)).toEqual(["id-1", "id-2", "id-3"]);
});

test("opaque input sends one input_id frame and never falls back to text or steer", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client = { features: ["delivery_id"], request: async (method: string, params: Record<string, unknown>) => { calls.push([method, params]); return { accepted: true }; } } as any;
  const state = createRunStateStore(8, undefined, memoryStorage(), { id: "e" as any, run: "s" as any });
  state.activate("s");
  state.edit("s", { text: "/review change" });
  const manager = createDeliveryManager(() => client, writes(client), state);
  attach(state);
  await manager.submitOpaque("s", "opaque-secret", "/review change", "/review change", "delivery-1");
  expect(calls).toEqual([["send", { input_id: "opaque-secret", session_id: "s", delivery_id: "delivery-1" }]]);
  expect(JSON.stringify(state.get("s"))).not.toContain("opaque-secret");
  manager.dispose(); state.dispose();
});

test("uncertain opaque delivery persists display intent and reconciles without resending", async () => {
  const saved = memoryStorage();
  const calls: Array<[string, Record<string, unknown>]> = [];
  let uncertain = true;
  const client = { features: ["delivery_id"], request: async (method: string, params: Record<string, unknown>) => { calls.push([method, params]); if (uncertain) throw new Error("timeout"); return { status: "delivered" }; } } as any;
  let state = createRunStateStore(8, undefined, saved, { id: "e" as any, run: "s" as any });
  state.activate("s"); state.edit("s", { text: "/review change" });
  let manager = createDeliveryManager(() => client, writes(client), state);
  attach(state);
  await expect(manager.submitOpaque("s", "opaque-secret", "/review change", "/review change", "delivery-1")).rejects.toThrow("timeout");
  expect(calls).toEqual([["send", { input_id: "opaque-secret", session_id: "s", delivery_id: "delivery-1" }]]);
  expect(JSON.stringify(state.get("s"))).not.toContain("opaque-secret");
  expect(JSON.stringify([...saved.values])).not.toContain("opaque-secret");
  expect(JSON.stringify([...saved.values])).toContain("/review change");
  manager.dispose(); state.dispose();
  uncertain = false;
  state = createRunStateStore(8, undefined, saved, { id: "e2" as any, run: "s" as any });
  state.activate("s");
  manager = createDeliveryManager(() => client, writes(client), state);
  attach(state);
  await Bun.sleep(0);
  expect(calls).toEqual([
    ["send", { input_id: "opaque-secret", session_id: "s", delivery_id: "delivery-1" }],
    ["delivery_status", { delivery_id: "delivery-1" }],
  ]);
  manager.dispose(); state.dispose();
});

test("definitive opaque rejection restores display text and writes a run-local receipt", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const receipts: Array<[string, string]> = [];
  const rejected = Object.assign(new Error("turn already active"), { code: -32004 });
  const client = { features: ["delivery_id"], request: async (method: string, params: Record<string, unknown>) => { calls.push([method, params]); throw rejected; } } as any;
  const state = createRunStateStore(8, undefined, memoryStorage(), { id: "e" as any, run: "s" as any });
  state.activate("s"); state.edit("s", { text: "/review change\nkeep this draft" });
  const manager = createDeliveryManager(() => client, writes(client), state, undefined, undefined, (runId, text) => receipts.push([runId, text]));
  attach(state);
  await expect(manager.submitOpaque("s", "opaque-1", "/review change", "/review change", "delivery-1")).rejects.toThrow("turn already active");
  expect(state.get("s").text).toBe("/review change\nkeep this draft");
  expect(receipts).toEqual([["s", "turn already active"]]);
  expect(state.get("s").deliveries.size).toBe(0);
  expect(calls).toHaveLength(1);
  manager.dispose(); state.dispose();
});

test.each(["dropped", "unknown"])("reconciled opaque %s restores with a newline and writes the unknown-outcome receipt", async (status) => {
  const saved = memoryStorage();
  const calls: Array<[string, Record<string, unknown>]> = [];
  const receipts: Array<[string, string]> = [];
  let uncertain = true;
  const client = { features: ["delivery_id"], request: async (method: string, params: Record<string, unknown>) => {
    calls.push([method, params]);
    if (uncertain) throw new Error("timeout");
    return { status };
  } } as any;
  let state = createRunStateStore(8, undefined, saved, { id: "e" as any, run: "s" as any });
  state.activate("s"); state.edit("s", { text: "/review change" });
  let manager = createDeliveryManager(() => client, writes(client), state);
  attach(state);
  await expect(manager.submitOpaque("s", "opaque-1", "/review change", "/review change", "delivery-1")).rejects.toThrow("timeout");
  manager.dispose(); state.dispose();

  uncertain = false;
  state = createRunStateStore(8, undefined, saved, { id: "e2" as any, run: "s" as any });
  state.activate("s"); state.edit("s", { text: "keep this draft" });
  manager = createDeliveryManager(() => client, writes(client), state, undefined, undefined, (runId, text) => receipts.push([runId, text]));
  attach(state); await Bun.sleep(0);
  expect(state.get("s").text).toBe("/review change\nkeep this draft");
  expect(receipts).toEqual([["s", "outcome unknown; this command was not retried"]]);
  expect(calls.at(-1)).toEqual(["delivery_status", { delivery_id: "delivery-1" }]);
  manager.dispose(); state.dispose();
});

test("opaque uncertainty without delivery_id keeps display text and never retries", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client = { features: [], request: async (method: string, params: Record<string, unknown>) => { calls.push([method, params]); throw new Error("timeout"); } } as any;
  const state = createRunStateStore(8, undefined, memoryStorage(), { id: "e" as any, run: "s" as any });
  state.activate("s"); state.edit("s", { text: "/review change" });
  const manager = createDeliveryManager(() => client, writes(client), state);
  attach(state);
  await expect(manager.submitOpaque("s", "opaque-secret", "/review change", "/review change", "delivery-1")).rejects.toThrow("outcome unknown; this command was not retried");
  expect(calls).toEqual([["send", { input_id: "opaque-secret", session_id: "s" }]]);
  expect(state.get("s").text).toBe("/review change");
  expect(state.get("s").deliveries.size).toBe(0);
  manager.reconcile("s"); await Bun.sleep(0);
  expect(calls).toHaveLength(1);
  manager.dispose(); state.dispose();
});

test("stop is a session abort", async () => {
  const { client, calls } = await server(() => ({ result: { aborted: true } }));
  expect(await stopTurn(client)).toEqual({ aborted: true });
  expect(calls).toEqual([["abort", {}]]);
});

test("fake zeta without an echo leaves one queued synthetic user event", async () => {
  const { client } = await server(() => ok, ["delivery_id", "user_message_event", "user_message_delivery_id"], false);
  const events: unknown[] = [];
  const delivery = createDelivery((event) => events.push(event));
  await delivery.submit(client, "hello", false, "id-1", "s");
  expect(events).toEqual([{ type: "user_message", text: "hello", mode: "send", intent: "id-1", delivery_id: "id-1" }]);
  expect(new Set(events.map((event) => event.intent)).size).toBe(1);
});
