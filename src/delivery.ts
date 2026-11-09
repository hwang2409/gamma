import type { RunEvent } from "@fulcrum/core";
import type { ZetaClient } from "@fulcrum/zeta";
import { decideSend, type PendingDelivery } from "./delivery-owner";
import { catalogModels, catalogProviders, settingModel } from "./settings";

/** Zeta errors that mean the turn changed state between the click and the server: -32004 running, -32005 not running. */
const TURN_RUNNING = -32004;
const NO_TURN = -32005;
const DETAILS_EVICTED = -32010;
const code = (error: unknown) => (error as { code?: unknown } | null)?.code;

type Accepted = { accepted?: boolean; status?: string };

/**
 * A retried id whose details zeta evicted (zeta delivery.py:401-407: -32010 with `data.outcome`): the first attempt
 * landed, and its outcome says what happened. Null for any other error.
 */
export const evictedResult = (error: unknown): Accepted | null => {
  if (code(error) !== DETAILS_EVICTED) return null;
  const outcome = (error as { data?: { outcome?: unknown } }).data?.outcome;
  return { accepted: outcome !== "dropped", status: String(outcome) };
};

/** One message the user asked for. `intent` names it for its whole life; `id` names one attempt to deliver it. */
type Message = { text: string; intent: string; id: string | null };
type Method = "send" | "steer";

/** Whether the turn changed state between the click and the server, so the other method should run instead. */
const raced = (method: Method, error: unknown) => code(error) === (method === "steer" ? NO_TURN : TURN_RUNNING);
/** A definite refusal (`accepted: false`): zeta did no work for this id, so a resend needs a new one. */
export const refusal = (result: Accepted) => Object.assign(new Error(result.status === "dropped" ? "the server dropped this message before the turn took it; send it again" : "the server did not accept this message"), { refused: true });

/** Performs one idempotent zeta delivery attempt and publishes its accepted user row. Durable retry and stop policy lives in RunRecord.deliveries. */

export function createDelivery(newId: () => string = () => `web-${crypto.randomUUID()}`, reconcile?: (event: RunEvent) => void) {
  const request = async (client: ZetaClient, method: Method, { text, id, intent }: Message) => {
    try {
      return (await client.request(method, { text, ...(id ? { delivery_id: id } : {}) }, { timeoutMs: 15_000, intent })) as Accepted;
    } catch (error) {
      const evicted = evictedResult(error);
      if (evicted) return evicted;
      throw error;
    }
  };
  /** Delivers one attempt and handles a turn-state race by trying the other method once. */
  const deliver = async (client: ZetaClient, method: Method, message: Message) => {
    let used = method;
    let result: Accepted;
    try {
      result = await request(client, method, message);
    } catch (error) {
      if (!raced(method, error)) throw error;
      used = method === "steer" ? "send" : "steer";
      result = await request(client, used, message);
    }
    return { result, used };
  };
  const reconcileAccepted = (message: Message, used: Method, result: Accepted) => {
    if (result.accepted !== true || !message.id || !reconcile) return;
    // The echo is display only: zeta already took the message, and a reopen replays it from history.
    try { reconcile({ type: "user_message", text: message.text, mode: used, intent: message.intent, delivery_id: message.id }); } catch {}
  };
  const fresh = (client: ZetaClient, text: string, deliveryId = newId()): Message =>
    ({ text, intent: deliveryId, id: client.features.includes("delivery_id") ? deliveryId : null });
  return {
    /** One attempt with `deliveryId`; `intent` names the message's row when this attempt resends it. */
    async submit(client: ZetaClient, text: string, steer: boolean, deliveryId = newId(), intent = deliveryId) {
      const message = { ...fresh(client, text, deliveryId), intent };
      const delivered = await deliver(client, steer ? "steer" : "send", message);
      if (delivered.result.accepted === false) throw refusal(delivered.result);
      reconcileAccepted(message, delivered.used, delivered.result);
      return delivered;
    },
    stop(client: ZetaClient) { return stopTurn(client); },
  };
}

type DeliveryStore = {
  hasMessageDelivery(id: string): boolean;
  dispatch(event: RunEvent): void;
  subscribe(listener: () => void): () => void;
};
type DeliveryRunStore = import("./run-state").RunStateStore;
type WorkspaceEffect = import("./run-state").WorkspaceEffect;
type OperationId = import("./run-state").OperationId;
type RunId = import("./run-state").RunId;
type DeliveryRecord = { delivery: ReturnType<typeof createDelivery>; store?: DeliveryStore; unsubscribe?: () => void };

