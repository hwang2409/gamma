import { expect, test } from "bun:test";
import { createRunStateStore, hasPendingDelivery, reduceWorkspace, selectedRun, type DraftRunId, type EntryId, type OperationId, type SessionId, type WorkspaceEffect, type WorkspaceEvent, type WorkspaceState } from "../src/run-state";

const draft = (id: number) => `draft:${id}` as DraftRunId;
const session = (id: number) => `s-${id}` as SessionId;
const entry = (id: number) => `e-${id}` as EntryId;
const operation = (id: number) => `o-${id}` as OperationId;
const initial = (): WorkspaceState => ({ entry: { id: entry(0), run: draft(0) }, runs: new Map(), aliases: new Map(), attachment: { kind: "detached" } });

class Reference {
  selected: string = draft(0);
  entry = entry(0);
  aliases = new Map<string, string>();
  lifecycle = new Map<string, { kind: string; operation?: string }>();
  attached: string | null = null;
  turn: string | null = null;
  deliveries = new Map<string, Map<string, string>>();
  deliveryMethods = new Map<string, string>();
  deliveryOperations = new Map<string, string>();
  stopOperations = new Map<string, string>();
  settings = new Map<string, { desired?: string; loaded?: string; pending?: string; error?: string }>();
  canonical(id: string) { return this.aliases.get(id) ?? id; }
  apply(event: WorkspaceEvent) {
    switch (event.type) {
      case "NEW_RUN": this.entry = event.entryId; this.selected = event.runId; this.lifecycle.set(event.runId, { kind: "draft" }); break;
      case "NAVIGATED": this.entry = event.entryId; this.selected = this.canonical(event.runId); if (!this.lifecycle.has(this.selected)) this.lifecycle.set(this.selected, { kind: this.selected.startsWith("draft:") ? "draft" : "opening" }); break;
      case "FIRST_SEND": if (["draft", "failed"].includes(this.lifecycle.get(event.runId)?.kind ?? "draft")) this.lifecycle.set(event.runId, { kind: "creating", operation: event.operationId }); break;
      case "NEW_SESSION_OK": if (this.lifecycle.get(event.runId)?.operation === event.operationId) { const old = this.lifecycle.get(event.runId)!; this.lifecycle.delete(event.runId); this.lifecycle.set(event.sessionId, { ...old, kind: "opening" }); const moved = this.settings.get(event.runId); this.settings.delete(event.runId); if (moved) this.settings.set(event.sessionId, moved); else this.settings.delete(event.sessionId); this.aliases.set(event.runId, event.sessionId); if (this.selected === event.runId) this.selected = event.sessionId; this.attached = event.sessionId; this.turn = "idle"; } break;
      case "NEW_SESSION_FAIL": if (this.lifecycle.get(event.runId)?.operation === event.operationId) this.lifecycle.set(event.runId, { kind: "failed" }); break;
      case "STATUS": this.attached = event.sessionId ?? null; this.turn = event.sessionId ? event.turn : null; break;
      case "RESUME_OK": if (![...this.lifecycle.values()].some((value) => value.kind === "creating") && (!this.attached || this.turn === "idle" || this.attached === event.runId)) { this.attached = event.runId; this.turn = "idle"; this.lifecycle.set(event.runId, { kind: "opening", operation: event.operationId }); const value = this.settings.get(event.runId) ?? {}; this.settings.set(event.runId, { ...value, pending: event.operationId, error: undefined }); } break;
      case "RESUME_BUSY": this.lifecycle.set(event.runId, { kind: "opening", operation: event.operationId }); break;
      case "RESUME_FAIL": if (this.lifecycle.get(event.runId)?.operation === event.operationId) this.lifecycle.set(event.runId, { kind: "failed" }); break;
      case "FIRST_PAGE": if (!event.operationId || !this.lifecycle.get(event.runId)?.operation || this.lifecycle.get(event.runId)?.operation === event.operationId) this.lifecycle.set(event.runId, { kind: "open" }); break;
      case "TURN_START": if (this.attached === event.runId) this.turn = event.turn ?? "running"; break;
      case "TURN_END": if (this.attached === event.runId) { this.turn = "idle"; for (const [id, state] of this.deliveries.get(event.runId) ?? []) if (state !== "requesting" && state !== "dropped") this.deliveryOperations.set(id, "generated"); } break;
      case "DELIVERY_BEGIN": { const items = this.deliveries.get(event.runId) ?? new Map(); items.set(event.delivery.id, "requesting"); this.deliveryMethods.set(event.delivery.id, event.delivery.method); this.deliveryOperations.set(event.delivery.id, event.operationId); this.deliveries.set(event.runId, items); break; }
      case "DELIVERY_ACK": { if (this.deliveryOperations.get(event.intentId) !== event.operationId) break; const items = this.deliveries.get(event.runId); if (event.queued && !event.failed && items?.get(event.intentId) !== "retrying") items.set(event.intentId, "queued"); else items?.delete(event.intentId); break; }
      case "DELIVERY_STATUS": { if (this.deliveryOperations.get(event.intentId) !== event.operationId) break; const items = this.deliveries.get(event.runId); if (event.status === "delivered") items?.delete(event.intentId); else if (items?.get(event.intentId) !== "dropped") { items?.set(event.intentId, "retrying"); this.deliveryOperations.set(event.intentId, "generated"); } break; }
      case "STOP": this.stopOperations.set(event.runId, event.operationId ?? "generated"); break;
      case "STOP_OK": { if (this.stopOperations.get(event.runId) !== event.operationId) break; this.stopOperations.delete(event.runId); const items = this.deliveries.get(event.runId); for (const [id] of items ?? []) if (this.deliveryMethods.get(id) === "steer") items!.set(id, "dropped"); break; }
      case "STOP_FAIL": if (this.stopOperations.get(event.runId) === event.operationId) this.stopOperations.delete(event.runId); break;
      case "SETTINGS_DESIRED": { const value = this.settings.get(event.runId) ?? {}; this.settings.set(event.runId, { ...value, desired: event.approval_mode ?? value.desired, error: undefined }); break; }
      case "SETTINGS_LOAD": case "SETTINGS_WRITE": { const value = this.settings.get(event.runId) ?? {}; this.settings.set(event.runId, { ...value, pending: event.operationId, error: undefined }); break; }
      case "SETTINGS_OK": { const value = this.settings.get(event.runId); if (value?.pending === event.operationId) this.settings.set(event.runId, { desired: value.desired, loaded: event.approval_mode, pending: undefined }); break; }
      case "SETTINGS_FAIL": { const value = this.settings.get(event.runId); if (value?.pending === event.operationId) this.settings.set(event.runId, { ...value, pending: undefined, error: event.error }); break; }
      case "DISCONNECT": this.attached = null; this.turn = null; for (const items of this.deliveries.values()) for (const [id, state] of items) if (state === "requesting") items.set(id, "queued"); break;
      default: break;
    }
  }
}

