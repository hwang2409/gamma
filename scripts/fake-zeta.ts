// A scripted `zeta serve --ws` for the browser gate and for trying the app without a real zeta. It speaks the subset
// of protocol 1.2 the app uses (hello, list_sessions, new_session, status, resume, session_history, approve, deny,
// send, steer, abort, with the delivery_id and user_message_event features), checks the
// bearer subprotocol and Origin like the real upgrade, and writes the discovery file under its own ZETA_HOME, never ~/.zeta.
//
// Manual use: `bun scripts/fake-zeta.ts`, then start vite with the printed ZETA_HOME.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { completeSlashCatalog, defaultSlashCatalog } from "./fake-slash-catalog";

type Json = Record<string, unknown>;
export type Mode = "ok" | "busy" | "incompatible" | "slow" | "slow-catalog" | "broken-session";
export type HistoryMode = "new" | "old";
export type ApprovalHistoryMode = "advertised-with-rows" | "not-advertised-with-rows" | "not-advertised-without-rows";

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const meta = (id: string, minutesAgo: number, extra: Json = {}) => ({
  version: 1, session_id: id, created_at: at(minutesAgo + 30), updated_at: at(minutesAgo), provider: "claude", model: "claude-opus-4-6",
  cwd: "/Users/dev/me/fun/fulcrum", name: "", parent_session_id: null, approval_mode: "ask", ...extra,
});

export const ACTIVE = "s-reconnect";
export const LONG = "s-long";
export const MANY = "s-many";
export const LARGE = "s-large-pages";
const seeded = [
  meta(ACTIVE, 2, { name: "fix the flaky reconnect test in packages/zeta" }),
  meta("s-themes", 45, { first_message_preview: "check every theme's muted text against 4.5:1 on the surface color" }),
  meta(LONG, 60 * 5, { first_message_preview: "profile the virtual timeline with 400 rows of history" }),
  meta("s-child", 3, { parent_session_id: ACTIVE, first_message_preview: "worker: run the zeta tests" }),
  meta("s-markdown", 60 * 26, { name: "streaming markdown: nested lists in block quotes", model: "gpt-5.1-codex" }),
  meta("s-docs", 60 * 24 * 3, { first_message_preview: "write the quickstart for @fulcrum/react" }),
  meta("s-untitled", 60 * 24 * 40),
];

/**
 * The params real zeta 169fb144 rejects with -32602, for every request the fake serves after hello. `required` params
 * must be nonempty strings, `oneOf` needs exactly one of its keys, a present `nonblank` param needs a non-space
 * character, a `lists` param must be a list of that many items, and a `gated` param needs every listed feature.
 * Order matters when zeta checks state between params, so a rule has up to three stages, as in zeta: the top level is
 * checked on dispatch, `afterSession` once the active session check (-32003) passed, and `afterTurn` once the turn
 * check passed (-32004 busy, or -32005 for steer with no turn); the handler runs the later stages at those points.
 * Unknown params are accepted, as in zeta: its only unknown-param rejections are session_grants and
 * revoke_session_grants (server/control.py:1062-1100, owned by `handleGrantRequest` below), backward session_history
 * (server/ergonomics.py:1073, never negotiated here), content_read (connections.py:1011), and the project methods
 * (project_requests.py:485, entry_project_views.py:279), which the fake does not serve.
 * Zeta maps ValueError and ProtocolError(INVALID_PARAMS) to -32602 (server/server.py:439-444).
 */
type ParamChecks = { required?: readonly string[]; oneOf?: readonly string[]; nonblank?: readonly string[]; lists?: Readonly<Record<string, readonly [number, number]>>; gated?: Readonly<Record<string, readonly string[]>> };
type ParamRule = ParamChecks & { afterSession?: ParamChecks; afterTurn?: ParamChecks };
export const PARAM_RULES: Readonly<Record<string, ParamRule>> = {
  // server.py:630 + :827-831 (host_commands), then the busy check (:631, control.py:208-210), then :633-634 (cwd).
  // approval_mode is gated only when it is not null (server.py:624-626, `_optional_string`), so the handler checks it.
  new_session: { gated: { host_commands: ["session_host_commands"] }, afterTurn: { gated: { cwd: ["session_cwd"] } } },
  // server.py:662 (host_commands), :663 -> control.py:209-213 (busy: -32004), then :664 (session_id). The fake checks
  // session_id on dispatch, so a busy resume without session_id gets -32602 where zeta answers -32004; both reject.
  resume: { required: ["session_id"], gated: { host_commands: ["session_host_commands"] } },
  // server.py:1077-1084.
  list_sessions: { gated: { offset: ["list_sessions_paging"], limit: ["list_sessions_paging"], project_id: ["projects"] } },
  status: {},
  // delivery.py:53-54 (no active session), :55 + :370-381 (delivery_id), :61-64 (busy), then :65 -> :529-545 (exactly
  // one of text or input_id; text must have a non-space character; input_id needs model_input_ids).
  send: { afterSession: { gated: { delivery_id: ["delivery_id"] } }, afterTurn: { oneOf: ["text", "input_id"], nonblank: ["text"], gated: { input_id: ["model_input_ids"] } } },
  // delivery.py:226-227 (no active session), :228 (delivery_id), :233-234 (no turn: -32005), then :235 (text).
  steer: { afterSession: { gated: { delivery_id: ["delivery_id"] } }, afterTurn: { required: ["text"] } },
  // delivery.py:353 (the method itself needs the delivery_id feature: protocol.py:301, :553-554 answer -32601 first).
  delivery_status: { required: ["delivery_id"] },
  // server.py:923 -> ergonomics.py:85-93 (session_id), delivery.py:131-133 (delivery_id needs both features), :136-139
  // (busy), then :142 -> image_delivery.py:128 -> :49-57 (1 to 4 images).
  send_images: { required: ["session_id"], afterSession: { gated: { delivery_id: ["delivery_id", "send_images_delivery_id"] } }, afterTurn: { lists: { images: [1, 4] } } },
  // server.py:728-747.
  approve: { required: ["request_id"] },
  deny: { required: ["request_id"] },
  // server.py:748-751 -> abort_scope.py:32-45.
  abort: { gated: { scope: ["abort_scope"] } },
  // connections.py:1021-1022 -> ergonomics.py:85-93; ergonomics.py:1114-1119 (backward keys).
  session_history: { required: ["session_id"], gated: { before: ["session_history_backward"], history_validator: ["session_history_backward"] } },
  session_tree: { required: ["session_id"] },
  // server.py:900-906: session_id (:903), then ergonomics.py:79-80 (name must be a string); no busy check.
  rename_session: { required: ["session_id"] },
  // server.py:923, then :956 (busy) before :973 (head_id). The fake does not model a busy switch_branch, so while a turn
  // runs it answers -32602 for a missing head_id where zeta answers -32004; both reject.
  switch_branch: { required: ["session_id", "head_id"] },
  // server.py:923 (session_id), :956 (busy), then :959-960 (model, approval_mode).
  set_settings: { required: ["session_id"], afterTurn: { required: ["model", "approval_mode"] } },
  session_settings: { required: ["session_id"] },
  model_catalog: {},
  slash_list: { required: ["session_id"] },
  slash_run: { required: ["session_id", "text"] },
};
/** The -32602 message real zeta would send for these params at this stage, or null when it accepts them. */
function invalidParams(method: string, checks: ParamChecks | undefined, params: Json, features: readonly string[]): string | null {
  if (!checks) return null;
  for (const name of checks.required ?? []) if (typeof params[name] !== "string" || !params[name]) return `${name} must be a nonempty string`;
  if (checks.oneOf && checks.oneOf.filter((name) => name in params).length !== 1) return `${method} requires exactly one of ${checks.oneOf.join(" or ")}`;
  for (const name of checks.nonblank ?? []) {
    const value = params[name];
    if (name in params && (typeof value !== "string" || !value.trim())) return `${name} must be a nonempty string`;
  }
  for (const [name, [min, max]] of Object.entries(checks.lists ?? {})) {
    const value = params[name];
    if (!Array.isArray(value) || value.length < min || value.length > max) return `${method} needs ${min} to ${max} ${name}`;
  }
  for (const [name, needs] of Object.entries(checks.gated ?? {})) {
    const missing = needs.find((feature) => !features.includes(feature));
    if (name in params && missing) return `${name} requires the negotiated ${missing} feature`;
  }
  return null;
}

