import { createClient, type Transport, type ZetaClient } from "@fulcrum/zeta";
import type { SessionMeta } from "../src/session";

export type Handler = (params: Record<string, unknown>) => unknown;
/** One held request: it reaches the server, then waits until the test releases it or fails it. */
export type Hold = { reached: Promise<Record<string, unknown>>; release(): void; fail(error: { code: number; message: string }): void };

/** A real zeta client over an in-memory transport; `handlers` answer requests by method. `hold` parks the nth next call of a method. */
export async function server(handlers: Record<string, Handler>, features: string[] = []) {
  let deliver!: (text: string) => void;
  let close!: (code?: number) => void;
  const calls: Array<[string, Record<string, unknown>]> = [];
  const holds = new Map<string, Array<{ remaining: number; reached(params: Record<string, unknown>): void; gate: Promise<void> }>>();
  const parked = (method: string, params: Record<string, unknown>) => {
    const queue = holds.get(method) ?? [];
    let found: Promise<void> | undefined;
    for (const item of [...queue]) if (--item.remaining === 0) { queue.splice(queue.indexOf(item), 1); item.reached(params); found = item.gate; }
    return found;
  };
  const transport: Transport = {
    onMessage(callback) { deliver = callback; },
    onClose(callback) { close = callback; },
    close() {},
    send(text) {
      const { id, method, params } = JSON.parse(text);
      calls.push([method, params]);
      const gate = parked(method, params);
      queueMicrotask(async () => {
        try {
          await gate;
          const result = method === "hello" ? { protocol_version: "1.2", capabilities: { features } } : await handlers[method]!(params);
          deliver(JSON.stringify({ jsonrpc: "2.0", id, result }));
        } catch (error) {
          deliver(JSON.stringify({ jsonrpc: "2.0", id, error: error as object }));
        }
      });
    },
  };
  const client = createClient(transport, (flush) => flush());
  await client.hello(features);
  const event = (params: Record<string, unknown>) => deliver(JSON.stringify({ jsonrpc: "2.0", method: "event", params }));
  const hold = (method: string, nth = 1): Hold => {
    let reached!: (params: Record<string, unknown>) => void;
    let release!: () => void;
    let fail!: (error: unknown) => void;
    const gate = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
    const arrival = new Promise<Record<string, unknown>>((resolve) => { reached = resolve; });
    holds.set(method, [...(holds.get(method) ?? []), { remaining: nth, reached, gate }]);
    return { reached: arrival, release, fail };
  };
  return { client, calls, event, hold, drop: () => close(1006) };
}

export const meta = (id: string, updated: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({ session_id: id, created_at: updated, updated_at: updated, ...extra });
export const history: Record<string, unknown[]> = {
  a: [{ id: "a1", role: "user", content: [{ type: "text", text: "hello a" }], tool_result: null }],
  b: [
    { id: "b1", role: "user", content: [{ type: "text", text: "hello b" }], tool_result: null },
    { id: "b2", role: "assistant", content: [{ type: "text", text: "on it" }], tool_result: null },
  ],
  c: [
    { id: "c1", role: "assistant", content: [{ type: "tool_use", tool_call: { id: "tool-c", name: "bash", arguments: {} } }], tool_result: null },
    { id: "c2", role: "tool_result", content: [{ type: "text", text: "done" }], tool_result: { tool_call_id: "tool-c", content: "done", is_error: false } },
  ],
};

export function source(client: ZetaClient | null) {
  const listeners = new Set<() => void>();
  return {
    client,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    set(next: ZetaClient | null) { this.client = next; listeners.forEach((listener) => listener()); },
  };
}
export const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
export async function waitFor(check: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeout}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function handlers(active: string | null, extra: Record<string, Handler> = {}): Record<string, Handler> {
  let current = active;
  return {
    status: () => ({ session: current ? meta(current, "x") : null, state: "idle", pending_approvals: current === "b" || current === "c" ? [{ request_id: "r1", tool_call: { id: "t9", name: "bash", arguments: { command: "rm -rf dist" } }, delegated: false }] : [] }),
    resume: (params) => { current = params.session_id as string; return { session: meta(current, "x") }; },
    session_history: (params) => {
      const rows = history[params.session_id as string] ?? [];
      const offset = params.offset as number;
      return { messages: rows.slice(offset, offset + 1), next_offset: offset + 1 < rows.length ? offset + 1 : null };
    },
    ...extra,
  };
}
