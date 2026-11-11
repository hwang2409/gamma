import { describe, expect, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
import { childNavigationUnavailable, createChildRunsController } from "../src/child-runs";

const row = (runId: string, status = "idle") => ({
  run_id: runId, session_id: "owner", parent_run_id: null, description: `child ${runId}`, agent_type: "worker", status,
  accepts_follow_ups: true, turns_used: 1, tool_count: 2, current_step: "waiting", started_at: "2026-11-10T00:00:00Z", finished_at: null, elapsed_seconds: 3,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

type Call = { method: string; params: Record<string, unknown> };
function client(request: (method: string, params: Record<string, unknown>) => Promise<unknown>, calls: Call[]) {
  return { features: ["child_runs", "child_run_history"], request(method: string, params: Record<string, unknown> = {}) { calls.push({ method, params }); return request(method, params); } } as ZetaClient;
}

describe("child runs controller", () => {
  test("child rows open with or without transcript history for either authority", () => {
    expect(childNavigationUnavailable({ authority: "controller", canList: true, canOpenHistory: false })).toBeUndefined();
    expect(childNavigationUnavailable({ authority: "observer", canList: true, canOpenHistory: false })).toBeUndefined();
    expect(childNavigationUnavailable({ authority: "controller", canList: false, canOpenHistory: true })).toBeUndefined();
    expect(childNavigationUnavailable({ authority: "observer", canList: false, canOpenHistory: false })).toBeUndefined();
  });
  test("refresh generations and freshness barriers never publish an older page", async () => {
    const calls: Call[] = [];
    const first = deferred<unknown>();
    const refresh = deferred<unknown>();
    const acceptedRefresh = deferred<unknown>();
    const pages = [first, refresh, acceptedRefresh];
    const zeta = client((method) => method === "child_run_send" ? Promise.resolve({ accepted: true, run_id: "child" }) : pages.shift()!.promise, calls);
    const controller = createChildRunsController(zeta, () => 10);
    controller.setOwner("owner");

    const oldLoad = controller.load("owner");
    const newLoad = controller.load("owner", "refresh");
    first.resolve({ runs: [row("stale")] });
    refresh.resolve({ runs: [row("fresh")] });
    await Promise.all([oldLoad, newLoad]);
    expect(controller.snapshot.catalog.runs.map((value) => value.runId)).toEqual(["fresh"]);

    controller.setDraft({ sessionId: "owner", runId: "child" }, "continue");
    const send = controller.send({ sessionId: "owner", runId: "child" }, "continue");
    for (let attempt = 0; calls.filter((call) => call.method === "child_run_list").length < 3 && attempt < 10; attempt++) await Promise.resolve();
    expect(calls.filter((call) => call.method === "child_run_list").map((call) => call.params.offset)).toEqual([0, 0, 0]);
    acceptedRefresh.resolve({ runs: [row("after-send")] });
    await send;
    expect(controller.snapshot.catalog.runs.map((value) => value.runId)).toEqual(["after-send"]);
    expect(controller.draft({ sessionId: "owner", runId: "child" })).toBe("");
  });

  test("a delayed continuation cannot append after refresh replaced its base", async () => {
    const calls: Call[] = [];
    const more = deferred<unknown>();
    const refresh = deferred<unknown>();
    let request = 0;
    const zeta = client((_method, params) => {
      request += 1;
      if (request === 1) return Promise.resolve({ runs: [row("first")], next_offset: 1 });
      return params.offset === 1 ? more.promise : refresh.promise;
    }, calls);
    const controller = createChildRunsController(zeta);
    controller.setOwner("owner");
    await controller.load("owner");
    const continuation = controller.load("owner", "more");
    const replacement = controller.load("owner", "refresh");
    refresh.resolve({ runs: [row("replacement")] });
    more.resolve({ runs: [row("stale-more")] });
    await Promise.all([continuation, replacement]);
    expect(controller.snapshot.catalog.runs.map((value) => value.runId)).toEqual(["replacement"]);
  });

  test("send has one pair owner and only matched acceptance clears its draft", async () => {
    const calls: Call[] = [];
    const sends = [
      { accepted: true, run_id: "other" },
      { accepted: true, run_id: "child" },
    ];
    const zeta = client((method) => Promise.resolve(method === "child_run_send" ? sends.shift() : { runs: [row("child")] }), calls);
    const controller = createChildRunsController(zeta);
    controller.setOwner("owner");
    const key = { sessionId: "owner", runId: "child" };
    const other = { sessionId: "other-owner", runId: "child" };
    controller.setDraft(key, "first");
    controller.setDraft(other, "other draft");

    await controller.send(key, "first");
    expect(controller.draft(key)).toBe("first");
    await controller.send(key, "first");
    expect(controller.draft(key)).toBe("");
    expect(controller.draft(other)).toBe("other draft");
    expect(calls.filter((call) => call.method === "child_run_send")).toHaveLength(2);
  });

  test("malformed lists retain the last valid snapshot while valid empty and unknown rows publish", async () => {
    const calls: Call[] = [];
    const responses: unknown[] = [
      { runs: [row("known")] },
      { runs: "not-an-array" },
      { runs: [{ ...row("future", "future_status"), finished_at: undefined }, { run_id: 2 }] },
      { runs: [] },
    ];
    const controller = createChildRunsController(client(() => Promise.resolve(responses.shift()), calls));
    controller.setOwner("owner");
    await controller.load("owner");
    await controller.load("owner", "refresh");
    expect(controller.snapshot.catalog.runs.map((value) => value.runId)).toEqual(["known"]);
    expect(controller.snapshot.catalog.warning).toContain("invalid");
    await controller.load("owner", "refresh");
    expect(controller.snapshot.catalog.runs[0]?.status).toEqual({ kind: "unknown", value: "future_status" });
    expect(controller.snapshot.catalog.invalidRows).toBe(1);
    await controller.load("owner", "refresh");
    expect(controller.snapshot.catalog.runs).toEqual([]);
    expect(controller.snapshot.catalog.reportedAt).not.toBeNull();
  });

  test("owner teardown keeps opaque child pairs separate and releases history", async () => {
    const calls: Call[] = [];
    const zeta = client((method) => Promise.resolve(method === "child_run_history"
      ? { messages: [], next_before: null, history_validator: { end: 0, entry_id: null } }
      : { runs: [row("nested:child:id")] }), calls);
    const controller = createChildRunsController(zeta);
    const first = { sessionId: "owner-a", runId: "nested:child:id" };
    const second = { sessionId: "owner-b", runId: "nested:child:id" };
    controller.setDraft(first, "first owner");
    controller.setDraft(second, "second owner");
    controller.setOwner("owner-a");
    const opened = await controller.open(first);
    let releases = 0;
    const release = opened.lease.release.bind(opened.lease);
    opened.lease.release = () => { releases += 1; release(); };
    controller.setOwner("owner-b");
    expect(releases).toBe(1);
    expect(controller.draft(first)).toBe("first owner");
    expect(controller.draft(second)).toBe("second owner");
  });

  test("accepted send cannot replace a newer owner or refresh the stale owner", async () => {
    const calls: Call[] = [];
    const pending = deferred<unknown>();
    const zeta = client((method) => method === "child_run_send" ? pending.promise : Promise.resolve({ runs: [] }), calls);
    const controller = createChildRunsController(zeta);
    const key = { sessionId: "owner-a", runId: "child" };
    controller.setOwner("owner-a");
    controller.setDraft(key, "follow up");
    const sent = controller.send(key, "follow up");
    controller.setOwner("owner-b");
    pending.resolve({ accepted: true, run_id: "child" });
    await sent;
    expect(controller.snapshot.catalog.owner).toBe("owner-b");
    expect(calls.map((call) => call.method)).toEqual(["child_run_send"]);
    expect(controller.draft(key)).toBe("");
  });

  test("observer authority opens history without list or send requests", async () => {
    const calls: Call[] = [];
    const zeta = client((method) => Promise.resolve(method === "child_run_history"
      ? { messages: [], next_before: null, history_validator: { end: 0, entry_id: null } }
      : method === "child_run_send" ? { accepted: true, run_id: "child" } : { runs: [] }), calls);
    const controller = createChildRunsController(zeta, Date.now, "observer");
    const key = { sessionId: "owner", runId: "child" };
    controller.setOwner("owner");
    await controller.load("owner");
    await controller.open(key);
    await controller.send(key, "must not send");
    expect(calls.map((call) => call.method)).toEqual(["child_run_history"]);
    controller.closeHistory();
  });

  test("reload restores only the matching child draft and matched acceptance clears it", async () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem(key: string) { return saved.get(key) ?? null; },
      setItem(key: string, value: string) { saved.set(key, value); },
    };
    const previous = globalThis.sessionStorage;
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
    const calls: Call[] = [];
    const zeta = client((method) => Promise.resolve(method === "child_run_send" ? { accepted: true, run_id: "child" } : { runs: [] }), calls);
    const key = { sessionId: "owner", runId: "child" };
    const other = { sessionId: "other-owner", runId: "child" };
    try {
      const beforeReload = createChildRunsController(zeta);
      beforeReload.setDraft(key, "kept through reload");
      beforeReload.setDraft(other, "other pair");
      beforeReload.dispose();

      const afterReload = createChildRunsController(zeta);
      expect(afterReload.draft(key)).toBe("kept through reload");
      expect(afterReload.draft(other)).toBe("other pair");
      expect(calls.filter((call) => call.method === "child_run_send")).toHaveLength(0);
      await afterReload.send(key, "kept through reload");

      const afterAcceptance = createChildRunsController(zeta);
      expect(afterAcceptance.draft(key)).toBe("");
      expect(afterAcceptance.draft(other)).toBe("other pair");
      afterReload.dispose();
      afterAcceptance.dispose();
    } finally {
      Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: previous });
    }
  });

  test("open, history completion, reconnect, owner switch, and refresh keep drafts without sending", async () => {
    const calls: Call[] = [];
    const drafts = new Map<string, string>();
    const zeta = client((method) => Promise.resolve(method === "child_run_history"
      ? { messages: [{ id: "saved", role: "assistant", content: [{ type: "text", text: "saved" }], tool_result: null }], next_before: null, history_validator: { end: 1, entry_id: "saved" } }
      : { runs: [row("child")] }), calls);
    const key = { sessionId: "owner", runId: "child" };
    const controller = createChildRunsController(zeta, Date.now, "controller", drafts);
    controller.setOwner("owner");
    await controller.load("owner");
    const opened = await controller.open(key);
    await opened.complete;
    controller.setDraft(key, "not sent");
    controller.setOwner("other");
    controller.setOwner("owner");
    controller.dispose();
    const reconnected = createChildRunsController(zeta, Date.now, "controller", drafts);
    reconnected.setOwner("owner");
    await reconnected.load("owner", "refresh");
    expect(reconnected.draft(key)).toBe("not sent");
    expect(calls.filter((call) => call.method === "child_run_send")).toHaveLength(0);
    reconnected.dispose();
  });
});
