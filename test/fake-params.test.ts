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
// steer's text is checked only once a turn runs (delivery.py:233-235), so it has its own rows below.
const REQUIRED: Record<string, string[]> = { resume: ["session_id"], delivery_status: ["delivery_id"], send_images: ["session_id"], approve: ["request_id"], deny: ["request_id"], session_history: ["session_id"], session_tree: ["session_id"], rename_session: ["session_id"], switch_branch: ["session_id", "head_id"], set_settings: ["session_id", "model", "approval_mode"], session_settings: ["session_id"], slash_list: ["session_id"], slash_run: ["session_id", "text"] };
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
type Request = (method: string, params: Record<string, unknown>) => Promise<Frame>;
type Fake = Awaited<ReturnType<typeof startFakeZeta>>;
async function withFake(features: string[], body: (request: Request, fake: Fake) => Promise<void>) {
  const fake = await startFakeZeta({ origins: ["http://127.0.0.1:4224"], port: 0, live: false });
  const discovery = JSON.parse(await readFile(join(fake.home, "run", "serve.ws.json"), "utf8")) as { controller_token: string };
  const socket = new WebSocket(`ws://127.0.0.1:${fake.port}/`, ["zeta.v1", `zeta.bearer.${discovery.controller_token}`]);
  const pending = new Map<number, (frame: Frame) => void>();
  let id = 0;
  socket.addEventListener("message", (message) => { const frame = JSON.parse(String(message.data)) as Frame; if (typeof frame.id === "number") { pending.get(frame.id)?.(frame); pending.delete(frame.id); } });
  const request: Request = (method, params) => Promise.race([
    new Promise<Frame>((resolve) => { const requestId = ++id; pending.set(requestId, resolve); socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })); }),
    Bun.sleep(10_000).then((): Frame => { throw new Error(`timed out waiting for ${method}`); }),
  ]);
  try {
    await Promise.race([new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true }); }), Bun.sleep(10_000).then(() => { throw new Error("socket open timed out"); })]);
    const hello = await request("hello", { protocol_version: "1.2", client_version: "1.2", role: "controller", features });
    expect(hello.error).toBeUndefined();
    await body(request, fake);
  } finally {
    socket.close();
    await fake.close();
  }
}
const code = (frame: Frame) => frame.error?.code ?? "ok";
/** Rows of `label: outcome`, with the outcome real zeta 169fb144 gives kept beside the one the fake gave. */
function outcomes() {
  const got: string[] = [];
  const want: string[] = [];
  return { got, want, async check(label: string, expected: number | "ok", reply: Promise<Frame>) { want.push(`${label}: ${expected}`); got.push(`${label}: ${code(await reply)}`); } };
}

test("every method the strict fake checks is in this matrix", () => {
  expect(Object.keys(VALID).sort()).toEqual(Object.keys((fakeZeta as { PARAM_RULES?: object }).PARAM_RULES ?? {}).sort());
});

test("the fake rejects each missing required param and each feature-gated param without its feature, in zeta's order", async () => {
  const rows = outcomes();
  const image = VALID.send_images!.images as unknown[];
  await withFake(["delivery_id"], async (request, fake) => {
    for (const [method, names] of Object.entries(REQUIRED)) for (const name of names) {
      const { [name]: _, ...params } = VALID[method]!;
      await rows.check(`${method} without ${name}`, -32602, request(method, params));
    }
    for (const [method, names] of Object.entries(ONE_OF)) {
      const params = Object.fromEntries(Object.entries(VALID[method]!).filter(([key]) => !names.includes(key)));
      await rows.check(`${method} with none of ${names.join("/")}`, -32602, request(method, params));
      await rows.check(`${method} with both ${names.join("/")}`, -32602, request(method, { ...params, ...Object.fromEntries(names.map((key) => [key, "x"])) }));
    }
    // delivery.py:537-538: text must have a non-space character.
    await rows.check("send with empty text", -32602, request("send", { text: "" }));
    await rows.check("send with blank text", -32602, request("send", { text: "  \n" }));
    // image_delivery.py:49-57: 1 to 4 images.
    const { images: _, ...noImages } = VALID.send_images!;
    await rows.check("send_images without images", -32602, request("send_images", noImages));
    await rows.check("send_images with no images", -32602, request("send_images", { ...noImages, images: [] }));
    await rows.check("send_images with five images", -32602, request("send_images", { ...noImages, images: [...image, ...image, ...image, ...image, ...image] }));
    // delivery.py:131-133, 370-381: delivery_id alone is not enough for send_images.
    await rows.check("send_images delivery_id with only delivery_id", -32602, request("send_images", { ...VALID.send_images, delivery_id: "web-3" }));
    // delivery.py:233-235: with no turn, steer is -32005 before its text is read.
    await rows.check("steer without text, no turn", -32005, request("steer", {}));
    fake.setHoldTurns(true);
    await rows.check("send starts a held turn", "ok", request("send", { text: "start" }));
    await rows.check("steer without text, turn running", -32602, request("steer", {}));
    // The busy check comes before these params: delivery.py:61 before :65 (send), :136 before :142 (send_images),
    // server.py:956 before :959-960 (set_settings), server.py:631 before :633-634 (new_session cwd).
    await rows.check("send with none of text/input_id, turn running", -32004, request("send", {}));
    await rows.check("send with blank text, turn running", -32004, request("send", { text: " " }));
    await rows.check("send_images without images, turn running", -32004, request("send_images", noImages));
    await rows.check("set_settings without model, turn running", -32004, request("set_settings", { session_id: ACTIVE, approval_mode: "ask" }));
    await rows.check("new_session cwd without its feature, turn running", -32004, request("new_session", { cwd: "/tmp" }));
    await rows.check("abort the held turn", "ok", request("abort", {}));
  });
  await withFake([], async (request) => {
    for (const [method, values] of Object.entries(GATED)) for (const [name, value] of Object.entries(values)) await rows.check(`${method} ${name} without its feature`, -32602, request(method, { ...VALID[method], [name]: value }));
    // protocol.py:301, :553-554: the method itself needs the delivery_id feature.
    await rows.check("delivery_status without the delivery_id feature", -32601, request("delivery_status", VALID.delivery_status!));
  });
  expect(rows.got.length).toBeGreaterThan(35);
  expect(rows.got).toEqual(rows.want);
});