const random = (seed: number) => () => { seed = Math.imul(seed ^ seed >>> 15, 1 | seed); seed ^= seed + Math.imul(seed ^ seed >>> 7, 61 | seed); return ((seed ^ seed >>> 14) >>> 0) / 4294967296; };

test("workspace reducer matches an independent model across navigation, activity, and stale completions", () => {
  const names = ["NEW_RUN", "NAVIGATED", "FIRST_SEND", "NEW_SESSION_OK", "NEW_SESSION_FAIL", "STATUS", "RESUME_OK", "RESUME_BUSY", "RESUME_FAIL", "FIRST_PAGE", "TURN_START", "TURN_END", "DELIVERY_BEGIN", "DELIVERY_ACK", "DELIVERY_STATUS", "STOP", "STOP_OK", "STOP_FAIL", "DISCONNECT", "RECONNECT", "SETTINGS_DESIRED", "SETTINGS_LOAD", "SETTINGS_WRITE", "SETTINGS_OK", "SETTINGS_FAIL"] as const;
  for (let seed = 0; seed < 100; seed++) {
    const next = random(seed + 1); let state = initial(); const reference = new Reference(); const prefix: WorkspaceEvent[] = [];
    for (let step = 0; step < 500; step++) {
      const n = Math.floor(next() * 8); const d = draft(n); const s = session(n); const op = operation(Math.floor(next() * 20));
      const name = names[Math.floor(next() * names.length)]!;
      const event = ({
        NEW_RUN: { type: "NEW_RUN", entryId: entry(step + 1), runId: draft(step + 100) }, NAVIGATED: { type: "NAVIGATED", entryId: entry(step + 1), runId: next() < .35 ? d : s }, FIRST_SEND: { type: "FIRST_SEND", runId: d, operationId: op }, NEW_SESSION_OK: { type: "NEW_SESSION_OK", runId: d, sessionId: s, operationId: op }, NEW_SESSION_FAIL: { type: "NEW_SESSION_FAIL", runId: d, operationId: op, error: "create failed" }, STATUS: { type: "STATUS", ...(next() < .2 ? {} : { sessionId: s }), turn: next() < .6 ? "idle" : "running" }, RESUME_OK: { type: "RESUME_OK", runId: s, operationId: op }, RESUME_BUSY: { type: "RESUME_BUSY", runId: s, owner: session((n + 1) % 8), operationId: op }, RESUME_FAIL: { type: "RESUME_FAIL", runId: s, operationId: op, error: "open failed" }, FIRST_PAGE: { type: "FIRST_PAGE", runId: s, operationId: op, transcript: `history ${n}` }, TURN_START: { type: "TURN_START", runId: s, turn: "running" }, TURN_END: { type: "TURN_END", runId: s }, DELIVERY_BEGIN: { type: "DELIVERY_BEGIN", runId: s, delivery: { id: `i-${n}`, attemptId: `i-${n}`, operationId: op, method: next() < .5 ? "send" : "steer", text: `message ${n}`, images: [], state: "requesting" }, operationId: op }, DELIVERY_ACK: { type: "DELIVERY_ACK", runId: s, intentId: `i-${n}`, operationId: op, attemptId: `i-${n}`, queued: next() < .5 }, DELIVERY_STATUS: { type: "DELIVERY_STATUS", runId: s, intentId: `i-${n}`, operationId: op, status: next() < .5 ? "delivered" : "dropped" }, STOP: { type: "STOP", runId: s, operationId: op }, STOP_OK: { type: "STOP_OK", runId: s, operationId: op }, STOP_FAIL: { type: "STOP_FAIL", runId: s, operationId: op }, DISCONNECT: { type: "DISCONNECT" }, RECONNECT: { type: "RECONNECT" }, SETTINGS_DESIRED: { type: "SETTINGS_DESIRED", runId: s, approval_mode: next() < .5 ? "ask" : "allow" }, SETTINGS_LOAD: { type: "SETTINGS_LOAD", runId: s, operationId: op }, SETTINGS_WRITE: { type: "SETTINGS_WRITE", runId: s, operationId: op }, SETTINGS_OK: { type: "SETTINGS_OK", runId: s, operationId: op, model: "m" }, SETTINGS_FAIL: { type: "SETTINGS_FAIL", runId: s, operationId: op, error: "settings failed" },
      } as const)[name] as WorkspaceEvent;
      prefix.push(event); reference.apply(event); const result = reduceWorkspace(state, event); state = result.state;
      try {
        expect(state.entry.run).toBe(reference.selected);
        expect(selectedRun(state)?.id ?? state.entry.run).toBe(reference.selected);
        const attached = state.attachment.kind === "attached" ? state.attachment.sessionId : null;
        expect(attached).toBe(reference.attached);
        if (state.attachment.kind === "attached") expect(state.attachment.turn).toBe(reference.turn);
        for (const effect of result.effects) {
          if (effect.type === "open-session" || effect.type === "new-session") expect(state.attachment.kind !== "attached" || state.attachment.turn === "idle" || state.attachment.sessionId === effect.runId).toBeTrue();
          if (effect.type === "load-settings" || effect.type === "set-settings") { expect(state.runs.get(effect.runId)?.settings.pending?.operationId).toBe(effect.operationId); expect(effect.runId).toBe(state.runs.get(effect.runId)?.id); }
        }
        for (const [runId, expected] of reference.settings) {
          const actual = state.runs.get(runId)?.settings;
          expect(actual?.desired?.approval_mode).toBe(expected.desired);
          expect(actual?.loaded?.approval_mode).toBe(expected.loaded);
          expect(actual?.pending?.operationId).toBe(expected.pending);
          expect(actual?.error).toBe(expected.error);
        }
        const owners = new Set<string>();
        for (const [runId, record] of state.runs) for (const [intent, delivery] of record.deliveries) { expect(owners.has(intent)).toBeFalse(); owners.add(intent); expect(runId).toBe(record.id); expect(delivery.state).toBe(reference.deliveries.get(runId)?.get(intent)); }
      } catch (error) { throw new Error(`seed ${seed}, step ${step}\n${JSON.stringify(prefix, null, 2)}\n${String(error)}`); }
    }
  }
});

