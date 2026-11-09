import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startFakeZeta } from "../scripts/fake-zeta";

type Frame = { id?: number; result?: { messages?: Record<string, unknown>[]; next_offset?: number | null; state?: string }; error?: { code: number; message: string } };
type Request = (method: string, params: Record<string, unknown>) => Promise<Frame>;
const bounded = <T>(promise: Promise<T>, label: string) => Promise.race([
  promise,
  Bun.sleep(10_000).then((): T => { throw new Error(`timed out waiting for ${label}`); }),
]);

async function history(features: string[], session = "s-fidelity", beforeHistory?: (request: Request) => Promise<void>) {
  const origin = "http://127.0.0.1:4225";
  const fake = await startFakeZeta({ origins: [origin], port: 0, live: false });
  const discovery = JSON.parse(await readFile(join(fake.home, "run", "serve.ws.json"), "utf8")) as { controller_token: string };
  const socket = new WebSocket(`ws://127.0.0.1:${fake.port}/`, ["zeta.v1", `zeta.bearer.${discovery.controller_token}`]);
  const pending = new Map<number, (frame: Frame) => void>();
  let id = 0;
  socket.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data)) as Frame;
    if (typeof frame.id !== "number") return;
    pending.get(frame.id)?.(frame);
    pending.delete(frame.id);
  });
  const request = (method: string, params: Record<string, unknown>) => bounded(new Promise<Frame>((resolve) => {
    const requestId = ++id;
    pending.set(requestId, resolve);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
  }), method);
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
    }), "socket open");
    expect((await request("hello", { protocol_version: "1.2", client_version: "1.2", role: "controller", features })).error).toBeUndefined();
    expect((await request("resume", { session_id: session })).error).toBeUndefined();
    await beforeHistory?.(request);
    const rows: Record<string, unknown>[] = [];
    for (let offset: number | null = 0; offset !== null; ) {
      const reply = await request("session_history", { session_id: session, offset });
      expect(reply.error).toBeUndefined();
      rows.push(...(reply.result?.messages ?? []));
      offset = reply.result?.next_offset ?? null;
    }
    return rows;
  } finally {
    socket.close();
    await fake.close();
  }
}

const waitForCompletedTurn = (request: Request, label: string) => bounded((async () => {
  let sawRunning = false;
  while (true) {
    const state = (await request("status", {})).result?.state;
    sawRunning ||= state !== "idle";
    if (sawRunning && state === "idle") return;
    await Bun.sleep(20);
  }
})(), label);

test("a client without fidelity still opens legacy history without fidelity-only rows", async () => {
  const rows = await history([], "s-reconnect");
  expect(rows.some((row) => row.id === "h1")).toBe(true);
  expect(rows.some((row) => row.event === "delivery_status")).toBe(false);
});

test("fake history projects legacy and fidelity rows per negotiated socket", async () => {
  const legacy = await history([]);
  const fidelity = await history(["session_history_fidelity"]);
  const legacyCallRow = legacy.find((row) => row.id === "fidelity-call");
  const fidelityCallRow = fidelity.find((row) => row.id === "fidelity-call");
  const legacyResultRow = legacy.find((row) => row.id === "fidelity-result");
  const fidelityResultRow = fidelity.find((row) => row.id === "fidelity-result");
  expect(legacyCallRow).toBeDefined();
  expect(fidelityCallRow).toBeDefined();
  expect(legacyResultRow).toBeDefined();
  expect(fidelityResultRow).toBeDefined();
  const legacyCall = (legacyCallRow!.content as Array<{ tool_call: Record<string, unknown> }>)[0]!.tool_call;
  const fidelityCall = (fidelityCallRow!.content as Array<{ tool_call: Record<string, unknown> }>)[0]!.tool_call;
  const legacyResult = legacyResultRow!.tool_result as Record<string, unknown>;
  const fidelityResult = fidelityResultRow!.tool_result as Record<string, unknown>;

  expect(legacyCall).toMatchObject({ arguments: {} });
  expect(legacyCall).not.toHaveProperty("arguments_truncated");
  expect(legacyResult).toMatchObject({ structured_content: null, content_blocks: [] });
  expect(legacy.some((row) => row.event === "delivery_status")).toBe(false);

  expect(fidelityCall).toMatchObject({ arguments: { command: expect.stringContaining("fidelity-marker") }, arguments_truncated: true });
  expect(fidelityResult).toMatchObject({
    structured_content: { exit_code: 2, stdout: "", stderr: "failed\n", stdout_truncated: false, stderr_truncated: false, cwd_after: "/tmp" },
    structured_content_truncated: false,
    content_blocks: [{ type: "image", mimeType: "image/png", caption: "fidelity preview", width: 640, height: 360, size: 1234, data_omitted: true }],
  });
  expect(fidelity.filter((row) => row.event === "delivery_status")).toHaveLength(11);
});

test("fake failed turns keep zeta's durable row order and shape", async () => {
  const rows = await history(["served_turn_end"], "s-reconnect", async (request) => {
    expect((await request("send", { text: "fail this turn" })).error).toBeUndefined();
    await waitForCompletedTurn(request, "failed fake turn to finish");
  });
  const failed = rows.findIndex((row) => row.failed_turn !== undefined);
  expect(failed).toBeGreaterThanOrEqual(0);
  expect(rows[failed]).toMatchObject({ role: "assistant", content: [], tool_result: null, failed_turn: { code: "provider_error" } });
  expect(rows[failed + 1]).toMatchObject({ role: "system", event: "served_turn_end", data: { reason: "error" } });
  expect(rows[failed + 1]).not.toHaveProperty("content");
});