test("the fake accepts an unknown param wherever real zeta does, and the feature-gated params zeta accepts", async () => {
  const rows = outcomes();
  await withFake(["delivery_id", "send_images_delivery_id", "session_grants"], async (request, fake) => {
    fake.setHoldTurns(true);
    // Each send leaves a held turn; abort it so the next request meets an idle session, as its expected outcome assumes.
    const idle = () => rows.check("abort", "ok", request("abort", {}));
    await rows.check("send_images delivery_id with both features", "ok", request("send_images", { ...VALID.send_images, delivery_id: "web-4" }));
    await idle();
    // server.py:624-626: a null approval_mode needs no feature (new_session_settings is not negotiated here).
    await rows.check("new_session approval_mode null without its feature", "ok", request("new_session", { approval_mode: null }));
    await rows.check("resume", "ok", request("resume", { session_id: ACTIVE }));
    // core/session.py:788-794: a blank name clears the session name; zeta does not reject it.
    await rows.check("rename_session with an empty name", "ok", request("rename_session", { session_id: ACTIVE, name: "" }));
    for (const method of Object.keys(VALID)) {
      if (method === "steer") await rows.check("send before steer", "ok", request("send", { text: "start" }));
      // server.py:728-747: approval-1 is not pending, so approve and deny get past their params to -32006.
      await rows.check(`${method} unknown param`, method === "approve" || method === "deny" ? -32006 : "ok", request(method, { ...VALID[method], bogus_param: 1 }));
      if (method === "new_session") await rows.check("resume", "ok", request("resume", { session_id: ACTIVE }));
      if (method === "send" || method === "steer" || method === "send_images") await idle();
    }
    // The unknown-param rejections zeta does have (src/zeta/server/control.py:1062-1100).
    await rows.check("session_grants unknown param rejected", -32602, request("session_grants", { bogus_param: 1 }));
    await rows.check("revoke_session_grants unknown param rejected", -32602, request("revoke_session_grants", { grant: "read", bogus_param: 1 }));
  });
  expect(rows.got).toEqual(rows.want);
});

// zeta 1bf97c3c protocol.py:560-583 and docs/serve-protocol.md:491-518 (delivery_session_guard): a delivery named for a
// session that is not attached returns -32003 with data.code session_mismatch, before the delivery_id lookup, and zeta
// records nothing (no row, no echo, no turn, no delivery_id record).
test("delivery_session_guard: a mismatched send, steer, or send_images records nothing and starts no turn", async () => {
  const mismatch = (frame: Frame) => (frame.error as { data?: unknown } | undefined)?.data;
  const want = { code: "session_mismatch", attached_session_id: ACTIVE, session_id: "other" };
  await withFake(["delivery_id", "send_images_delivery_id", "delivery_session_guard"], async (request, fake) => {
    const send = await request("send", { text: "wrong run", session_id: "other", delivery_id: "web-g1" });
    expect([code(send), mismatch(send)]).toEqual([-32003, want]);
    expect(fake.sent).toEqual([]);
    expect(fake.running).toBe(false);
    // Nothing was recorded for web-g1: the same id in the attached session is a first delivery, not a duplicate.
    fake.setHoldTurns(true);
    const right = await request("send", { text: "right run", session_id: ACTIVE, delivery_id: "web-g1" });
    expect(right.result).toMatchObject({ accepted: true });
    expect(right.result).not.toHaveProperty("duplicate");
    const steer = await request("steer", { text: "wrong steer", session_id: "other", delivery_id: "web-g2" });
    expect([code(steer), mismatch(steer)]).toEqual([-32003, want]);
    await request("abort", {});
    const images = await request("send_images", { ...VALID.send_images, session_id: "other", delivery_id: "web-g3" });
    expect([code(images), mismatch(images)]).toEqual([-32003, want]);
    expect(fake.sent.map((item) => item.text)).toEqual(["right run"]);
  });
  // Without the feature the fake is an older zeta: session_id on send is ignored and the message lands in the attached session.
  await withFake(["delivery_id"], async (request, fake) => {
    expect(code(await request("send", { text: "old server", session_id: "other" }))).toBe("ok");
    expect(fake.sent.map((item) => item.session)).toEqual([ACTIVE]);
  });
});
