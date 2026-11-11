import { describe, expect, test } from "bun:test";
import type { ZetaClient } from "@fulcrum/zeta";
import { createChildRunsController } from "../src/child-runs";

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

  test("mismatched and malformed sends keep the captured pair and a newer route draft", async () => {
    const calls: Call[] = [];
    const pending = deferred<unknown>();
    const responses = [{ accepted: true, run_id: "wrong" }, { accepted: "yes", run_id: "child" }];
    const zeta = client((method) => method === "child_run_send" ? Promise.resolve(responses.shift()) : Promise.resolve({ runs: [] }), calls);
    const controller = createChildRunsController(zeta);
    const key = { sessionId: "owner", runId: "child" };
    const next = { sessionId: "owner", runId: "next" };
    controller.setOwner("owner");
    controller.setDraft(key, "keep me");
    await controller.send(key, "keep me");
    await controller.send(key, "keep me");
    controller.setDraft(next, "new route draft");
    pending.resolve(undefined);
    expect(controller.draft(key)).toBe("keep me");
    expect(controller.draft(next)).toBe("new route draft");
  });

  test("open, history completion, draft, focus-like reads, and refresh send no follow-up", async () => {
    const calls: Call[] = [];
    const zeta = client((method) => Promise.resolve(method === "child_run_history"
      ? { messages: [{ id: "saved", role: "assistant", content: [{ type: "text", text: "saved" }], tool_result: null }], next_before: null, history_validator: { end: 1, entry_id: "saved" } }
      : { runs: [row("child")] }), calls);
    const controller = createChildRunsController(zeta);
    controller.setOwner("owner");
    await controller.load("owner");
    const opened = await controller.open({ sessionId: "owner", runId: "child" });
    await opened.complete;
    controller.setDraft({ sessionId: "owner", runId: "child" }, "not sent");
    void controller.snapshot;
    expect(calls.filter((call) => call.method === "child_run_send")).toHaveLength(0);
    controller.closeHistory();
  });
});