/** The small effect seam: reducer effects enter; owner- and operation-tagged results return through RunStateStore.dispatch. */
function createDeliveryEffectExecutor(client: () => ZetaClient | null, runs: DeliveryRunStore, record: (runId: string) => DeliveryRecord, finish: (operationId: OperationId, error?: unknown) => void, opaqueInputs: Map<OperationId, string>, abortSession?: (runId: string) => Promise<unknown>, commandFailure?: (runId: string, text: string) => void) {
  const unavailable = () => new Error("not connected to zeta serve");
  const handleAbort = async (effect: Extract<WorkspaceEffect, { type: "abort" }>) => {
    const target = client();
    if (!target) { const error = unavailable(); runs.dispatch({ type: "STOP_FAIL", runId: effect.runId, operationId: effect.operationId }); return finish(effect.operationId, error); }
    try { await (abortSession ? abortSession(effect.runId) : record(effect.runId).delivery.stop(target)); runs.dispatch({ type: "STOP_OK", runId: effect.runId, operationId: effect.operationId }); finish(effect.operationId); }
    catch (error) { runs.dispatch({ type: "STOP_FAIL", runId: effect.runId, operationId: effect.operationId }); finish(effect.operationId, error); }
  };
  const handleStatus = async (effect: Extract<WorkspaceEffect, { type: "delivery-status" }>) => {
    const target = client(); if (!target) return;
    const record = runs.get(effect.runId);
    const delivery = record.deliveries.get(effect.intentId);
    const retry = record.retryDelivery?.id === effect.intentId ? record.retryDelivery : undefined;
    if (delivery ? delivery.operationId !== effect.operationId : retry?.operationId !== effect.operationId) return;
    try {
      const result = await target.request("delivery_status", { delivery_id: delivery?.attemptId ?? effect.intentId }, { timeoutMs: 15_000 }) as { status?: string; outcome?: string };
      const status = result.status === "evicted" ? result.outcome : result.status;
      const unknown = status === "unknown" || status === "not_delivered";
      const settled = status === "delivered" ? "delivered" : status === "dropped" || (delivery?.method === "opaque" && unknown) ? "dropped" : unknown ? "unknown" : null;
      if (!settled) return;
      // zeta drops a queued steer with reason turn_end only when the turn completed (delivery.py:305-312); status says how the last turn ended.
      const turnEnded = settled === "dropped" && delivery?.method === "steer" && delivery.here && !delivery.resent
        ? ((await target.request("status", {}, { timeoutMs: 15_000 })) as { last_turn_outcome?: { reason?: string } | null }).last_turn_outcome?.reason === "completed" : false;
      runs.dispatch({ type: "DELIVERY_STATUS", runId: effect.runId, intentId: effect.intentId, operationId: effect.operationId, status: settled, turnEnded });
      if (settled === "dropped" && delivery?.method === "opaque") commandFailure?.(effect.runId, "outcome unknown; this command was not retried");
    } catch { /* A later turn end or open queries durable truth again. */ }
  };
  /** An opaque command input: exactly one `send {input_id}`, never resent after an uncertain outcome. */
  const handleOpaqueDelivery = async (effect: Extract<WorkspaceEffect, { type: "deliver" }>, delivery: PendingDelivery, target: ZetaClient | null) => {
    const inputId = opaqueInputs.get(effect.operationId);
    opaqueInputs.delete(effect.operationId);
    const decision = decideSend(runs.getCatalog(), effect.runId, { kind: "attempt", intentId: effect.intentId });
    if (target && inputId && decision.blocked) { runs.restoreDraft(effect.runId, delivery.text); runs.dispatch({ type: "DELIVERY_ACK", runId: effect.runId, intentId: effect.intentId, operationId: effect.operationId, attemptId: delivery.attemptId, failed: true }); return finish(effect.operationId, new Error(decision.blocked)); }
    if (!target || !inputId) { const error = unavailable(); runs.dispatch({ type: "DELIVERY_ACK", runId: effect.runId, intentId: effect.intentId, operationId: effect.operationId, attemptId: delivery.attemptId, failed: true }); return finish(effect.operationId, error); }
    try {
      const result = await target.request("send", { input_id: inputId, ...(delivery.attemptId ? { delivery_id: delivery.attemptId } : {}) }, { timeoutMs: 15_000, intent: delivery.id }) as Accepted;
      if (result.accepted === false) throw Object.assign(refusal(result), { code: -1 });
      runs.dispatch({ type: "DELIVERY_ACK", runId: effect.runId, intentId: effect.intentId, operationId: effect.operationId, attemptId: delivery.attemptId, queued: Boolean(delivery.attemptId) });
      return finish(effect.operationId);
    } catch (error) {
      const uncertain = typeof code(error) !== "number";
      if (!uncertain || !delivery.attemptId) runs.restoreDraft(effect.runId, delivery.text);
      const failure = uncertain ? "outcome unknown; this command was not retried" : error instanceof Error ? error.message : String(error);
      commandFailure?.(effect.runId, failure);
      runs.dispatch({ type: "DELIVERY_ACK", runId: effect.runId, intentId: effect.intentId, operationId: effect.operationId, attemptId: delivery.attemptId, ...(uncertain && delivery.attemptId ? { queued: true } : { failed: true }) });
      return finish(effect.operationId, uncertain && !delivery.attemptId ? new Error(failure) : error);
    }
  };
  const handleDelivery = async (effect: Extract<WorkspaceEffect, { type: "deliver" }>) => {
    const delivery = runs.get(effect.runId).deliveries.get(effect.intentId);
    if (!delivery || delivery.operationId !== effect.operationId) return;
    const target = client();
    if (delivery.method === "opaque") return handleOpaqueDelivery(effect, delivery, target);
    const decision = decideSend(runs.getCatalog(), effect.runId, { kind: "attempt", intentId: effect.intentId });
    const nothingSent = (error: Error) => { runs.dispatch({ type: "DELIVERY_ACK", runId: effect.runId, intentId: effect.intentId, operationId: effect.operationId, attemptId: delivery.attemptId, failed: true, refused: true }); finish(effect.operationId, error); };
    if (!target) return nothingSent(unavailable());
    if (decision.blocked) return nothingSent(new Error(decision.blocked));
    try {
      // shortcut: zeta's send has no session_id guard yet, so decideSend checks the attached session; pass session_id here once zeta ships that guard.
      await record(effect.runId).delivery.submit(target, delivery.text, delivery.method === "steer", decision.id, delivery.id);
      runs.dispatch({ type: "DELIVERY_ACK", runId: effect.runId, intentId: effect.intentId, operationId: effect.operationId, attemptId: decision.id, queued: target.features.includes("delivery_id") });
      finish(effect.operationId);
    } catch (error) { runs.dispatch({ type: "DELIVERY_ACK", runId: effect.runId, intentId: effect.intentId, operationId: effect.operationId, attemptId: decision.id, failed: true, refused: (error as { refused?: boolean }).refused === true }); finish(effect.operationId, error); }
  };
  const settingsFailure = (effect: Extract<WorkspaceEffect, { type: "load-settings" | "set-settings" }>, error: unknown) => {
    runs.dispatch({ type: "SETTINGS_FAIL", runId: effect.runId, operationId: effect.operationId, error: error instanceof Error ? error.message : "settings unavailable" }); finish(effect.operationId, error);
  };
  const handleSettings = async (effect: Extract<WorkspaceEffect, { type: "load-settings" | "set-settings" }>) => {
    const target = client(); if (!target) return settingsFailure(effect, unavailable());
    try {
      if (effect.type === "set-settings") {
        const current = effect.settings.model ? {} : settingModel(await target.request("session_settings", { session_id: effect.runId }, { timeoutMs: 15_000 }));
        await target.request("set_settings", { session_id: effect.runId, ...effect.settings, ...(current.model ? { model: current.model } : {}) }, { timeoutMs: 15_000 });
      }
      const value = settingModel(await target.request("session_settings", { session_id: effect.runId }, { timeoutMs: 15_000 }));
      runs.dispatch({ type: "SETTINGS_OK", runId: effect.runId, operationId: effect.operationId, ...(value.model ? { model: value.model } : {}), ...(value.approval_mode === "ask" || value.approval_mode === "allow" ? { approval_mode: value.approval_mode } : {}), ...(typeof value.plan_mode === "boolean" ? { plan_mode: value.plan_mode } : {}) }); finish(effect.operationId);
    } catch (error) { settingsFailure(effect, error); }
  };
  const handleCatalog = async (effect: Extract<WorkspaceEffect, { type: "load-catalog" }>) => {
    const target = client(); if (!target) { const error = unavailable(); runs.dispatch({ type: "CATALOG_FAIL", operationId: effect.operationId, error: error.message }); return finish(effect.operationId, error); }
    try {
      const raw = await target.request("model_catalog", effect.runId ? { session_id: effect.runId } : {}, { timeoutMs: 15_000 });
      const catalog = { models: catalogModels(raw), providers: catalogProviders(raw) };
      localStorage.setItem("gamma-catalog", JSON.stringify(raw)); runs.dispatch({ type: "CATALOG_OK", operationId: effect.operationId, catalog }); finish(effect.operationId);
    } catch (error) { const message = error instanceof Error ? error.message : "model catalog unavailable"; runs.dispatch({ type: "CATALOG_FAIL", operationId: effect.operationId, error: code(error) === -32601 ? `-32601: ${message}` : message }); finish(effect.operationId, error); }
  };
  const executeOne = (effect: WorkspaceEffect) => {
    if (effect.type === "abort") return void handleAbort(effect);
    if (effect.type === "delivery-status") return void handleStatus(effect);
    if (effect.type === "deliver") return void handleDelivery(effect);
    if (effect.type === "load-settings" || effect.type === "set-settings") return void handleSettings(effect);
    if (effect.type === "load-catalog") return void handleCatalog(effect);
  };
  return { execute(effects: readonly WorkspaceEffect[]) { for (const effect of effects) executeOne(effect); } };
}

