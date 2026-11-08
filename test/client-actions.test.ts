import { describe, expect, test } from "bun:test";
import { createApprovalDecider, pendingApprovals } from "../src/approvals";
import { createClientActions, type ClientActionDependencies } from "../src/client-actions";
import type { ClientActionName } from "../src/commands";

const approvalItem = (request_id: string, ended = false) => ({ type: "approval" as const, ended, request: { type: "approval_request" as const, request_id } });

function approvalStore() {
  const items = new Map<string, unknown>([["first", approvalItem("request-1")], ["ended", approvalItem("request-old", true)], ["second", approvalItem("request-2")]]);
  const events: unknown[] = [];
  return {
    store: { getState: () => ({ outline: [{ id: "first" }, { id: "ended" }, { id: "second" }] }), getItem: (id: string) => items.get(id), dispatch: (event: unknown) => events.push(event) },
    events,
  };
}

function dependencies(overrides: Partial<ClientActionDependencies> = {}) {
  const approvals = approvalStore();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const state = { theme: "auto" as const, opened: 0, newRuns: 0, refreshes: 0, retries: 0 };
  const deps: ClientActionDependencies = {
    sessionId: "session-1",
    requests: new Set(["rename_session", "session_tree", "switch_branch"]),
    async request(method, params) {
      calls.push({ method, params });
      if (method === "session_tree") return { branches: [{ id: "head-1", label: "main", seq: 1, current: true }, { id: "head-2", label: "experiment", seq: 7, current: false }] };
      return {};
    },
    newRun: () => { state.newRuns++; },
    async refreshStatus() { state.refreshes++; },
    async retrySession() { state.retries++; },
    currentName: () => "current name",
    themes: ["auto", "github-light"],
    currentTheme: () => state.theme,
    setTheme: (theme) => { state.theme = theme as "auto"; },
    openFilePicker: () => { state.opened++; },
    approvalStore: approvals.store,
    decide: async () => ({}),
    ...overrides,
  };
  return { actions: createClientActions(deps), calls, state, approvals };
}

const actionNames: ClientActionName[] = ["new_session", "rename_session", "approve", "always", "deny", "theme", "branch_view", "paste", "keys", "restart", "permissions"];

test("the client action table is exhaustive", () => {
  const { actions } = dependencies();
  expect(Object.keys(actions).sort()).toEqual([...actionNames].sort());
});

describe("approval actions", () => {
  test("no key chooses the first pending request and the shared decider ends it", async () => {
    const approvals = approvalStore();
    const requests: unknown[] = [];
    const decide = createApprovalDecider({ request: async (method, params, options) => { requests.push({ method, params, options }); return {}; } }, approvals.store);
    const { actions } = dependencies({ approvalStore: approvals.store, decide });
    expect(await actions.approve("")).toEqual({ text: "approval · approved request-1", tone: "quiet" });
    expect(requests).toEqual([{ method: "approve", params: { request_id: "request-1" }, options: { timeoutMs: 15_000 } }]);
    expect(approvals.events).toEqual([{ type: "approval_end", request_id: "request-1", data: { decision: "allow" } }]);
  });

  test("an exact key chooses that request and missing or disabled requests do not decide", async () => {
    const decided: unknown[] = [];
    const { actions } = dependencies({ decide: async (...args) => { decided.push(args); return {}; } });
    expect(await actions.deny("request-2")).toEqual({ text: "approval · denied request-2", tone: "quiet" });
    expect(await actions.approve("missing")).toEqual({ text: "approval · no matching request", tone: "error" });
    expect(decided).toEqual([["deny", "request-2", false]]);

    const disabled = dependencies({ approvalDisabledReason: "reconnecting — decisions are disabled until the server confirms this run", decide: async (...args) => { decided.push(args); } });
    expect(await disabled.actions.approve("")).toEqual({ text: "reconnecting — decisions are disabled until the server confirms this run", tone: "error", retain: true });
    expect(decided).toHaveLength(1);
  });

  test("expired decisions use the card error and pending order ignores ended rows", async () => {
    const approvals = approvalStore();
    expect(pendingApprovals(approvals.store).map((item) => item.request.request_id)).toEqual(["request-1", "request-2"]);
    const decide = createApprovalDecider({ request: async () => { throw Object.assign(new Error("expired"), { code: -32006 }); } }, approvals.store);
    expect(decide("approve", "request-1")).rejects.toThrow("this approval expired while you were disconnected");
  });
});

test("new, name, theme, paste, and fixed receipts use their real actions", async () => {
  const { actions, calls, state } = dependencies();
  expect(await actions.new_session("later")).toEqual({ text: "new unchanged: /new does not accept arguments", tone: "error" });
  await actions.new_session("");
  expect(state.newRuns).toBe(1);
  expect(await actions.rename_session("")).toEqual({ text: "session name: current name", tone: "quiet" });
  expect(await actions.rename_session("ship it")).toEqual({ text: "session name: ship it", tone: "quiet" });
  expect(calls[0]).toEqual({ method: "rename_session", params: { session_id: "session-1", name: "ship it" } });
  expect(state.refreshes).toBe(1);
  expect(await actions.theme("github-light")).toEqual({ text: "theme: github-light", tone: "quiet" });
  expect(state.theme).toBe("github-light");
  expect((await actions.theme("missing"))?.text).toContain("unknown theme 'missing'");
  expect(await actions.paste("file")).toEqual({ text: "paste unavailable: /paste does not take arguments", tone: "error" });
  expect(await actions.paste("")).toEqual({ text: "choose images to attach (paste and drop also work)", tone: "quiet" });
  expect(state.opened).toBe(1);
  expect(await actions.restart("")).toEqual({ text: "/restart restarts the terminal app; gamma reconnects on its own", tone: "quiet" });
  expect(await actions.permissions("")).toEqual({ text: "/permissions arrives with the session grants view", tone: "quiet" });
});

test("tree lists, switches, and resyncs only after a successful switch", async () => {
  const { actions, calls, state } = dependencies();
  expect(await actions.branch_view("")).toEqual({ text: "* 1. main\n  2. experiment", tone: "quiet" });
  expect(await actions.branch_view("2")).toEqual({ text: "switched to branch 2 (head 7)", tone: "quiet" });
  expect(calls).toEqual([
    { method: "session_tree", params: { session_id: "session-1" } },
    { method: "session_tree", params: { session_id: "session-1" } },
    { method: "switch_branch", params: { session_id: "session-1", head_id: "head-2" } },
  ]);
  expect(state.retries).toBe(1);
  expect(await actions.branch_view("9")).toEqual({ text: "branch unchanged: choose 1-2", tone: "error" });
});

test("capability checks fail with the command-specific newer-server text", async () => {
  const { actions } = dependencies({ requests: new Set() });
  expect(actions.rename_session("name")).rejects.toThrow("session naming needs a newer zeta server");
  expect(actions.branch_view("")).rejects.toThrow("branch history needs a newer zeta server");
});
