// A scripted `zeta serve --ws` for the browser gate and for trying the app without a real zeta. It speaks the subset
// of protocol 1.2 the app uses (hello, list_sessions, new_session, status, resume, session_history, approve, deny,
// send, steer, abort, with the delivery_id and user_message_event features), checks the
// token and Origin like the real upgrade, and writes the discovery file under its own ZETA_HOME, never ~/.zeta.
//
// Manual use: `bun scripts/fake-zeta.ts`, then start vite with the printed ZETA_HOME.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";

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

const text = (value: string) => ({ type: "text", text: value });
const toolUse = (id: string, name: string, args: Json = {}) => ({ type: "tool_use", tool_call: { id, name, arguments: args } });
// History keeps a result's text only; bash's is "stdout:\n" + stdout + "\nstderr:\n" + stderr (zeta src/zeta/tools/bash).
const result = (id: string, content: string, extra: Json = {}) => ({ tool_call_id: id, content, is_error: false, content_blocks: [], structured_content: null, ...extra });
const histories: Record<string, Json[]> = {
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
    { id: "t1d", role: "tool_result", content: [text("stdout:\nthemes.css\nthemes.ts\n\nstderr:\n")], tool_result: result("t-ls", "stdout:\nthemes.css\nthemes.ts\n\nstderr:\n") },
    { id: "t2", role: "assistant", content: [text("All 12 themes pass on `bg`. On `surface`, **solarized-light** is closest at 4.61:1.\n\n| theme | bg | surface |\n| --- | --- | --- |\n| gruvbox-dark | 5.9 | 5.4 |\n| solarized-light | 4.9 | 4.61 |")], tool_result: null },
  ],
  [LONG]: Array.from({ length: 400 }, (_, index) => index % 2 === 0
    ? { id: `l${index}`, role: "user", content: [text(`step ${index / 2 + 1}: measure frame ${index}`)], tool_result: null }
    : { id: `l${index}`, role: "assistant", content: [text(`frame ${index} took **${(index % 7) + 3} ms**; \`content-visibility\` skipped ${index * 3} rows.`)], tool_result: null }),
};