/** Coordinates UI bindings and reducer commands; all zeta calls are in the effect executor above. */
export function createDeliveryManager(client: () => ZetaClient | null, runs: DeliveryRunStore, executeSession: (effects: readonly WorkspaceEffect[]) => void = () => {}, abortSession?: (runId: string) => Promise<unknown>, commandFailure?: (runId: string, text: string) => void) {
  const records = new Map<string, DeliveryRecord>();
  const pending = new Map<string, { resolve(value?: unknown): void; reject(error: unknown): void }>();
  const opaqueInputs = new Map<OperationId, string>();
  let activeRun: string | null = null;
  const record = (runId: string): DeliveryRecord => {
    const prior = records.get(runId); if (prior) return prior;
    const next: DeliveryRecord = { delivery: createDelivery(undefined, (event) => next.store?.dispatch(event)) };
    records.set(runId, next); return next;
  };
  const finish = (operationId: OperationId, error?: unknown) => {
    const waiter = pending.get(operationId); if (!waiter) return;
    pending.delete(operationId); error === undefined ? waiter.resolve() : waiter.reject(error);
  };
  const executor = createDeliveryEffectExecutor(client, runs, record, finish, opaqueInputs, abortSession, commandFailure);
  const operation = (start: (operationId: OperationId) => void) => { const operationId = crypto.randomUUID() as OperationId; const result = new Promise<void>((resolve, reject) => pending.set(operationId, { resolve, reject })); start(operationId); return result; };
  runs.setEffectExecutor((effects) => { executor.execute(effects); executeSession(effects); });
  return {
    bind(runId: string, store: DeliveryStore | undefined) { const item = record(runId); if (item.store === store) return; item.unsubscribe?.(); item.store = store; item.unsubscribe = store?.subscribe(() => setTimeout(() => runs.reconcileDeliveries(runId), 0)); runs.reconcileDeliveries(runId); },
    reconcile(runId: string) { runs.reconcileDeliveries(runId); },
    loadCatalog(runId: string | null) { return operation((operationId) => runs.loadCatalog(runId, operationId)); },
    loadSettings(runId: string) { return operation((operationId) => runs.loadSettings(runId, operationId)); },
    async changeSettings(runId: string, patch: import("./run-state").WritableSessionSettings) {
      runs.desireSettings(runId, patch);
      if (!runs.get(runId).settings.loaded?.model && !runs.get(runId).settings.desired?.model) await this.loadSettings(runId);
      return operation((operationId) => runs.writeSettings(runId, operationId));
    },
    observeActive(runId: string | null, connected: boolean) { const previous = activeRun; activeRun = runId; if (!runId && previous && connected) runs.reconcileDeliveries(previous); },
    submit(runId: string, text: string, steer: boolean, deliveryId = runs.deliveryIdFor(runId, text)) {
      const operationId = crypto.randomUUID() as OperationId;
      const result = new Promise((resolve, reject) => pending.set(operationId, { resolve, reject }));
      runs.beginDelivery(runId, { id: deliveryId, attemptId: deliveryId, method: steer ? "steer" : "send", text, images: [] }, operationId);
      return result;
    },
    submitOpaque(runId: string, inputId: string, displayText: string, sourceText = displayText, deliveryId = `web-${crypto.randomUUID()}`) {
      const target = client();
      if (!target) return Promise.reject(new Error("not connected to zeta serve"));
      const operationId = crypto.randomUUID() as OperationId;
      const result = new Promise((resolve, reject) => pending.set(operationId, { resolve, reject }));
      opaqueInputs.set(operationId, inputId);
      runs.consumeDraft(runId, sourceText);
      runs.beginDelivery(runId, { id: deliveryId, attemptId: target.features.includes("delivery_id") ? deliveryId : "", method: "opaque", text: displayText, images: [] }, operationId);
      return result;
    },
    stop(runId: string) { const operationId = crypto.randomUUID() as OperationId; const result = new Promise((resolve, reject) => pending.set(operationId, { resolve, reject })); runs.stop(runId, operationId); return result; },
    resend(runId: string, intentId: string) { runs.dispatch({ type: "DELIVERY_RESEND", runId: runId as RunId, intentId }); },
    dispose() { records.forEach((item) => item.unsubscribe?.()); records.clear(); pending.clear(); opaqueInputs.clear(); runs.setEffectExecutor(() => {}); },
  };
}
export type DeliveryManager = ReturnType<typeof createDeliveryManager>;

/** Stops the running turn and everything it started (zeta's default session-scope abort). */
export const stopTurn = (client: ZetaClient) => client.request("abort", {}, { timeoutMs: 15_000 });
