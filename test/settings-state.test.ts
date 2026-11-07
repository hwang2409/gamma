import { expect, test } from "bun:test";
import { reduceWorkspace, createRunStateStore, type DraftRunId, type EntryId, type OperationId, type SessionId, type WorkspaceState } from "../src/run-state";
import { createDeliveryManager } from "../src/delivery";

const draft = "draft:settings" as DraftRunId;
const session = "s-settings" as SessionId;
const operation = (value: string) => value as OperationId;
const initial = (): WorkspaceState => ({ entry: { id: "entry" as EntryId, run: draft }, runs: new Map(), aliases: new Map(), attachment: { kind: "detached" } });

const apply = (state: WorkspaceState, event: Parameters<typeof reduceWorkspace>[1]) => reduceWorkspace(state, event);

test("blank-run choices survive promotion and drive one tagged settings write", () => {
  let result = apply(initial(), { type: "SETTINGS_DESIRED", runId: draft, model: "gpt-5.1-codex", approval_mode: "allow" });
  result = apply(result.state, { type: "PROMOTE", runId: draft, sessionId: session });
  result = apply(result.state, { type: "SETTINGS_WRITE", runId: session, operationId: operation("write-1") });

  expect(result.effects).toEqual([{ type: "set-settings", runId: session, operationId: operation("write-1"), settings: { model: "gpt-5.1-codex", approval_mode: "allow" } }]);
  expect(result.state.runs.get(session)?.settings).toMatchObject({ desired: { model: "gpt-5.1-codex", approval_mode: "allow" }, pending: { operationId: operation("write-1"), kind: "write" } });
});

test("failed and stale settings results keep the old value and the latest error", () => {
  let state = initial();
  state = apply(state, { type: "PROMOTE", runId: draft, sessionId: session }).state;
  state = apply(state, { type: "SETTINGS_LOAD", runId: session, operationId: operation("load") }).state;
  state = apply(state, { type: "SETTINGS_OK", runId: session, operationId: operation("load"), model: "old", approval_mode: "ask" }).state;
  state = apply(state, { type: "SETTINGS_DESIRED", runId: session, model: "new", approval_mode: "allow" }).state;
  state = apply(state, { type: "SETTINGS_WRITE", runId: session, operationId: operation("write-1") }).state;
  state = apply(state, { type: "SETTINGS_WRITE", runId: session, operationId: operation("write-2") }).state;
  state = apply(state, { type: "SETTINGS_OK", runId: session, operationId: operation("write-1"), model: "new", approval_mode: "allow" }).state;
  state = apply(state, { type: "SETTINGS_FAIL", runId: session, operationId: operation("write-2"), error: "busy" }).state;

  expect(state.runs.get(session)?.settings).toMatchObject({ loaded: { model: "old", approval_mode: "ask" }, desired: { model: "new", approval_mode: "allow" }, error: "busy" });
});

test("settings calls cross the effect executor and a failed write keeps the loaded value", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let fail = false;
  const client = { features: [], request: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "set_settings" && fail) throw new Error("busy");
    return method === "session_settings" ? { model: "old", approval_mode: "ask" } : {};
  } } as any;
  const store = createRunStateStore(8, undefined, undefined, { id: "entry" as EntryId, run: session });
  store.activate(session);
  const manager = createDeliveryManager(() => client, store);
  try {
    store.dispatch({ type: "SETTINGS_LOAD", runId: session, operationId: operation("load") });
    await Bun.sleep(0);
    fail = true;
    store.dispatch({ type: "SETTINGS_DESIRED", runId: session, model: "new", approval_mode: "allow" });
    store.dispatch({ type: "SETTINGS_WRITE", runId: session, operationId: operation("write") });
    await Bun.sleep(0);
    expect(calls).toEqual([
      { method: "session_settings", params: { session_id: session } },
      { method: "set_settings", params: { session_id: session, model: "new", approval_mode: "allow" } },
    ]);
    expect(store.get(session).settings).toMatchObject({ loaded: { model: "old", approval_mode: "ask" }, desired: { model: "new", approval_mode: "allow" }, error: "busy" });
  } finally { manager.dispose(); store.dispose(); }
});

test("an approval-only write reads and preserves zeta's default model", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = { features: [], request: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return method === "session_settings" ? { model: "server-default", approval_mode: "ask" } : {};
  } } as any;
  const store = createRunStateStore(8, undefined, undefined, { id: "entry" as EntryId, run: session });
  store.activate(session);
  const manager = createDeliveryManager(() => client, store);
  try {
    store.dispatch({ type: "SETTINGS_DESIRED", runId: session, approval_mode: "allow" });
    store.dispatch({ type: "SETTINGS_WRITE", runId: session, operationId: operation("default-write") });
    await Bun.sleep(0);
    expect(calls).toEqual([
      { method: "session_settings", params: { session_id: session } },
      { method: "set_settings", params: { session_id: session, model: "server-default", approval_mode: "allow" } },
      { method: "session_settings", params: { session_id: session } },
    ]);
  } finally { manager.dispose(); store.dispose(); }
});

test("a settings change during a turn stays desired until the idle write", () => {
  let state = initial();
  state = apply(state, { type: "PROMOTE", runId: draft, sessionId: session }).state;
  state = apply(state, { type: "STATUS", sessionId: session, turn: "running" }).state;
  let result = apply(state, { type: "SETTINGS_DESIRED", runId: session, model: "next-model", approval_mode: "allow" });
  expect(result.effects).toEqual([]);
  expect(result.state.runs.get(session)?.settings.desired).toEqual({ model: "next-model", approval_mode: "allow" });

  result = apply(result.state, { type: "TURN_END", runId: session });
  result = apply(result.state, { type: "SETTINGS_WRITE", runId: session, operationId: operation("idle-write") });
  expect(result.effects).toEqual([{ type: "set-settings", runId: session, operationId: operation("idle-write"), settings: { model: "next-model", approval_mode: "allow" } }]);
});

test("settings are isolated by run when a slow result arrives after navigation", () => {
  const other = "s-other" as SessionId;
  let state = initial();
  state = apply(state, { type: "PROMOTE", runId: draft, sessionId: session }).state;
  state = apply(state, { type: "SETTINGS_LOAD", runId: session, operationId: operation("slow") }).state;
  state = apply(state, { type: "NAVIGATED", entryId: "other-entry" as EntryId, runId: other }).state;
  state = apply(state, { type: "SETTINGS_LOAD", runId: other, operationId: operation("fast") }).state;
  state = apply(state, { type: "SETTINGS_OK", runId: other, operationId: operation("fast"), model: "other-model", approval_mode: "allow" }).state;
  state = apply(state, { type: "SETTINGS_OK", runId: session, operationId: operation("slow"), model: "first-model", approval_mode: "ask" }).state;

  expect(state.runs.get(session)?.settings).toMatchObject({ loaded: { model: "first-model", approval_mode: "ask" } });
  expect(state.runs.get(other)?.settings).toMatchObject({ loaded: { model: "other-model", approval_mode: "allow" } });
});