const observe = (state: WorkspaceState, effects: ReturnType<typeof reduceWorkspace>["effects"]) => ({
  selected: state.entry.run,
  attachment: state.attachment,
  runs: [...state.runs].map(([id, record]) => [id, record.lifecycle.kind, [...record.deliveries].map(([intent, delivery]) => [intent, delivery.state])]),
  effects: effects.map((effect) => effect.type),
});

/** Three executable mutants prove the model suite observes the design's safety rules. */
test("mutation: stale operation completion is rejected", () => {
  let state = initial();
  state = reduceWorkspace(state, { type: "NAVIGATED", entryId: entry(1), runId: draft(1) }).state;
  state = reduceWorkspace(state, { type: "FIRST_SEND", runId: draft(1), operationId: operation(1) }).state;
  const correct = reduceWorkspace(state, { type: "NEW_SESSION_OK", runId: draft(1), sessionId: session(1), operationId: operation(2) });
  const mutant = reduceWorkspace(state, { type: "NEW_SESSION_OK", runId: draft(1), sessionId: session(1), operationId: operation(1) });
  expect(observe(correct.state, correct.effects)).not.toEqual(observe(mutant.state, mutant.effects));
});

test("mutation: resume cannot replace another run's active turn", () => {
  const state = reduceWorkspace(initial(), { type: "STATUS", sessionId: session(1), turn: "running" }).state;
  const event = { type: "RESUME_OK", runId: session(2), operationId: operation(1) } as const;
  const correct = reduceWorkspace(state, event);
  const mutant = reduceWorkspace({ ...state, attachment: { kind: "attached", sessionId: session(1), turn: "idle" } }, event);
  expect(observe(correct.state, correct.effects)).not.toEqual(observe(mutant.state, mutant.effects));
});