const SETTINGS_REQUESTS = ["model_catalog", "session_settings", "set_settings", "send_images"];

// Opaque command inputs by id. Zeta echoes an opaque input's display_text, the typed command line, as the user
// message (zeta dcc4ce9 src/zeta/core/slash.py:767 display_text=value; src/zeta/server/delivery.py:107-108).
const opaqueInputs = new Map<string, string>();
const text = (value: string) => ({ type: "text", text: value });
const toolUse = (id: string, name: string, args: Json = {}) => ({ type: "tool_use", tool_call: { id, name, arguments: args } });
// History keeps a result's text only; bash's is "stdout:\n" + stdout + "\nstderr:\n" + stderr (zeta src/zeta/tools/bash).
const result = (id: string, content: string, extra: Json = {}) => ({ tool_call_id: id, content, is_error: false, content_blocks: [], structured_content: null, ...extra });
const historySeed: Record<string, Json[]> = {
  [ACTIVE]: [
    { id: "h1", role: "user", content: [text("the reconnect test in packages/zeta fails about one run in ten. find out why and fix it.")], tool_result: null },
    { id: "h2", role: "assistant", content: [{ type: "thinking", text: "start with the test and the client close path." }, text("I will read the test first, then run it in a loop."), toolUse("c1", "read")], tool_result: null },
    { id: "h3", role: "tool_result", content: [text("")], tool_result: result("c1", "import { expect, test } from \"bun:test\";\nimport { connect } from \"../src/index.js\";\n\ntest(\"reconnects\", async () => {\n  const client = connect(transport);\n  await client.hello();\n});") },
    { id: "h4", role: "assistant", content: [toolUse("c2", "bash", { command: "bun test packages/zeta/test/rpc.test.ts" })], tool_result: null },
    { id: "h5", role: "tool_result", content: [text("")], tool_result: result("c2", "stdout:\nbun test v1.3.13\n\n packages/zeta/test/rpc.test.ts:\n(fail) reconnects [5003.12ms]\n  timed out after 5000ms\n\n 4 pass\n 1 fail\n\nstderr:\n", { is_error: true }) },
    {
      id: "h6", role: "assistant", tool_result: null, content: [text(
        "The failure is a race in the close path:\n\n1. `transport.close()` fires `onClose` **before** pending requests reject.\n2. The test awaits `hello()`, which never settles.\n\n```ts\ntransport.onClose?.((code) => {\n  const error = rejectPending(code); // reject first\n  closeListeners.forEach((listener) => listener(error));\n});\n```\n\nI will fix the order and add a test that fails without it.",
      )],
    },
  ],
  "s-themes": [
    { id: "t1", role: "user", content: [text("check every theme's muted text against 4.5:1 on the surface color")], tool_result: null },
    { id: "t1b", role: "assistant", content: [toolUse("t-ls", "bash")], tool_result: null },
    // As in zeta: tool_use arguments are emptied, but an approved call's approval rows keep them.
    { id: "t1b", role: "system", event: "approval_request", request_id: "t-ls", tool_call: { id: "t-ls", name: "bash", arguments: { command: "ls packages/react/src" } }, delegated: false },
    { id: "t1c", role: "system", event: "approval_end", request_id: "t-ls", tool_call: { id: "t-ls", name: "bash", arguments: { command: "ls packages/react/src" } }, data: { decision: "allow" } },
    { id: "t1d", role: "tool_result", content: [text("stdout:\nthemes.css\nthemes.ts\n\nstderr:\n")], tool_result: result("t-ls", "stdout:\nthemes.css\nthemes.ts\n\nstderr:\n", { content_blocks: [{ type: "image", mimeType: "image/png", path: "contrast-preview.png", width: 1, height: 1, size: 68, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] }) },
    { id: "t2", role: "assistant", content: [text("All 12 themes pass on `bg`. On `surface`, **solarized-light** is closest at 4.61:1.\n\n| theme | bg | surface |\n| --- | --- | --- |\n| gruvbox-dark | 5.9 | 5.4 |\n| solarized-light | 4.9 | 4.61 |")], tool_result: null },
  ],
  [LONG]: Array.from({ length: 400 }, (_, index) => index % 2 === 0
    ? { id: `l${index}`, role: "user", content: [text(`step ${index / 2 + 1}: measure frame ${index}`)], tool_result: null }
    : { id: `l${index}`, role: "assistant", content: [text(`frame ${index} took **${(index % 7) + 3} ms**; \`content-visibility\` skipped ${index * 3} rows.`)], tool_result: null }),
};
const createHistories = (): Record<string, Json[]> => Object.fromEntries(
  Object.entries(historySeed).map(([sessionId, rows]) => [sessionId, [...rows]]),
);

/** The live turn that runs when the active session opens: prose, code, a shell call, an approval, then a summary. */
const liveTurn = (send: (event: Json) => void, ask: () => Promise<"approve" | "deny" | "abort">, wait: (ms: number) => Promise<void>, done: () => void, histories: Record<string, Json[]>, historyMode: HistoryMode, grantProof = false, setPending: (requestId: string, call: Json) => void = () => {}) => async () => {
  // Committed rows also land in history, as in zeta, so a reconnect rebuilds what the live stream showed.
  const history = histories[ACTIVE]!;
  const row = (id: string, role: string, content: Json[], toolResult: Json | null = null) => history.push({ id, role, content, tool_result: toolResult });
  const e = (event: string, body: Json = {}) => send({ event, session_id: ACTIVE, ...body });
  e("agent_start");
  e("turn_start", { data: { turn: 2 } });
  for (const chunk of ["Running the test ", "in a loop to confirm ", "the race:\n\n```sh\nfor i in $(seq 20); do bun test test/rpc.test.ts; done\n```\n"]) {
    e("assistant_delta", { delta: chunk, kind: "assistant" });
    await wait(40);
  }
  e("assistant_message", { message: { role: "assistant", content: [text("Running the test in a loop to confirm the race:\n\n```sh\nfor i in $(seq 20); do bun test test/rpc.test.ts; done\n```\n")] } });
  const loop = { id: "live-1", name: "bash", arguments: { command: "for i in $(seq 20); do bun test test/rpc.test.ts; done" } };
  row("r1", "assistant", [text("Running the test in a loop to confirm the race:\n\n```sh\nfor i in $(seq 20); do bun test test/rpc.test.ts; done\n```\n"), toolUse("live-1", "bash")]);
  e("tool_start", { tool_call: loop, data: {} });
  for (let run = 1; run <= 3; run++) {
    e("tool_output", { tool_call: loop, output: `run ${run}: 5 pass, 0 fail\n`, data: {} });
    await wait(40);
  }
  row("r2", "tool_result", [text("")], result("live-1", "run 1: 5 pass, 0 fail\nrun 2: 5 pass, 0 fail\nrun 3: 5 pass, 0 fail\n"));
  e("tool_end", { tool_call: loop, tool_result: result("live-1", "run 1: 5 pass, 0 fail\nrun 2: 5 pass, 0 fail\nrun 3: 5 pass, 0 fail\n", { structured_content: { exit_code: 0, stdout: "run 1: 5 pass, 0 fail\nrun 2: 5 pass, 0 fail\nrun 3: 5 pass, 0 fail\n", stderr: "" } }), data: {} });
  const clean = { id: "live-2", name: "bash", arguments: { command: "rm -rf packages/zeta/dist && bun run build" } };
  row("r3", "assistant", [toolUse("live-2", "bash")]);
  setPending("approval-1", clean);
  const approval = ask();
  e("approval_request", { request_id: "approval-1", tool_call: clean, delegated: false });
  if (historyMode === "new") history.push({ id: "approval-request-1", role: "system", event: "approval_request", request_id: "approval-1", tool_call: clean, delegated: false });
  const decision = await approval;
  if (decision === "abort") return done();
  // zeta's event says "allow" for an approve call (src/zeta/core/approval.py), not the method name.
  const wire = { decision: decision === "approve" ? "allow" : decision };
  e("approval_end", { request_id: "approval-1", data: wire });
  if (historyMode === "new") history.push({ id: "approval-end-1", role: "system", event: "approval_end", request_id: "approval-1", tool_call: clean, data: wire });
  if (decision === "approve") {
    e("tool_start", { tool_call: clean, data: {} });
    row("r4", "tool_result", [text("")], result("live-2", "built 9 packages in 2.1s\n"));
    e("tool_end", { tool_call: clean, tool_result: result("live-2", "built 9 packages in 2.1s\n", { structured_content: { exit_code: 0, stdout: "built 9 packages in 2.1s\n", stderr: "" } }), data: {} });
  }
  if (grantProof && decision === "approve") {
    const write = { id: "live-3", name: "write", arguments: { path: "cancel-proof.txt", content: "cancel me" } };
    setPending("approval-2", write);
    const pending = ask();
    e("approval_request", { request_id: "approval-2", tool_call: write, delegated: false });
    const next = await pending;
    if (next === "abort") {
      e("approval_end", { request_id: "approval-2", data: { decision: "abort", reason: "user_stop" } });
      e("turn_aborted", { data: { reason: "abort" } });
      done();
      e("agent_end");
      return;
    }
  }
  const summary = decision === "approve" ? "Fixed: **20 of 20** runs pass, and the new test failed before the change." : "Skipped the rebuild. The fix is in place; run `bun run build` when ready.";
  row("r5", "assistant", [text(summary)]);
  e("assistant_message", { message: { role: "assistant", content: [text(summary)] } });
  e("turn_end", { data: { turn: 2, tool_calls: 2 } });
  done();
  e("agent_end");
};

/**
 * The composer's methods (send, steer, delivery_status, abort) with zeta's delivery_id rules. A send starts a
 * text-only reply that streams for about 2.5 s, long enough to steer and to stop. As in zeta, an accepted message is
 * echoed as `user_message` before the reply, and a steer is persisted only once a turn takes it.
 * Zeta 5feea2fc parity: `test_duplicate_steer_is_queued_once_and_status_becomes_delivered`,
 * `test_session_abort_marks_accepted_steering_dropped`, `test_disconnect_marks_accepted_steering_dropped`, and
 * `test_tool_less_turn_end_marks_late_steering_dropped` in tests/test_server_delivery.py.
 */
function createComposerMethods(wait: (ms: number) => Promise<void>, running: { get(): boolean; set(value: boolean): void }, histories: Record<string, Json[]>) {
  const sent: Json[] = [];
  const deliveries = new Map<string, Json>();
  const statuses = new Map<string, "queued" | "delivered" | "dropped">();
  let aborts = 0;
  let echo = true;
  let holdTurns = false;
  const withheldEchoes: Array<() => void> = [];
  const withheldHistory: Array<() => void> = [];
  let chat: { session: string; sendDelivery: string | null; steers: string[]; aborted: boolean } | null = null;
  const externalSteers: Array<{ id: string; session: string }> = [];
  type Send = (event: Json) => void;
  const chatTurn = async (session: string, send: Send, prompt: string, sendDelivery: string | null) => {
    const turn = { session, sendDelivery, steers: [] as string[], aborted: false }; // steers holds delivery ids
    chat = turn;
    running.set(true);
    const e = (event: string, body: Json = {}) => { if (!turn.aborted) send({ event, session_id: session, ...body }); };
    e("agent_start");
    e("turn_start", { data: { turn: sent.length } });
    const finish = () => { if (turn.sendDelivery) statuses.set(turn.sendDelivery, "delivered"); e("turn_end", { data: { turn: sent.length } }); chat = null; running.set(false); e("agent_end"); };
    // Prompts that steer the scripted turn, for the status line: a provider failure, and a slow tool call.
    if (prompt.includes("fail this turn")) {
      await wait(200);
      e("error", { error: { code: "provider_error", message: "the provider is overloaded (529)" } });
      return finish();
    }
    // With holdTurns, a turn runs until the client stops it, so a check of the running state cannot race the scripted reply.
    if (holdTurns) {
      while (!turn.aborted) await wait(25);
      return;
    }
    if (prompt.includes("use a tool")) {
      const call = { id: `chat-tool-${sent.length}`, name: "bash", arguments: { command: "sleep 2" } };
      e("tool_start", { tool_call: call, data: {} });
      await wait(2000);
      if (turn.aborted) return;
      e("tool_end", { tool_call: call, tool_result: result(call.id, "", { structured_content: { exit_code: 0, stdout: "", stderr: "" } }), data: {} });
    }
    let reply = "";
    for (const word of "Reading the files you named, then running the focused tests before the full suite. ".repeat(3).match(/\S+\s*/g)!) {
      await wait(Number(process.env.FAKE_ZETA_WORD_MS ?? 60));
      if (turn.aborted) return;
      reply += word;
      e("assistant_delta", { delta: word, kind: "assistant" });
    }
    e("assistant_message", { message: { role: "assistant", content: [text(reply)] } });
    histories[session] = [...(histories[session] ?? []), { id: `reply-${sent.length}`, role: "assistant", content: [text(reply)], tool_result: null }];
    // serve-protocol.md:469-475: terminal steer outcomes are durable session_history rows.
    for (const id of turn.steers) {
      statuses.set(id, "dropped");
      histories[session]!.push({ id: `delivery-${id}`, role: "system", event: "delivery_status", delivery_id: id, method: "steer", status: "dropped", content: [text("steer dropped: abort")], reason: "abort" });
    }
    e("turn_end", { data: { turn: sent.length } });
    chat = null;
    running.set(false);
    e("agent_end");
  };
  // In zeta's order (see PARAM_RULES): active session, delivery_id, duplicate (send_images: after its payload checks,
  // delivery.py:150-153), turn state, then the remaining params.
  const deliver = (requested: "send" | "steer" | "send_images", params: Json, active: string | null, send: Send, features: readonly string[]): Json => {
    const method = requested === "steer" ? "steer" : "send";
    const rule = PARAM_RULES[requested]!;
    const delivery = typeof params.delivery_id === "string" ? params.delivery_id : null;
    // Zeta src/zeta/server/delivery.py:48-58 and :383-408, docs/serve-protocol.md:497-520: ids are retained per
    // session (the attached runtime's store), the lookup runs after the no-active-session check and before turn checks.
    const seen = delivery && active ? deliveries.get(`${active}\u0000${delivery}`) : undefined;
    const duplicate = (): Json => ({ result: statuses.get(delivery!) === "dropped" ? { accepted: false, duplicate: true, status: "dropped" } : { ...seen, duplicate: true } });
    const invalid = (checks: ParamChecks | undefined): Json | null => { const message = invalidParams(requested, checks, params, features); return message ? { error: { code: -32602, message } } : null; };
    if (!active) return { error: { code: -32003, message: "no active session" } };
    const late = invalid(rule.afterSession);
    if (late) return late;
    if (seen && requested !== "send_images") return duplicate();
    if (method === "send" && running.get()) return { error: { code: -32004, message: "a turn is already running" } };
    if (method === "steer" && !running.get()) return { error: { code: -32005, message: "no turn is running for steering" } };
    const later = invalid(rule.afterTurn);
    if (later) return later;
    if (seen) return duplicate();
    const images = requested === "send_images" ? (params.images as Json[]) : [];
    const value = typeof params.input_id === "string" ? opaqueInputs.get(params.input_id) ?? "" : String(params.text ?? "");
    sent.push({ method, text: value, delivery_id: delivery });
    const userMessage = { event: "user_message", session_id: active, text: value, mode: method, attachments: images.map((image) => ({ name: image.name, mime_type: image.mime_type, size: Math.floor(String(image.data).length * 3 / 4) })), ...(delivery ? { delivery_id: delivery } : {}) };
    const emitEcho = () => send(userMessage);
    const accepted = method === "send" ? { accepted: true, session_id: active } : { accepted: true };
    if (delivery) { deliveries.set(`${active}\u0000${delivery}`, accepted); statuses.set(delivery, "queued"); }
    const persistHistory = () => { if (delivery && method === "send") statuses.set(delivery, "delivered"); histories[active] = [...(histories[active] ?? []), { id: `sent-${sent.length}`, role: "user", content: [text(value)], ...(delivery ? { delivery_id: delivery } : {}), tool_result: null }]; };
    if (echo) { persistHistory(); emitEcho(); } else { withheldHistory.push(persistHistory); withheldEchoes.push(emitEcho); }
    if (method === "steer") {
      if (delivery) chat ? chat.steers.push(delivery) : externalSteers.push({ id: delivery, session: active });
      return { result: accepted };
    }
    // After the reply, as zeta starts the turn once the send is persisted.
    queueMicrotask(() => void chatTurn(active, send, value, delivery));
    return { result: accepted };
  };
  const abort = (send: Send): Json => {
    if (!chat) return { result: { aborted: false } };
    const turn = chat;
    if (turn.sendDelivery) statuses.set(turn.sendDelivery, "delivered");
    for (const id of turn.steers) {
      statuses.set(id, "dropped");
      histories[turn.session]!.push({ id: `delivery-${id}`, role: "system", event: "delivery_status", delivery_id: id, method: "steer", status: "dropped", content: [text("steer dropped: abort")], reason: "abort" });
    }
    chat = null;
    running.set(false);
    turn.aborted = true;
    aborts++;
    send({ event: "turn_aborted", session_id: turn.session, data: { reason: "abort" } });
    send({ event: "agent_end", session_id: turn.session, data: {} });
    return { result: { aborted: true } };
  };
  return {
    /** Every accepted send and steer, in order. */
    sent,
    clearSent() { sent.splice(0); },
    setEcho(value: boolean) { echo = value; },
    setHoldTurns(value: boolean) { holdTurns = value; },
    persistWithheldHistory() { withheldHistory.splice(0).forEach((persist) => persist()); },
    flushEchoes() { this.persistWithheldHistory(); withheldEchoes.splice(0).forEach((send) => send()); },
    get history() { return histories[ACTIVE] ?? []; },
    get aborts() { return aborts; },
    finishExternalTurn(session: string) {
      for (const steer of externalSteers.splice(0).filter((steer) => steer.session === session)) {
        statuses.set(steer.id, "dropped");
        histories[session]!.push({ id: `delivery-${steer.id}`, role: "system", event: "delivery_status", delivery_id: steer.id, method: "steer", status: "dropped", content: [text("steer dropped: turn_end")], reason: "turn_end" });
      }
    },
    disconnect() {
      for (const steer of externalSteers.splice(0)) {
        statuses.set(steer.id, "dropped");
        histories[steer.session]!.push({ id: `delivery-${steer.id}`, role: "system", event: "delivery_status", delivery_id: steer.id, method: "steer", status: "dropped", content: [text("steer dropped: disconnect")], reason: "disconnect" });
      }
      if (!chat) return;
      for (const id of chat.steers) {
        statuses.set(id, "dropped");
        histories[chat.session]!.push({ id: `delivery-${id}`, role: "system", event: "delivery_status", delivery_id: id, method: "steer", status: "dropped", content: [text("steer dropped: abort")], reason: "abort" });
      }
      chat.aborted = true; chat = null; running.set(false);
    },
    /** The reply body for a composer method, or undefined for any other method. */
    handle(method: string, params: Json, active: string | null, send: Send, features: readonly string[]): Json | undefined {
      if (method === "send" || method === "steer" || method === "send_images") return deliver(method, params, active, send, features);
      if (method === "abort") return abort(send);
      if (method !== "delivery_status") return undefined;
      const status = statuses.get(String(params.delivery_id));
      // zeta 169fb144 src/zeta/server/delivery.py:368 answers an id it never saw with status "unknown".
      return { result: { delivery_id: params.delivery_id, status: status ?? "unknown" } };
    },
  };
}

export function composerMethods(wait: (ms: number) => Promise<void>, running: { get(): boolean; set(value: boolean): void }) {
  return createComposerMethods(wait, running, createHistories());
}

export async function startFakeZeta({ origins, port = 0, live = true, historyMode = process.env.FAKE_ZETA_HISTORY_MODE === "old" ? "old" : "new", approvalHistoryMode = (process.env.FAKE_ZETA_APPROVAL_HISTORY_MODE as ApprovalHistoryMode | undefined) ?? "not-advertised-with-rows", approvalReconnect = true, approvalReconnectGraceMs = 90_000, newSessionSettings = true, sessionGrants = true, grantProof = false, helloDelay = 60_000, serialDelays }: { origins: string[]; port?: number; live?: boolean; historyMode?: HistoryMode; approvalHistoryMode?: ApprovalHistoryMode; approvalReconnect?: boolean; approvalReconnectGraceMs?: number; newSessionSettings?: boolean; sessionGrants?: boolean; grantProof?: boolean; helloDelay?: number; serialDelays?: Readonly<Record<string, number | readonly number[]>> }) {
  const histories = createHistories();
  const home = await mkdtemp(join(tmpdir(), "fulcrum-web-zeta-"));
  await mkdir(join(home, "run"), { recursive: true });
  const discovery = join(home, "run", "serve.ws.json");
  let controllerToken = crypto.randomUUID();
  let observerToken = crypto.randomUUID();
  let mode: Mode = "ok";
  let liveEnabled = live;
  let modelInputIds = true;
  let longStatus = false;
  let currentHistoryMode = historyMode;
  let allowed = origins;
  let active: string | null = ACTIVE;
  const manyPages = Number(process.env.FAKE_ZETA_MANY_PAGES ?? 0);
  const largePages = Number(process.env.FAKE_ZETA_LARGE_PAGES ?? 0);
  if (manyPages > 0) histories[MANY] = Array.from({ length: manyPages * 8 }, (_, index) => ({ id: `many-${index}`, role: index % 2 ? "assistant" : "user", content: [text(`many-page row ${index}`)], tool_result: null }));
  if (largePages > 0) histories[LARGE] = Array.from({ length: largePages * 128 }, (_, index) => ({ id: `large-${index}`, role: index % 2 ? "assistant" : "user", content: [text(`large-page row ${index}`)], tool_result: null }));
  let sessions = [
    ...seeded,
    ...(manyPages > 0 ? [meta(MANY, 1, { name: `${manyPages.toLocaleString("en")} small pages of history` })] : []),
    ...(largePages > 0 ? [meta(LARGE, 1, { name: `${largePages.toLocaleString("en")} large pages of history` })] : []),
  ];
  let decide: ((decision: "approve" | "deny" | "abort") => void) | null = null;
  let turnStarted = false;
  let approvalAborted = false;
  let running = false;
  let rejectCreate = false;
  let delayedOpen = false;
  let catalogBusy = false;
  // Old or future servers for the compatibility gate. Zeta 8389c6e docs/serve-protocol.md:127-133: a 1.0 hello
  // returns only the legacy requests and no features key; docs/serve-protocol.md:1501-1504: a missing request is -32601.
  let protocolVersion: "1.0" | "1.2" = "1.2";
  let omittedRequests = new Set<string>();
  let extraRequests: string[] = [];
  let extraHelloFields: Json = {};
  const resultOverrides = new Map<string, (params: Json) => unknown>();
  let settingsEnabled = true;
  let advertiseNewSessionSettings = newSessionSettings;
  type Settings = { model: string; approval_mode: "ask" | "allow" | "deny"; plan_mode: boolean };
  const defaultSettings = { model: "gpt-5.1-codex", approval_mode: "ask" as const, plan_mode: false };
  const settingsBySession = new Map<string, Settings>(sessions.map((session) => [String(session.session_id), { model: String(session.model), approval_mode: session.approval_mode as Settings["approval_mode"], plan_mode: false }]));
  let vimMode = false;
  const activeSettings = () => settingsBySession.get(active ?? "") ?? defaultSettings;
  const failures = new Map<string, string[]>();
  const transientBusy = new Map<string, number>();
  const imageSends: Json[] = [];
  const decisions: Json[] = [];
  const grantsBySession = new Map<string, string[]>();
  const grantChanges: Json[] = [];
  const requests: Array<{ method: string; params: Json; running: boolean; received: number; started: number; replied?: number }> = [];
  type SocketData = { role: "controller" | "observer"; features?: string[] };
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const grantSnapshot = (sessionId: string) => {
    const session = [...(grantsBySession.get(sessionId) ?? [])];
    return { session_id: sessionId, default: "ask", precedence: ["deny", "ask", "allow"], rules: { deny: ["dangerous"], ask: ["write"], allow: ["read", ...session] }, session_grants: session };
  };
  // Zeta 473784f docs/serve-protocol.md:606-660,1123 queues this event before the matching revoke response.
  const notifyGrantChange = (change: "grant" | "revoke" | "clear" | "reset", changed: string[], sessionId: string) => {
    const data = { change, changed, grants: grantSnapshot(sessionId) };
    grantChanges.push(data);
    for (const socket of sockets) if (socket.data.features?.includes("session_grants")) socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "session_grants_changed", data } }));
  };
  const handleGrantRequest = (socket: ServerWebSocket<SocketData>, method: string, params: Json, reply: (body: Json) => void) => {
    if (method !== "session_grants" && method !== "revoke_session_grants") return false;
    if (!socket.data.features?.includes("session_grants")) { reply({ error: { code: -32601, message: "method not found" } }); return true; }
    if (!active) { reply({ error: { code: -32003, message: "no active session" } }); return true; }
    if (method === "session_grants") {
      reply(Object.keys(params).length ? { error: { code: -32602, message: "session_grants accepts no parameters", data: { code: "invalid_session_grants_params" } } } : { result: grantSnapshot(active) });
      return true;
    }
    if (socket.data.role === "observer") { reply({ error: { code: -32008, message: "observer is read-only" } }); return true; }
    const keys = Object.keys(params);
    const validGrant = keys.length === 1 && keys[0] === "grant" && typeof params.grant === "string";
    const validClear = keys.length === 1 && keys[0] === "clear" && params.clear === true;
    if (!validGrant && !validClear) { reply({ error: { code: -32602, message: "use exactly grant or clear", data: { code: "invalid_session_grants_revoke" } } }); return true; }
    const grants = grantsBySession.get(active) ?? [];
    const removed = validClear ? [...grants] : grants.filter((grant) => grant === params.grant);
    if (validGrant && !removed.length) { reply({ error: { code: -32602, message: "session grant not found", data: { code: "session_grant_not_found" } } }); return true; }
    grantsBySession.set(active, grants.filter((grant) => !removed.includes(grant)));
    notifyGrantChange(validClear ? "clear" : "revoke", removed, active);
    reply({ result: { removed, grants: grantSnapshot(active) } });
    return true;
  };
  let controller: ServerWebSocket<SocketData> | null = null;
  const reconnectControllers = new WeakSet<object>();
  let approvalExpiry: ReturnType<typeof setTimeout> | null = null;
  let approvalRequestId = "approval-1";
  let approvalCall: { id: string; name: string; arguments: Json } = { id: "live-2", name: "bash", arguments: { command: "rm -rf packages/zeta/dist && bun run build" } };
  const expireApproval = () => {
    if (!decide || approvalAborted) return;
    approvalAborted = true;
    const resolve = decide;
    decide = null;
    running = false;
    histories[ACTIVE]!.push({ id: `approval-end-expire-${Date.now()}`, role: "system", event: "approval_end", request_id: "approval-1", tool_call: approvalCall, data: { decision: "abort", reason: "grace_expired" } });
    resolve("abort");
  };
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  let openDelay = Number(process.env.FAKE_ZETA_OPEN_DELAY_MS ?? 0);
  const composer = createComposerMethods(wait, { get: () => running, set: (value) => { running = value; } }, histories);
  let serialTail = Promise.resolve<unknown>(undefined);
  const delayCalls = new Map<string, number>();
  const nextDelays = new Map<string, number[]>();
  const requestDelay = (method: string) => {
    const queued = nextDelays.get(method)?.shift();
    if (queued !== undefined) return queued;
    const configured = serialDelays?.[method] ?? 0;
    if (typeof configured === "number") return configured;
    const call = delayCalls.get(method) ?? 0;
    delayCalls.set(method, call + 1);
    return configured[Math.min(call, configured.length - 1)] ?? 0;
  };
  const schedule = <T,>(task: () => Promise<T>) => {
    if (!serialDelays) return task();
    const next = serialTail.then(task, task);
    serialTail = next.catch(() => undefined);
    return next;
  };
  const releaseController = (socket: ServerWebSocket<SocketData>) => {
    if (controller !== socket) return;
    controller = null;
    composer.disconnect();
    if (!decide || approvalAborted) return;
    if (approvalReconnect && reconnectControllers.has(socket as object)) {
      if (approvalExpiry) clearTimeout(approvalExpiry);
      approvalExpiry = setTimeout(expireApproval, approvalReconnectGraceMs);
      return;
    }
    approvalAborted = true;
    const resolve = decide;
    decide = null;
    running = false;
    histories[ACTIVE]!.push({ id: `drop-${Date.now()}`, role: "tool_result", content: [text("")], tool_result: result("live-2", "connection lost", { is_canceled: true }) });
    if (currentHistoryMode === "new") histories[ACTIVE]!.push({ id: `approval-end-drop-${Date.now()}`, role: "system", event: "approval_end", request_id: "approval-1", tool_call: approvalCall, data: { decision: "abort", reason: "controller_disconnected" } });
    resolve("abort");
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request, bun) {
      const origin = request.headers.get("origin");
      const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map((value) => value.trim()) ?? [];
      const bearer = protocols.find((value) => value.startsWith("zeta.bearer."))?.slice("zeta.bearer.".length);
      const role = bearer === controllerToken ? "controller" : bearer === observerToken ? "observer" : null;
      if (!protocols.includes("zeta.v1") || !role || (origin && !allowed.includes(origin))) return new Response("forbidden", { status: 403 });
      return bun.upgrade(request, { data: { role }, headers: { "Sec-WebSocket-Protocol": "zeta.v1" } }) ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) { sockets.add(socket); },
      close(socket) {
        sockets.delete(socket);
        releaseController(socket);
      },
      message(socket, raw) {
        const received = performance.now();
        const request = JSON.parse(String(raw)) as { id: number; method: string; params?: Json };
        return schedule(async () => {
        const { id, method, params = {} } = request;
        const timing: { method: string; params: Json; running: boolean; received: number; started: number; replied?: number } = { method, params, running, received, started: performance.now() };
        requests.push(timing);
        await wait(requestDelay(method));
        const reply = (body: Json) => {
          timing.replied = performance.now();
          socket.send(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
        };
        const send = (event: Json) => { for (const each of sockets) each.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: event })); };
        if (method === "hello") {
          if (params.role !== socket.data.role) { reply({ error: { code: -32602, message: `credential permits ${socket.data.role} role only` } }); socket.close(); return; }
          if (mode === "busy" || (socket.data.role === "controller" && controller !== null)) { socket.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "server busy" } })); socket.close(); return; }
          if (mode === "incompatible") { reply({ error: { code: -32002, message: "version mismatch", data: { requested: "1.2", supported: ["1.0"] } } }); socket.close(); return; }
          if (mode === "slow") await wait(helloDelay);
          if (!sockets.has(socket)) return;
          if (socket.data.role === "controller") controller = socket;
          const features = protocolVersion === "1.0" ? [] : (params.features as string[] | undefined)?.filter((name) => name === "list_sessions_paging" || name === "delivery_id" || name === "send_images_delivery_id" || name === "user_message_event" || name === "user_message_delivery_id" || (name === "model_input_ids" && modelInputIds) || (name === "approval_history" && approvalHistoryMode === "advertised-with-rows") || (name === "approval_reconnect" && approvalReconnect) || (name === "new_session_settings" && advertiseNewSessionSettings) || (name === "session_grants" && sessionGrants)) ?? [];
          socket.data.features = features;
          const reconnect = features.includes("approval_reconnect");
          if (reconnect) reconnectControllers.add(socket as object);
          const advertised = protocolVersion === "1.0" ? ["list_sessions", "new_session", "resume", "send", "steer", "approve", "deny", "abort", "status"] : ["status", "approve", "deny", "rename_session", "session_tree", "switch_branch", "slash_list", "slash_run", ...(sessionGrants ? ["session_grants", "revoke_session_grants"] : []), ...(settingsEnabled ? ["model_catalog", "session_settings", "set_settings", "send_images", ...(advertiseNewSessionSettings ? ["new_session_settings"] : [])] : []), ...extraRequests];
          const offered = advertised.filter((name) => !omittedRequests.has(name));
          reply({ result: { ...extraHelloFields, protocol_version: protocolVersion, server: "fake-zeta", capabilities: protocolVersion === "1.0" ? { requests: offered, notifications: ["event"] } : { features, requests: offered } } });
          if (decide && !approvalAborted) {
            if (!reconnect) expireApproval();
            else {
              if (approvalExpiry) clearTimeout(approvalExpiry);
              approvalExpiry = null;
              queueMicrotask(() => socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "approval_request", session_id: ACTIVE, request_id: "approval-1", tool_call: approvalCall, delegated: false } })));
            }
          }
          return;
        }
        // zeta lists the settings requests under hello's `requests`; an older zeta does not know them.
        // delivery_status needs the delivery_id feature itself (zeta 169fb144 src/zeta/server/protocol.py:301, :553-554).
        if (omittedRequests.has(method) || (!settingsEnabled && SETTINGS_REQUESTS.includes(method)) || (method === "delivery_status" && !socket.data.features?.includes("delivery_id"))) return reply({ error: { code: -32601, message: `method not found: ${method}` } });
        const invalid = invalidParams(method, PARAM_RULES[method], params, socket.data.features ?? []);
        if (invalid) return reply({ error: { code: -32602, message: invalid } });
        const override = resultOverrides.get(method);
        if (override) return reply({ result: override(params) });
        if (method === "new_session") {
          // Zeta 5feea2fc src/zeta/server/server.py:561-593 creates and activates this metadata;
          // src/zeta/server/control.py:160-180 makes a reserved or running turn return -32004 first.
          // Zeta 169fb144 server.py:623-629: a non-null approval_mode needs new_session_settings and a concrete model,
          // and both are validated, before the busy check; a null approval_mode is no approval_mode.
          const approvalMode = params.approval_mode ?? undefined;
          const validModels = ["claude-sonnet-5", "claude-opus-4-6", "gpt-5.1-codex"];
          const invalidModel = typeof params.model !== "undefined" && !validModels.includes(String(params.model));
          if (approvalMode !== undefined) {
            if (!socket.data.features?.includes("new_session_settings")) return reply({ error: { code: -32602, message: "approval_mode requires the negotiated new_session_settings feature" } });
            if (typeof params.model !== "string") return reply({ error: { code: -32602, message: "model is required with approval_mode" } });
            if (invalidModel || !["ask", "allow", "deny"].includes(String(approvalMode))) return reply({ error: { code: -32602, message: "invalid model or approval_mode" } });
          }
          const busy = transientBusy.get(method) ?? 0;
          if (busy > 0) { transientBusy.set(method, busy - 1); return reply({ error: { code: -32004, message: "a turn is already running" } }); }
          if (running || rejectCreate) return reply({ error: { code: -32004, message: "a turn is already running" } });
          const lateInvalid = invalidParams(method, PARAM_RULES.new_session!.afterTurn, params, socket.data.features ?? []);
          if (lateInvalid) return reply({ error: { code: -32602, message: lateInvalid } });
          if (invalidModel) return reply({ error: { code: -32602, message: "invalid model or approval_mode" } });
          const createdSettings: Settings = { model: typeof params.model === "string" ? params.model : defaultSettings.model, approval_mode: typeof params.approval_mode === "string" ? params.approval_mode as Settings["approval_mode"] : defaultSettings.approval_mode, plan_mode: false };
          const created = meta(`s-new-${sessions.length}`, 0, { created_at: at(0), model: createdSettings.model, approval_mode: createdSettings.approval_mode, cwd: "/Users/dev/me/fun/fulcrum", retained_tail: 8, compaction_budget: 262144, override_audit: [], context_files: [], skill_catalog: [], agent_catalog: [], plan_mode: false, project_id: null, tool_allow: null, tool_deny: [] });
          sessions.unshift(created);
          histories[created.session_id] = [];
          settingsBySession.set(String(created.session_id), createdSettings);
          active = created.session_id;
          return reply({ result: { session: created } });
        }
        if (method === "list_sessions") {
          catalogBusy = true;
          try {
            if (mode === "slow-catalog") await wait(30_000);
            const offset = Number(params.offset ?? 0);
            const limit = Number(params.limit ?? sessions.length);
            const page = sessions.slice(offset, offset + limit);
            return reply({ result: { sessions: page, next_offset: offset + limit < sessions.length ? offset + limit : null } });
          } finally { catalogBusy = false; }
        }
        if (method === "status") {
          const pending = decide && !approvalAborted ? [{ request_id: approvalRequestId, tool_call: approvalCall, delegated: false }] : [];
          return reply({ result: { session: active ? { ...(sessions.find((session) => session.session_id === active) ?? {}), vim_mode: vimMode, plan_mode: activeSettings().plan_mode } : null, state: running ? (decide ? "tool" : "running") : "idle", explicit_finish: false, pending_approvals: pending, usage: {}, compaction_markers: 0 } });
        }
        if (handleGrantRequest(socket, method, params, reply)) return;
        if (method === "resume") {
          // Zeta 5feea2fc src/zeta/server/server.py:601-626 and src/zeta/server/control.py:160-180 keep the
          // current session while busy and return -32004 before a session swap.
          if (mode === "broken-session") return reply({ error: { code: -32602, message: "session log is invalid at line 12" } });
          const busy = transientBusy.get(method) ?? 0;
          if (busy > 0) { transientBusy.set(method, busy - 1); return reply({ error: { code: -32004, message: "a turn is already running" } }); }
          if (running && params.session_id !== active) return reply({ error: { code: -32004, message: "a turn is already running" } });
          active = String(params.session_id);
          delayedOpen = false;
          return reply({ result: { session: sessions.find((session) => session.session_id === active) } });
        }
        if (method === "rename_session") {
          const session = sessions.find((candidate) => candidate.session_id === params.session_id);
          // ergonomics.py:79-80: name must be a string; core/session.py:788-794: a blank name clears it.
          if (!session || typeof params.name !== "string") return reply({ error: { code: -32602, message: "name must be a string" } });
          session.name = params.name.trim() ? params.name : "";
          return reply({ result: { session } });
        }
        if (method === "session_tree") return reply({ result: { session_id: params.session_id, branches: [{ id: "head-main", label: "main", seq: 1, current: true }, { id: "head-experiment", label: "experiment", seq: 7, current: false }] } });
        if (method === "switch_branch") return reply({ result: { session_id: params.session_id, head_id: params.head_id } });
        if (method === "session_history") {
          if (params.session_id !== active) return reply({ error: { code: -32003, message: "no active session" } });
          if (openDelay > 0 && !delayedOpen) {
            delayedOpen = true;
            await wait(openDelay);
          }
          const rows = (histories[active!] ?? []).filter((row) => approvalHistoryMode !== "not-advertised-without-rows" || (row.event !== "approval_request" && row.event !== "approval_end"));
          const offset = Number(params.offset ?? 0);
          const pageSize = active === LARGE ? 128 : 8;
          reply({ result: { messages: rows.slice(offset, offset + pageSize), next_offset: offset + pageSize < rows.length ? offset + pageSize : null } });
          // Zeta 5feea2fc tests/test_server.py::test_approval_and_steer_continue_the_same_turn and
          // ::test_resumed_approval_finishes_idle_after_terminal_event define this approval-turn lifecycle.
          if (liveEnabled && active === ACTIVE && offset + pageSize >= rows.length && !turnStarted) {
            turnStarted = true;
            running = true;
            const ask = () => new Promise<"approve" | "deny" | "abort">((resolve) => {
              approvalAborted = false;
              decide = (decision) => { decide = null; resolve(decision); };
            });
            setTimeout(() => void liveTurn(send, ask, wait, () => { composer.finishExternalTurn(ACTIVE); running = false; }, histories, currentHistoryMode, grantProof, (requestId, call) => { approvalRequestId = requestId; approvalCall = call as typeof approvalCall; })(), 300);
          }
          return;
        }
        // As in zeta (server/ergonomics.py `active`): these name the active session or fail.
        if (SETTINGS_REQUESTS.includes(method) && method !== "model_catalog" && params.session_id !== active) return reply({ error: { code: -32003, message: "session is not active" } });
        if (method === "slash_list") return reply({ result: { commands: params.include_unavailable === true ? completeSlashCatalog : defaultSlashCatalog, notices: [] } });
        const failure = failures.get(method)?.shift();
        if (failure) return reply({ error: { code: -32000, message: failure } });
        if (method === "slash_run") {
          // Zeta 3e1f48a39cc5a08e4814b91d0ecaa44dba17e489: server/slash_commands.py:487-555 and core/commands/plan_commands.py:16-146.
          const command = String(params.text ?? "").trim();
          if (command === "/status") return reply({ result: { kind: "output", text: longStatus ? `fake status\nready\n${Array.from({ length: 80 }, (_, index) => `status detail ${index + 1}`).join("\n")}` : "fake status\nready" } });
          // The same merge's server/slash_commands.py:535-555 returns display-safe output for these serve commands.
          if (command === "/accounts") return reply({ result: { kind: "output", text: "no accounts" } });
          if (command === "/model" || command.startsWith("/model ")) {
            if (command.startsWith("/model ")) activeSettings().model = command.slice("/model ".length).trim();
            return reply({ result: { kind: "output", text: command === "/model" ? `model: ${activeSettings().model} (open Settings to switch)` : `model: ${activeSettings().model}` } });
          }
          if (command === "/vim" || command.startsWith("/vim ")) {
            if (command.endsWith("off")) vimMode = false;
            else if (command.endsWith("on")) vimMode = true;
            return reply({ result: { kind: "output", text: `vim mode: ${vimMode ? "on" : "off"}` } });
          }
          if (command === "/plan" || command.startsWith("/plan ")) {
            if (running) return reply({ error: { code: -32004, message: "a turn is already running" } });
            const argument = command.slice("/plan".length).trim();
            if (!argument || argument === "toggle" || argument === "on" || argument === "off") {
              activeSettings().plan_mode = argument === "on" ? true : argument === "off" ? false : !activeSettings().plan_mode;
              return reply({ result: { kind: "output", text: `plan mode: ${activeSettings().plan_mode ? "on" : "off"}` } });
            }
            activeSettings().plan_mode = true;
            opaqueInputs.set("opaque-plan-input", command);
            return reply({ result: { kind: "model_input", input_id: "opaque-plan-input", display_text: command } });
          }
          if (command === "/implement") {
            if (running) return reply({ error: { code: -32004, message: "a turn is already running" } });
            activeSettings().plan_mode = false;
            opaqueInputs.set("opaque-implement-input", command);
            return reply({ result: { kind: "model_input", input_id: "opaque-implement-input", display_text: command } });
          }
          if (command === "/review" || command.startsWith("/review ")) { opaqueInputs.set("opaque-review-input", command); return reply({ result: { kind: "model_input", input_id: "opaque-review-input", display_text: command } }); }
          if (command === "/malformed") return reply({ result: { unexpected: true } });
          if (command === "/mcp" || command === "/mcp status") return reply({ result: { kind: "output", text: "mcp: 0 mounted, 0 failed\nmcp limits: deadline 300s | wire 67108864 bytes | spill 262144 bytes" } });
          if (command === "/help") return reply({ result: { kind: "output", text: `built-in commands:\n${defaultSlashCatalog.filter((entry) => entry.kind === "builtin").map((entry) => `  /${entry.name} — ${entry.description}`).join("\n")}\ncustom commands:\n  none\nskills (use /name or $name; $name also works inline):\n  none` } });
          const name = command.slice(1).split(/\s/, 1)[0] ?? "";
          if (completeSlashCatalog.some((entry) => entry.name === name && entry.unavailable === "requires_tui")) return reply({ result: { kind: "client_only", name } });
          return reply({ result: { kind: "unknown", name } });
        }
        if (method === "model_catalog") return reply({ result: { models: ["claude-sonnet-5", "claude-opus-4-6", "gpt-5.1-codex"], providers: { "claude-sonnet-5": "claude", "claude-opus-4-6": "claude", "gpt-5.1-codex": "codex" } } });
        if (method === "session_settings") return reply({ result: activeSettings() });
        if (method === "set_settings") {
          if (running) return reply({ error: { code: -32004, message: "a turn is already running" } });
          const lateInvalid = invalidParams(method, PARAM_RULES.set_settings!.afterTurn, params, socket.data.features ?? []);
          if (lateInvalid) return reply({ error: { code: -32602, message: lateInvalid } });
          const current = activeSettings();
          const settings: Settings = { model: String(params.model), approval_mode: params.approval_mode as Settings["approval_mode"], plan_mode: current.plan_mode };
          settingsBySession.set(String(active), settings);
          return reply({ result: settings });
        }
        if (method === "send_images") {
          imageSends.push(params);
          const handled = composer.handle("send_images", params, active, send, socket.data.features ?? []);
          return reply(handled!);
        }
        if (method === "approve" || method === "deny") {
          decisions.push({ method, ...params });
          if (!decide || params.request_id !== approvalRequestId) return reply({ error: { code: -32006, message: "approval request is missing or already resolved" } });
          if (method === "approve" && params.scope === "always_tool" && active) {
            const grants = grantsBySession.get(active) ?? [];
            if (!grants.includes(approvalCall.name)) {
              grantsBySession.set(active, [...grants, approvalCall.name]);
              notifyGrantChange("grant", [approvalCall.name], active);
            }
          }
          reply({ result: { accepted: true, request_id: params.request_id, decision: method, ...(params.scope === "always_tool" ? { grant: approvalCall.name } : {}) } });
          if (approvalExpiry) clearTimeout(approvalExpiry);
          approvalExpiry = null;
          return decide(method);
        }
        if (method === "abort" && decide && !approvalAborted) {
          approvalAborted = true;
          const resolve = decide;
          decide = null;
          running = false;
          resolve("abort");
          return reply({ result: { aborted: true } });
        }
        const handled = composer.handle(method, params, active, send, socket.data.features ?? []);
        if (handled) return reply(handled);
        reply({ error: { code: -32601, message: `method not found: ${method}` } });
        });
      },
    },
  });

  const write = (value: Json) => writeFile(discovery, JSON.stringify(value), { mode: 0o600 });
  await write({ port: server.port, controller_token: controllerToken, observer_token: observerToken, pid: process.pid, origins: allowed });
  return {
    home,
    port: server.port,
    decisions,
    grantChanges,
    requests,
    imageSends,
    get settings() { return activeSettings(); },
    settingsFor(sessionId: string) { return settingsBySession.get(sessionId); },
    setSettings(sessionId: string, settings: Omit<Settings, "plan_mode"> & { plan_mode?: boolean }) { settingsBySession.set(sessionId, { ...settings, plan_mode: settings.plan_mode ?? false }); },
    setSessionGrantsEnabled(enabled: boolean) { sessionGrants = enabled; },
    sessionGrants(sessionId = active ?? "") { return [...(grantsBySession.get(sessionId) ?? [])]; },
    changeSessionGrants(sessionId: string, grants: string[], change: "grant" | "revoke" | "clear" | "reset" = "reset") {
      const before = grantsBySession.get(sessionId) ?? [];
      grantsBySession.set(sessionId, [...grants]);
      notifyGrantChange(change, change === "grant" ? grants.filter((grant) => !before.includes(grant)) : before.filter((grant) => !grants.includes(grant)), sessionId);
    },
    failNext(method: string, message: string) { failures.set(method, [...(failures.get(method) ?? []), message]); },
    busyNext(method: "resume" | "new_session", count = 1) { transientBusy.set(method, count); },
    get running() { return running; },
    /** Every accepted send and steer, in order. */
    sent: composer.sent,
    clearSent() { composer.clearSent(); },
    setEcho(value: boolean) { composer.setEcho(value); },
    /** `true`: every turn except a "fail this turn" prompt runs until it is stopped. */
    setHoldTurns(value: boolean) { composer.setHoldTurns(value); },
    flushEchoes() { composer.flushEchoes(); },
    get aborts() { return composer.aborts; },
    /** Closes every socket, like a network blip; the server keeps running. */
    drop() { composer.persistWithheldHistory(); for (const socket of sockets) socket.close(1012, "restart"); },
    /** Removes the discovery file and refuses upgrades, like a stopped server. */
    async stop() {
      allowed = [];
      await rm(discovery, { force: true });
      if (controller) releaseController(controller);
      this.drop();
      for (let attempt = 0; decide && attempt < 100; attempt++) await Bun.sleep(1);
    },
    async start() {
      allowed = origins;
      controllerToken = crypto.randomUUID();
      observerToken = crypto.randomUUID();
      if (!decide) { approvalAborted = false; running = false; }
      await write({ port: server.port, controller_token: controllerToken, observer_token: observerToken, pid: process.pid, origins: allowed });
    },
    /** Lists other origins in the allowlist, so this page's origin is missing. */
    async foreignOrigin() { allowed = ["http://localhost:5173"]; await write({ port: server.port, controller_token: controllerToken, observer_token: observerToken, pid: process.pid, origins: allowed }); },
    /** Hands out a credential the server will refuse. */
    async wrongToken() { await write({ port: server.port, controller_token: "stale-token", observer_token: observerToken, pid: process.pid, origins: allowed }); },
    setMode(next: Mode) { mode = next; },
    setSettingsEnabled(value: boolean) { settingsEnabled = value; },
    setModelInputIds(value: boolean) { modelInputIds = value; },
    /** The server generation the next hello describes: protocol version, missing requests, and additive extras. */
    setServerShape({ protocol = "1.2", omitRequests = [], addRequests = [], helloFields = {} }: { protocol?: "1.0" | "1.2"; omitRequests?: string[]; addRequests?: string[]; helloFields?: Json } = {}) {
      protocolVersion = protocol; omittedRequests = new Set(omitRequests); extraRequests = addRequests; extraHelloFields = helloFields;
    },
    /** Replaces one method's result, for legacy or additive shapes; `null` restores the scripted reply. */
    overrideResult(method: string, result: ((params: Json) => unknown) | null) { if (result) resultOverrides.set(method, result); else resultOverrides.delete(method); },
    setLongStatus(value: boolean) { longStatus = value; },
    setNewSessionSettings(value: boolean) { advertiseNewSessionSettings = value; },
    setOpenDelay(ms: number) { openDelay = ms; },
    delayNext(method: string, ms: number) { nextDelays.set(method, [...(nextDelays.get(method) ?? []), ms]); },
    /** `true`: new_session fails the way real zeta does while a turn runs (`require_idle`). */
    setRejectCreate(next: boolean) { rejectCreate = next; },
    activeId() { return active; },
    setHistoryMode(next: HistoryMode) { currentHistoryMode = next; },
    setLive(next: boolean) {
      if (next && !liveEnabled) {
        active = ACTIVE;
        turnStarted = false;
        histories[ACTIVE] = histories[ACTIVE]!.filter((row) => row.event !== "approval_request" && row.event !== "approval_end");
      }
      liveEnabled = next;
    },
    /** `true`: a fresh zeta home, with no sessions and no server session. `false`: the seeded sessions again. */
    setEmpty(empty: boolean) { sessions = empty ? [] : [...seeded]; active = empty ? null : ACTIVE; },
    async close() { this.drop(); server.stop(true); await rm(home, { recursive: true, force: true }); },
  };
}

if (import.meta.main) {
  const origin = process.env.WEB_ORIGIN ?? "http://localhost:5180";
  const fake = await startFakeZeta({ origins: [origin, origin.replace("localhost", "127.0.0.1")], port: Number(process.env.FAKE_ZETA_PORT ?? 0) });
  console.log(`fake zeta serve on 127.0.0.1:${fake.port} for ${origin}\nstart the app with:\n  ZETA_HOME=${fake.home} bun run dev\nctrl-c stops it and deletes ${fake.home}`);
  process.once("SIGINT", () => void fake.close().then(() => process.exit(0)));
}
