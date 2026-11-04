import { expect, test } from "bun:test";
import { createClient, type Transport } from "@fulcrum/zeta";
import { createDelivery, stopTurn } from "../src/delivery";
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

test("fake reconnect history does not replay a steer dropped at turn end", async () => {
  let active = false;
  const fake = composerMethods(async () => {}, { get: () => active, set: (value) => { active = value; } });
  const before = fake.history.length;
  fake.handle("send", { text: "start", delivery_id: "fake-send" }, "s-reconnect", () => {});
  active = true;
  fake.handle("steer", { text: "drop me", delivery_id: "fake-steer" }, "s-reconnect", () => {});
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(fake.history.slice(before).some((row) => JSON.stringify(row).includes("drop me"))).toBe(false);
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

test("a retry of the same text after a failure reuses its id; the next message after success gets a new one", async () => {
  let fail = true;
  const { client, calls } = await server(() => (fail ? { error: { code: -32000, message: "unexpected server failure" } } : ok));
  const delivery = createDelivery(ids());
  await expect(delivery.submit(client, "hello", false)).rejects.toThrow("unexpected server failure");
  fail = false;
  await delivery.submit(client, "hello", false);
  await delivery.submit(client, "hello", false);
  expect(calls.map(([, params]) => params.delivery_id)).toEqual(["id-1", "id-1", "id-2"]);
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

test("a steer the turn dropped at its end is resent as a new message, in order; delivered ones are not", async () => {
  const status: Record<string, string> = { "id-1": "delivered", "id-2": "dropped", "id-3": "dropped" };
  const { client, calls } = await server((method, params) => (method === "delivery_status" ? { result: { delivery_id: params.delivery_id, status: status[params.delivery_id as string] } } : ok));
  const delivery = createDelivery(ids());
  await delivery.submit(client, "read first", true);
  await delivery.submit(client, "then this", true);
  await delivery.submit(client, "and this", true);
  calls.length = 0;
  await delivery.turnEnded(client);
  expect(calls).toEqual([
    ["delivery_status", { delivery_id: "id-1" }],
    ["delivery_status", { delivery_id: "id-2" }],
    ["delivery_status", { delivery_id: "id-3" }], // the turn has ended: every status is final, so they are read at once
    ["send", { text: "then this", delivery_id: "id-4" }],
    ["send", { text: "and this", delivery_id: "id-5" }],
  ]);
  calls.length = 0;
  await delivery.turnEnded(client);
  expect(calls).toEqual([]);
});

test("a dropped steer and its resend are one user row, which becomes the sent message in place", async () => {
  const { client } = await server((method, params) => (method === "delivery_status" ? { result: { delivery_id: params.delivery_id, status: "dropped" } } : ok));
  const delivery = createDelivery(ids());
  await delivery.submit(client, "run the tests", false);
  await delivery.submit(client, "also windows", true);
  await delivery.turnEnded(client);
  const { store } = client.forSession("s");
  const users = store.getOutline().filter((entry) => entry.kind === "user").map((entry) => store.getItem(entry.id));
  expect(users.map((item) => item?.type === "user" && item.event.type === "user_message" && `${item.event.mode}:${item.event.text}`)).toEqual(["send:run the tests", "send:also windows"]);
});

test("after a stop, dropped steers stay dropped and are reported by intent; delivered ones are not", async () => {
  const status: Record<string, string> = { "id-1": "dropped", "id-2": "delivered" };
  const { client, calls } = await server((method, params) => (method === "delivery_status" ? { result: { status: status[params.delivery_id as string] } } : ok));
  const delivery = createDelivery(ids());
  await delivery.submit(client, "never mind", true);
  await delivery.submit(client, "this one landed", true);
  await delivery.stop(client);
  calls.length = 0;
  expect(await delivery.turnEnded(client)).toEqual(["id-1"]);
  expect(calls).toEqual([["delivery_status", { delivery_id: "id-1" }], ["delivery_status", { delivery_id: "id-2" }]]);
});

test("one failed delivery_status query keeps the marks the other queries found", async () => {
  const { client } = await server((method, params) => method !== "delivery_status" ? ok
    : params.delivery_id === "id-1" ? { error: { code: -32003, message: "socket dropped" } } : { result: { status: "dropped" } });
  const delivery = createDelivery(ids());
  await delivery.submit(client, "first", true);
  await delivery.submit(client, "second", true);
  await delivery.stop(client);
  expect(await delivery.turnEnded(client)).toEqual(["id-2"]);
});

test("a stop that failed, or found no turn, is not a stop: steers the turn's own end dropped are resent", async () => {
  for (const abort of [{ error: { code: -32003, message: "socket dropped" } }, { result: { aborted: false } }]) {
    const { client, calls } = await server((method) => method === "abort" ? abort : method === "delivery_status" ? { result: { status: "dropped" } } : ok);
    const delivery = createDelivery(ids());
    await delivery.submit(client, "keep going", true);
    await delivery.stop(client).catch(() => {});
    calls.length = 0;
    expect(await delivery.turnEnded(client)).toEqual([]);
    expect(calls.map(([method]) => method)).toEqual(["delivery_status", "send"]);
  }
});

test("stop is a session abort", async () => {
  const { client, calls } = await server(() => ({ result: { aborted: true } }));
  expect(await stopTurn(client)).toEqual({ aborted: true });
  expect(calls).toEqual([["abort", {}]]);
});

test("accepted delivery without an echo reconciles one synthetic user event", async () => {
  const { client } = await server(() => ok, ["delivery_id", "user_message_event", "user_message_delivery_id"], false);
  const events: unknown[] = [];
  const delivery = createDelivery(ids(), (event) => events.push(event));
  await delivery.submit(client, "hello", false);
  expect(events).toEqual([{ type: "user_message", text: "hello", mode: "send", intent: "id-1", delivery_id: "id-1" }]);
});