test("mutation: reconnect reconciles each durable delivery", () => {
  let state = reduceWorkspace(initial(), { type: "NAVIGATED", entryId: entry(1), runId: session(1) }).state;
  state = reduceWorkspace(state, { type: "DELIVERY_BEGIN", runId: session(1), delivery: { id: "intent", attemptId: "intent", operationId: operation(1), method: "steer", text: "keep this", images: [], state: "requesting" }, operationId: operation(1) }).state;
  state = reduceWorkspace(reduceWorkspace(state, { type: "STATUS", sessionId: session(1), turn: "running" }).state, { type: "DISCONNECT" }).state;
  const correct = reduceWorkspace(state, { type: "RECONNECT" });
  const mutant = { ...correct, effects: correct.effects.filter((effect) => effect.type !== "delivery-status") };
  expect(observe(correct.state, correct.effects)).not.toEqual(observe(mutant.state, mutant.effects));
});

test("cache eviction and disposal release owned session leases", () => {
  const released: WorkspaceEffect[] = [];
  const runId = session(1);
  const store = createRunStateStore(0, undefined, undefined, { id: entry(1), run: runId });
  store.setEffectExecutor((effects) => released.push(...effects));
  store.activate(runId, { choice: "explicit", model: "" });
  const operationId = store.requestOpen(runId);
  store.dispatch({ type: "OPEN_OK", runId, operationId, open: { id: runId, lease: { release() {} } as never, stale: false, history: { messages: 0, complete: true }, syncing: false } });
  store.activate(session(2), { choice: "explicit", model: "" });
  expect(released).toContainEqual({ type: "release-lease", runId });

  const second = createRunStateStore(0, undefined, undefined, { id: entry(2), run: runId });
  second.setEffectExecutor((effects) => released.push(...effects));
  second.activate(runId, { choice: "explicit", model: "" });
  const secondOperation = second.requestOpen(runId);
  second.dispatch({ type: "OPEN_OK", runId, operationId: secondOperation, open: { id: runId, lease: { release() {} } as never, stale: false, history: { messages: 0, complete: true }, syncing: false } });
  second.dispose();
  expect(released.filter((effect) => effect.type === "release-lease" && effect.runId === runId)).toHaveLength(2);
});

