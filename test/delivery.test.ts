import { expect, test } from "bun:test";
import { createClient, fromZetaHistory, type Transport } from "@fulcrum/zeta";
import { createDelivery, createDeliveryManager, stopTurn } from "../src/delivery";
import { createRunStateStore } from "../src/run-state";
import { composerMethods } from "../scripts/fake-zeta";

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
const ids = () => { let n = 0; return () => `id-${++n}`; };
const ok = { result: { accepted: true } };
const memoryStorage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

test("fake reconnect history keeps the accepted steer and its terminal delivery status", async () => {
  let active = false;
  const fake = composerMethods(async () => {}, { get: () => active, set: (value) => { active = value; } });
  const before = fake.history.length;
  fake.handle("send", { text: "start", delivery_id: "fake-send" }, "s-reconnect", () => {});
  await Promise.resolve();
  active = true;
  fake.handle("steer", { text: "drop me", delivery_id: "fake-steer" }, "s-reconnect", () => {});
  fake.handle("abort", {}, "s-reconnect", () => {});
  const rows = fake.history.slice(before);
  expect(rows.some((row) => JSON.stringify(row).includes("drop me"))).toBe(true);
  const adapted = fromZetaHistory(rows);
  expect(adapted.some((event) => event.type === "delivery_status" && event.delivery_id === "fake-steer" && event.status === "dropped")).toBe(true);
  expect(adapted.some((event) => event.type === "error")).toBe(false);
});

test("a reload reconciles a queued steer from durable status and resends a dropped intent", async () => {
  let dropped = false; let statusQueries = 0;
  const { client, calls } = await server((method) => method === "delivery_status" ? { result: { status: dropped && statusQueries++ === 0 ? "dropped" : dropped ? "delivered" : "queued" } } : ok);
  const storage = memoryStorage();
  const beforeState = createRunStateStore(8, undefined, storage, { id: "e" as any, run: "s" as any });
  const before = createDeliveryManager(() => client, beforeState);
  await before.submit("s", "survive reload", true, "intent-1");
  before.dispose(); beforeState.dispose();
  dropped = true;
  const afterState = createRunStateStore(8, undefined, storage, { id: "e" as any, run: "s" as any });
  const after = createDeliveryManager(() => client, afterState);
  afterState.activate("s");
  after.reconcile("s");
  await Bun.sleep(10);
  const retryId = (calls.at(-1)?.[1] as { delivery_id?: string }).delivery_id;
  after.reconcile("s");
  await Bun.sleep(10);
  expect(calls.map(([method]) => method)).toEqual(["steer", "delivery_status", "send", "delivery_status"]);
  expect(retryId).not.toBe("intent-1");
  expect(afterState.get("s").deliveries.size).toBe(0);
});

test("send and steer go to their methods with a delivery id when the feature is negotiated", async () => {
  const { client, calls } = await server(() => ok);
  const delivery = createDelivery(ids());
  await delivery.submit(client, "hello", false);
  await delivery.submit(client, "also this", true);
  expect(calls).toEqual([["send", { text: "hello", delivery_id: "id-1" }], ["steer", { text: "also this", delivery_id: "id-2" }]]);
});

test("without the feature no delivery id is sent", async () => {
  const { client, calls } = await server(() => ok, []);
  await createDelivery(ids()).submit(client, "hello", false);
  expect(calls).toEqual([["send", { text: "hello" }]]);
});

test("a turn that ends before a steer lands sends it instead, and one that starts before a send steers, with the same id", async () => {
  const { client, calls } = await server((method) => (method === "steer" ? { error: { code: -32005, message: "no turn is running" } } : ok));
  await createDelivery(ids()).submit(client, "late steer", true);
  const busy = await server((method) => (method === "send" ? { error: { code: -32004, message: "a turn is already running" } } : ok));
  await createDelivery(ids()).submit(busy.client, "early send", false);
  expect(calls).toEqual([["steer", { text: "late steer", delivery_id: "id-1" }], ["send", { text: "late steer", delivery_id: "id-1" }]]);
  expect(busy.calls).toEqual([["send", { text: "early send", delivery_id: "id-1" }], ["steer", { text: "early send", delivery_id: "id-1" }]]);
});

test("a dropped steer is an error and the retry gets a fresh id; an evicted id reports its outcome", async () => {
  let reply: Reply = { result: { accepted: false, duplicate: true, status: "dropped" } };
  const { client, calls } = await server(() => reply);
  const delivery = createDelivery(ids());
  await expect(delivery.submit(client, "steer me", true)).rejects.toThrow("dropped");
  reply = { error: { code: -32010, message: "evicted", data: { outcome: "delivered" } } };
  await delivery.submit(client, "steer me", true);
  reply = { error: { code: -32010, message: "evicted", data: { outcome: "dropped" } } };
  await expect(delivery.submit(client, "again", true)).rejects.toThrow("dropped");
  expect(calls.map(([, params]) => params.delivery_id)).toEqual(["id-1", "id-2", "id-3"]);
});

test("stop is a session abort", async () => {
  const { client, calls } = await server(() => ({ result: { aborted: true } }));
  expect(await stopTurn(client)).toEqual({ aborted: true });
  expect(calls).toEqual([["abort", {}]]);
});

test("fake zeta without an echo leaves one queued synthetic user event", async () => {
  const { client } = await server(() => ok, ["delivery_id", "user_message_event", "user_message_delivery_id"], false);
  const events: unknown[] = [];
  const delivery = createDelivery(ids(), (event) => events.push(event));
  await delivery.submit(client, "hello", false);
  expect(events).toEqual([{ type: "user_message", text: "hello", mode: "send", intent: "id-1", delivery_id: "id-1" }]);
  expect(new Set(events.map((event) => event.intent)).size).toBe(1);
});