/** The live turn that runs when the active session opens: prose, code, a shell call, an approval, then a summary. */
const liveTurn = (send: (event: Json) => void, ask: () => Promise<"approve" | "deny" | "abort">, wait: (ms: number) => Promise<void>, done: () => void, historyMode: HistoryMode) => async () => {
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
 */
export function composerMethods(wait: (ms: number) => Promise<void>, running: { get(): boolean; set(value: boolean): void }) {
  const sent: Json[] = [];
  const deliveries = new Map<string, Json>();
  const statuses = new Map<string, "queued" | "delivered" | "dropped">();
  let aborts = 0;
  let chat: { session: string; steers: string[]; aborted: boolean } | null = null;
  type Send = (event: Json) => void;
  const chatTurn = async (session: string, send: Send) => {
    const turn = { session, steers: [] as string[], aborted: false }; // steers holds delivery ids
    chat = turn;
    running.set(true);
    const e = (event: string, body: Json = {}) => { if (!turn.aborted) send({ event, session_id: session, ...body }); };
    e("agent_start");
    e("turn_start", { data: { turn: sent.length } });
    let reply = "";
    for (const word of "Reading the files you named, then running the focused tests before the full suite. ".repeat(3).match(/\S+\s*/g)!) {
      await wait(Number(process.env.FAKE_ZETA_WORD_MS ?? 60));
      if (turn.aborted) return;
      reply += word;
      e("assistant_delta", { delta: word, kind: "assistant" });
    }
    e("assistant_message", { message: { role: "assistant", content: [text(reply)] } });
    histories[session] = [...(histories[session] ?? []), { id: `reply-${sent.length}`, role: "assistant", content: [text(reply)], tool_result: null }];
    // As in zeta: a turn with no tool call reaches no provider boundary, so steering still queued at its end is dropped.
    for (const id of turn.steers) statuses.set(id, "dropped");
    e("turn_end", { data: { turn: sent.length } });
    chat = null;
    running.set(false);
    e("agent_end");
  };
  const deliver = (method: "send" | "steer", params: Json, active: string | null, send: Send): Json => {
    const delivery = typeof params.delivery_id === "string" ? params.delivery_id : null;
    const seen = delivery ? deliveries.get(delivery) : undefined;
    if (seen) return { result: statuses.get(delivery!) === "dropped" ? { accepted: false, duplicate: true, status: "dropped" } : { ...seen, duplicate: true } };
    if (!active) return { error: { code: -32003, message: "no active session" } };
    if (method === "send" && running.get()) return { error: { code: -32004, message: "a turn is already running" } };
    if (method === "steer" && !running.get()) return { error: { code: -32005, message: "no turn is running for steering" } };
    const value = String(params.text ?? "");
    sent.push({ method, text: value, delivery_id: delivery });
    send({ event: "user_message", session_id: active, text: value, mode: method, attachments: [], ...(delivery ? { delivery_id: delivery } : {}) });
    const accepted = method === "send" ? { accepted: true, session_id: active } : { accepted: true };
    if (delivery) { deliveries.set(delivery, accepted); statuses.set(delivery, method === "steer" ? "queued" : "delivered"); }
    if (method === "steer") { if (delivery) chat?.steers.push(delivery); return { result: accepted }; }
    histories[active] = [...(histories[active] ?? []), { id: `sent-${sent.length}`, role: "user", content: [text(value)], ...(delivery ? { delivery_id: delivery } : {}), tool_result: null }];
    // After the reply, as zeta starts the turn once the send is persisted.
    queueMicrotask(() => void chatTurn(active, send));
    return { result: accepted };
  };
  const abort = (send: Send): Json => {
    if (!chat) return { result: { aborted: false } };
    const turn = chat;
    for (const id of turn.steers) statuses.set(id, "dropped");
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
    get history() { return histories[ACTIVE] ?? []; },
    get aborts() { return aborts; },
    /** The reply body for a composer method, or undefined for any other method. */
    handle(method: string, params: Json, active: string | null, send: Send): Json | undefined {
      if (method === "send" || method === "steer") return deliver(method, params, active, send);
      if (method === "abort") return abort(send);
      if (method !== "delivery_status") return undefined;
      const status = statuses.get(String(params.delivery_id));
      return status ? { result: { delivery_id: params.delivery_id, status } } : { error: { code: -32602, message: "unknown delivery_id" } };
    },
  };
}

export async function startFakeZeta({ origins, port = 0, live = true, historyMode = process.env.FAKE_ZETA_HISTORY_MODE === "old" ? "old" : "new", approvalHistoryMode = (process.env.FAKE_ZETA_APPROVAL_HISTORY_MODE as ApprovalHistoryMode | undefined) ?? "not-advertised-with-rows", approvalReconnect = true, approvalReconnectGraceMs = 90_000, serialDelays }: { origins: string[]; port?: number; live?: boolean; historyMode?: HistoryMode; approvalHistoryMode?: ApprovalHistoryMode; approvalReconnect?: boolean; approvalReconnectGraceMs?: number; serialDelays?: Readonly<Record<string, number | readonly number[]>> }) {
  const home = await mkdtemp(join(tmpdir(), "fulcrum-web-zeta-"));
  await mkdir(join(home, "run"), { recursive: true });
  const discovery = join(home, "run", "serve.ws.json");
  let token = crypto.randomUUID();
  let mode: Mode = "ok";
  let liveEnabled = live;
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
  const decisions: Json[] = [];
  const requests: Array<{ method: string; received: number; started: number; replied?: number }> = [];
  const sockets = new Set<ServerWebSocket<unknown>>();
  let controller: ServerWebSocket<unknown> | null = null;
  const reconnectControllers = new WeakSet<object>();
  let approvalExpiry: ReturnType<typeof setTimeout> | null = null;
  const approvalCall = { id: "live-2", name: "bash", arguments: { command: "rm -rf packages/zeta/dist && bun run build" } };
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
  const composer = composerMethods(wait, { get: () => running, set: (value) => { running = value; } });
  let serialTail = Promise.resolve<unknown>(undefined);
  const delayCalls = new Map<string, number>();
  const requestDelay = (method: string) => {
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

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request, bun) {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      if (url.searchParams.get("token") !== token || (origin && !allowed.includes(origin))) return new Response("forbidden", { status: 403 });
      return bun.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) { sockets.add(socket); },
      close(socket) {
        sockets.delete(socket);
        if (socket !== controller) return;
        controller = null;
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
      },
      message(socket, raw) {
        const received = performance.now();
        const request = JSON.parse(String(raw)) as { id: number; method: string; params?: Json };
        return schedule(async () => {
        const { id, method, params = {} } = request;
        const timing: { method: string; received: number; started: number; replied?: number } = { method, received, started: performance.now() };
        requests.push(timing);
        await wait(requestDelay(method));
        const reply = (body: Json) => {
          timing.replied = performance.now();
          socket.send(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
        };
        const send = (event: Json) => { for (const each of sockets) each.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: event })); };
        if (method === "hello") {
          if (mode === "busy" || sockets.size > 1) { socket.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "server busy" } })); socket.close(); return; }
          if (mode === "incompatible") { reply({ error: { code: -32002, message: "version mismatch", data: { requested: "1.2", supported: ["1.0"] } } }); socket.close(); return; }
          if (mode === "slow") await wait(60_000);
          controller = socket;
          const features = (params.features as string[] | undefined)?.filter((name) => name === "list_sessions_paging" || name === "delivery_id" || name === "user_message_event" || name === "user_message_delivery_id" || (name === "approval_history" && approvalHistoryMode === "advertised-with-rows") || (name === "approval_reconnect" && approvalReconnect)) ?? [];
          const reconnect = features.includes("approval_reconnect");
          if (reconnect) reconnectControllers.add(socket as object);
          reply({ result: { protocol_version: "1.2", server: "fake-zeta", capabilities: { features } } });
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
        if (method === "new_session") {
          // zeta's reply (server.py `new_session`): the full metadata of the new session, which becomes the server's own.
          if (running || rejectCreate) return reply({ error: { code: -32004, message: "a turn is already running" } });
          const created = meta(`s-new-${sessions.length}`, 0, { created_at: at(0), cwd: "/Users/dev/me/fun/fulcrum", retained_tail: 8, compaction_budget: 262144, override_audit: [], context_files: [], skill_catalog: [], agent_catalog: [], plan_mode: false, project_id: null, tool_allow: null, tool_deny: [] });
          sessions.unshift(created);
          histories[created.session_id] = [];
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
          const pending = decide && !approvalAborted ? [{ request_id: "approval-1", tool_call: { id: "live-2", name: "bash", arguments: { command: "rm -rf packages/zeta/dist && bun run build" } }, delegated: false }] : [];
          return reply({ result: { session: active ? sessions.find((session) => session.session_id === active) ?? null : null, state: running ? (decide ? "tool" : "running") : "idle", explicit_finish: false, pending_approvals: pending, usage: {}, compaction_markers: 0 } });
        }
        if (method === "resume") {
          if (mode === "broken-session") return reply({ error: { code: -32602, message: "session log is invalid at line 12" } });
          if (running && params.session_id !== active) return reply({ error: { code: -32004, message: "a turn is already running" } });
          active = String(params.session_id);
          delayedOpen = false;
          return reply({ result: { session: sessions.find((session) => session.session_id === active) } });
        }
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
          // The run starts once, after the first open of the active session finishes its history.
          if (liveEnabled && active === ACTIVE && offset + pageSize >= rows.length && !turnStarted) {
            turnStarted = true;
            running = true;
            const ask = () => new Promise<"approve" | "deny" | "abort">((resolve) => {
              approvalAborted = false;
              decide = (decision) => { decide = null; resolve(decision); };
            });
            setTimeout(() => void liveTurn(send, ask, wait, () => { running = false; }, currentHistoryMode)(), 300);
          }
          return;
        }
        if (method === "approve" || method === "deny") {
          decisions.push({ method, ...params });
          if (!decide || params.request_id !== "approval-1") return reply({ error: { code: -32006, message: "approval request is missing or already resolved" } });
          reply({ result: { accepted: true, request_id: params.request_id, decision: method } });
          if (approvalExpiry) clearTimeout(approvalExpiry);
          approvalExpiry = null;
          return decide(method);
        }
        const handled = composer.handle(method, params, active, send);
        if (handled) return reply(handled);
        reply({ error: { code: -32601, message: `method not found: ${method}` } });
        });
      },
    },
  });

  const write = (value: Json) => writeFile(discovery, JSON.stringify(value), { mode: 0o600 });
  await write({ port: server.port, token, pid: process.pid, origins: allowed });
  return {
    home,
    port: server.port,
    decisions,
    requests,
    /** Every accepted send and steer, in order. */
    sent: composer.sent,
    clearSent() { composer.clearSent(); },
    get aborts() { return composer.aborts; },
    /** Closes every socket, like a network blip; the server keeps running. */
    drop() { for (const socket of sockets) socket.close(1012, "restart"); },
    /** Removes the discovery file and refuses upgrades, like a stopped server. */
    async stop() {
      allowed = [];
      await rm(discovery, { force: true });
      this.drop();
      for (let attempt = 0; decide && attempt < 100; attempt++) await Bun.sleep(1);
    },
    async start() {
      allowed = origins;
      token = crypto.randomUUID();
      if (!decide) { approvalAborted = false; running = false; }
      await write({ port: server.port, token, pid: process.pid, origins: allowed });
    },
    /** Lists other origins in the allowlist, so this page's origin is missing. */
    async foreignOrigin() { allowed = ["http://localhost:5173"]; await write({ port: server.port, token, pid: process.pid, origins: allowed }); },
    /** Hands out a token the server will refuse. */
    async wrongToken() { await write({ port: server.port, token: "stale-token", pid: process.pid, origins: allowed }); },
    setMode(next: Mode) { mode = next; },
    setOpenDelay(ms: number) { openDelay = ms; },
    /** `true`: new_session fails the way real zeta does while a turn runs (`require_idle`). */
    setRejectCreate(next: boolean) { rejectCreate = next; },
    setHistoryMode(next: HistoryMode) { currentHistoryMode = next; },
    setLive(next: boolean) {
      if (next && !liveEnabled) {
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
  console.log(`fake zeta serve on 127.0.0.1:${fake.port} for ${origin}\nstart the app with:\n  ZETA_HOME=${fake.home} bun run --cwd apps/web dev\nctrl-c stops it and deletes ${fake.home}`);
  process.once("SIGINT", () => void fake.close().then(() => process.exit(0)));
}