test("a successful stop settles the sent prompt and keeps only the dropped steer for resend", () => {
  const runId = session(1);
  const send = operation(1);
  const steer = operation(2);
  const stop = operation(3);
  let state = reduceWorkspace(initial(), { type: "STATUS", sessionId: runId, turn: "running" }).state;
  state = reduceWorkspace(state, { type: "DELIVERY_BEGIN", runId, operationId: send, delivery: { id: "send", attemptId: "send", operationId: send, method: "send", text: "start", images: [], state: "requesting" } }).state;
  state = reduceWorkspace(state, { type: "DELIVERY_ACK", runId, intentId: "send", operationId: send, attemptId: "send", queued: true }).state;
  state = reduceWorkspace(state, { type: "DELIVERY_BEGIN", runId, operationId: steer, delivery: { id: "steer", attemptId: "steer", operationId: steer, method: "steer", text: "keep this", images: [], state: "requesting" } }).state;
  state = reduceWorkspace(state, { type: "DELIVERY_ACK", runId, intentId: "steer", operationId: steer, attemptId: "steer", queued: true }).state;
  state = reduceWorkspace(state, { type: "STOP", runId, operationId: stop }).state;

  const stopped = reduceWorkspace(state, { type: "STOP_OK", runId, operationId: stop }).state.runs.get(runId)!;
  expect([...stopped.deliveries]).toEqual([["steer", expect.objectContaining({ state: "dropped" })]]);
  expect(hasPendingDelivery(stopped)).toBeFalse();
});

test("store updates cannot invalidate an in-flight delivery acknowledgement", () => {
  const runId = "s-pending" as SessionId;
  const operationId = "o-pending" as OperationId;
  let state: WorkspaceState = { entry: { id: "e" as EntryId, run: runId }, runs: new Map(), aliases: new Map(), attachment: { kind: "detached" } };
  state = reduceWorkspace(state, { type: "ENSURE_RUN", runId, text: "send thiskeep typing" }).state;
  state = reduceWorkspace(state, { type: "DELIVERY_BEGIN", runId, operationId, delivery: { id: "i", attemptId: "i", operationId, method: "send", text: "send this", images: [], state: "requesting" } }).state;
  const reconciled = reduceWorkspace(state, { type: "DELIVERY_RECONCILE", runId });
  expect(reconciled.effects).toEqual([]);
  state = reduceWorkspace(reconciled.state, { type: "DELIVERY_ACK", runId, intentId: "i", operationId, attemptId: "i", queued: true }).state;
  expect(state.runs.get(runId)?.text).toBe("keep typing");
});
