import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as fakeZeta from "../scripts/fake-zeta";
import { ACTIVE, startFakeZeta } from "../scripts/fake-zeta";

// The strict fake must reject exactly what real zeta 169fb144 rejects with -32602 (see PARAM_RULES in
// scripts/fake-zeta.ts for the zeta source lines), and never be stricter: an unknown param stays accepted.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const VALID: Record<string, Record<string, unknown>> = {
  new_session: {},
  resume: { session_id: ACTIVE },
  list_sessions: {},
  status: {},
  send: { text: "hello" },
  steer: { text: "hello" },
  delivery_status: { delivery_id: "web-1" },
  send_images: { session_id: ACTIVE, text: "", images: [{ name: "a.png", mime_type: "image/png", data: PNG }] },
  approve: { request_id: "approval-1" },
  deny: { request_id: "approval-1" },
  abort: {},
  session_history: { session_id: ACTIVE },
  session_tree: { session_id: ACTIVE },
  rename_session: { session_id: ACTIVE, name: "renamed" },
  switch_branch: { session_id: ACTIVE, head_id: "head-main" },
  set_settings: { session_id: ACTIVE, model: "gpt-5.1-codex", approval_mode: "ask" },
  session_settings: { session_id: ACTIVE },
  model_catalog: {},
  slash_list: { session_id: ACTIVE },
  slash_run: { session_id: ACTIVE, text: "/status" },
};
// What real zeta 169fb144 rejects with -32602, written out independently of the fake's table (zeta lines are cited
// there, in PARAM_RULES): required nonempty-string params, exactly-one-of params, and params gated by a feature.
const REQUIRED: Record<string, string[]> = { resume: ["session_id"], steer: ["text"], delivery_status: ["delivery_id"], send_images: ["session_id"], approve: ["request_id"], deny: ["request_id"], session_history: ["session_id"], session_tree: ["session_id"], rename_session: ["session_id"], switch_branch: ["session_id", "head_id"], set_settings: ["session_id", "model", "approval_mode"], session_settings: ["session_id"], slash_list: ["session_id"], slash_run: ["session_id", "text"] };
const ONE_OF: Record<string, string[]> = { send: ["text", "input_id"] };
// Each gated param with a value of the right shape, so only the missing feature can reject it.
const GATED: Record<string, Record<string, unknown>> = {
  new_session: { approval_mode: "ask", cwd: "/tmp", host_commands: [] },
  resume: { host_commands: [] },
  list_sessions: { offset: 0, limit: 1, project_id: "p" },
  send: { input_id: "i", delivery_id: "web-2" },
  steer: { delivery_id: "web-2" },
  send_images: { delivery_id: "web-2" },
  abort: { scope: "foreground" },
  session_history: { before: null, history_validator: { end: 0, entry_id: null } },
};

type Frame = { id?: number; result?: unknown; error?: { code: number; message: string } };
async function withFake(features: string[], body: (request: (method: string, params: Record<string, unknown>) => Promise<Frame>) => Promise<void>) {
  const fake = await startFakeZeta({ origins: ["http://127.0.0.1:4224"], port: 0, live: false });
  const discovery = JSON.parse(await readFile(join(fake.home, "run", "serve.ws.json"), "utf8")) as { controller_token: string };
  const socket = new WebSocket(`ws://127.0.0.1:${fake.port}/`, ["zeta.v1", `zeta.bearer.${discovery.controller_token}`]);
  const pending = new Map<number, (frame: Frame) => void>();
  let id = 0;
  socket.addEventListener("message", (message) => { const frame = JSON.parse(String(message.data)) as Frame; if (typeof frame.id === "number") { pending.get(frame.id)?.(frame); pending.delete(frame.id); } });
  const request = (method: string, params: Record<string, unknown>) => Promise.race([
    new Promise<Frame>((resolve) => { const requestId = ++id; pending.set(requestId, resolve); socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })); }),
    Bun.sleep(10_000).then((): Frame => { throw new Error(`timed out waiting for ${method}`); }),
  ]);
  try {
    await Promise.race([new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true }); }), Bun.sleep(10_000).then(() => { throw new Error("socket open timed out"); })]);
    const hello = await request("hello", { protocol_version: "1.2", client_version: "1.2", role: "controller", features });
    expect(hello.error).toBeUndefined();
    await body(request);
  } finally {
    socket.close();
    await fake.close();
  }
}
const code = (frame: Frame) => frame.error?.code ?? "ok";

test("every method the strict fake checks is in this matrix", () => {
  expect(Object.keys(VALID).sort()).toEqual(Object.keys((fakeZeta as { PARAM_RULES?: object }).PARAM_RULES ?? {}).sort());
});

test("the fake rejects each missing required param and each feature-gated param without its feature with -32602", async () => {
  const rows: string[] = [];
  await withFake([], async (request) => {
    for (const [method, names] of Object.entries(REQUIRED)) for (const name of names) {
      const { [name]: _, ...params } = VALID[method]!;
      rows.push(`${method} without ${name}: ${code(await request(method, params))}`);
    }
    for (const [method, names] of Object.entries(ONE_OF)) {
      const params = Object.fromEntries(Object.entries(VALID[method]!).filter(([key]) => !names.includes(key)));
      rows.push(`${method} with none of ${names.join("/")}: ${code(await request(method, params))}`);
      rows.push(`${method} with both ${names.join("/")}: ${code(await request(method, { ...params, ...Object.fromEntries(names.map((key) => [key, "x"])) }))}`);
    }
    for (const [method, values] of Object.entries(GATED)) for (const [name, value] of Object.entries(values)) rows.push(`${method} ${name} without its feature: ${code(await request(method, { ...VALID[method], [name]: value }))}`);
  });
  // delivery_id alone is not enough for send_images (zeta 169fb144 src/zeta/server/delivery.py:131-133, 370-381).
  await withFake(["delivery_id"], async (request) => {
    rows.push(`send_images delivery_id with only delivery_id: ${code(await request("send_images", { ...VALID.send_images, delivery_id: "web-3" }))}`);
  });
  expect(rows.length).toBeGreaterThan(25);
  expect(rows.filter((row) => !row.endsWith(": -32602"))).toEqual([]);
});

test("the fake accepts an unknown param wherever real zeta does, and the feature-gated image delivery_id once negotiated", async () => {
  const rows: string[] = [];
  await withFake(["delivery_id", "send_images_delivery_id", "session_grants"], async (request) => {
    rows.push(`send_images delivery_id with both features: ${code(await request("send_images", { ...VALID.send_images, delivery_id: "web-4" }))}`);
    for (const method of Object.keys(VALID)) rows.push(`${method} unknown param: ${code(await request(method, { ...VALID[method], bogus_param: 1 }))}`);
    // The unknown-param rejections zeta does have (src/zeta/server/control.py:1062-1100).
    rows.push(`session_grants unknown param rejected: ${code(await request("session_grants", { bogus_param: 1 }))}`);
    rows.push(`revoke_session_grants unknown param rejected: ${code(await request("revoke_session_grants", { grant: "read", bogus_param: 1 }))}`);
  });
  expect(rows.filter((row) => row.includes("rejected") !== row.endsWith(": -32602"))).toEqual([]);
});
