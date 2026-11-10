import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ACTIVE, startFakeZeta } from "../scripts/fake-zeta";

const bounded = <T>(promise: Promise<T>, label: string) => Promise.race([promise, Bun.sleep(10_000).then(() => { throw new Error(`timed out waiting for ${label}`); })]);

const until = async (predicate: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const firstPageStartsLiveTurn = async () => {
  const fake = await startFakeZeta({ origins: ["http://127.0.0.1:4197"], port: 0, live: true });
  const discovery = JSON.parse(await readFile(join(fake.home, "run", "serve.ws.json"), "utf8")) as { controller_token: string };
  const socket = new WebSocket(`ws://127.0.0.1:${fake.port}/`, ["zeta.v1", `zeta.bearer.${discovery.controller_token}`]);
  let id = 0;
  const pending = new Map<number, (message: any) => void>();
  let sawApproval = false;
  const request = (method: string, params: object) => bounded(new Promise<any>((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, (message) => message.error ? reject(Object.assign(new Error(message.error.message), message.error)) : resolve(message.result));
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
  }), method);
  socket.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data));
    if (typeof frame.id === "number") { pending.get(frame.id)?.(frame); pending.delete(frame.id); }
    else if (frame.method === "event" && frame.params.event === "approval_request") sawApproval = true;
  });
  try {
    await bounded(new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true }); }), "socket open");
    await request("hello", { protocol_version: "1.2", client_version: "1.2", role: "controller", features: [] });
    await request("resume", { session_id: ACTIVE });
    await request("session_history", { session_id: ACTIVE, offset: 0 });
    for (let attempt = 0; attempt < 80 && !sawApproval; attempt++) await Bun.sleep(25);
    if (sawApproval) await request("abort", {});
    return sawApproval;
  } finally {
    socket.close();
    await fake.close();
  }
};

test("each fake zeta starts its live turn from fresh history", async () => {
  expect(await firstPageStartsLiveTurn()).toBe(true);
  expect(await firstPageStartsLiveTurn()).toBe(true);
});

test("fake zeta keeps an always grant when the next approval is cancelled", async () => {
  const fake = await startFakeZeta({ origins: ["http://127.0.0.1:4197"], port: 0, live: true, sessionGrants: true, grantProof: true });
  const discovery = JSON.parse(await readFile(join(fake.home, "run", "serve.ws.json"), "utf8")) as { controller_token: string };
  const socket = new WebSocket(`ws://127.0.0.1:${fake.port}/`, ["zeta.v1", `zeta.bearer.${discovery.controller_token}`]);
  let id = 0;
  const pending = new Map<number, (message: any) => void>();
  const events: any[] = [];
  const request = (method: string, params: object) => bounded(new Promise<any>((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, (message) => message.error ? reject(Object.assign(new Error(message.error.message), message.error)) : resolve(message.result));
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
  }), method);
  socket.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data));
    if (typeof frame.id === "number") { pending.get(frame.id)?.(frame); pending.delete(frame.id); }
    else if (frame.method === "event") events.push(frame.params);
  });
  try {
    await bounded(new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true }); }), "socket open");
    await request("hello", { protocol_version: "1.2", client_version: "1.2", role: "controller", features: ["session_grants", "session_history_fidelity", "served_turn_end"] });
    await request("resume", { session_id: ACTIVE });
    await request("session_history", { session_id: ACTIVE, offset: 0 });
    await until(() => events.some((event) => event.event === "approval_request" && event.request_id === "approval-1"), "first approval");
    await request("approve", { request_id: "approval-1", scope: "always_tool" });
    await until(() => events.some((event) => event.event === "approval_request" && event.request_id === "approval-2"), "second approval");
    await request("abort", {});
    await until(() => events.some((event) => event.event === "turn_aborted"), "cancelled turn");

    const secondApproval = events.findIndex((event) => event.event === "approval_request" && event.request_id === "approval-2");
    const terminal = events.findIndex((event) => event.event === "turn_aborted");
    expect(events.slice(secondApproval + 1, terminal + 1).map((event) => event.event)).toEqual(["approval_end", "tool_end", "turn_aborted"]);
    expect(events[terminal - 2]).toMatchObject({ event: "approval_end", request_id: "approval-2", tool_call: { id: "live-3" }, data: { decision: "abort", reason: "turn_canceled" } });
    expect(events[terminal - 1]).toMatchObject({
      event: "tool_end",
      tool_call: { id: "live-3" },
      tool_result: { tool_call_id: "live-3", content: "tool execution canceled", is_error: true, is_canceled: true },
    });
    const rows: any[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const page = await request("session_history", { session_id: ACTIVE, offset });
      rows.push(...page.messages);
      offset = page.next_offset;
    }
    const canceled = rows.findIndex((row) => row.tool_result?.tool_call_id === "live-3");
    expect(rows[canceled]).toMatchObject({ role: "tool_result", tool_result: { content: "tool execution canceled", is_error: true, is_canceled: true } });
    expect(rows[canceled + 1]).toMatchObject({ event: "served_turn_end", data: { reason: "user_stop" } });

    expect(fake.sessionGrants(ACTIVE)).toEqual(["bash"]);
    expect(events.filter((event) => event.event === "session_grants_changed" && event.data?.change === "grant")).toHaveLength(1);
    const approvals = events.filter((event) => event.event === "approval_request").length;
    const agentEnds = events.filter((event) => event.event === "agent_end").length;
    await request("send", { text: "use a tool after the grant" });
    await until(() => events.filter((event) => event.event === "agent_end").length > agentEnds, "reuse turn");
    expect(events.filter((event) => event.event === "approval_request")).toHaveLength(approvals);
  } finally {
    socket.close();
    await fake.close();
  }
}, 15_000);
