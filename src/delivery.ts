import type { RunEvent } from "@fulcrum/core";
import type { ZetaClient } from "@fulcrum/zeta";

/** Zeta errors that mean the turn changed state between the click and the server: -32004 running, -32005 not running. */
const TURN_RUNNING = -32004;
const NO_TURN = -32005;
const DETAILS_EVICTED = -32010;
const code = (error: unknown) => (error as { code?: unknown } | null)?.code;

type Accepted = { accepted?: boolean; status?: string };

/** One message the user asked for. `intent` names it for its whole life; `id` names one attempt to deliver it. */
type Message = { text: string; intent: string; id: string | null };
type Method = "send" | "steer";

/** Whether the turn changed state between the click and the server, so the other method should run instead. */
const raced = (method: Method, error: unknown) => code(error) === (method === "steer" ? NO_TURN : TURN_RUNNING);
const refusal = (result: Accepted) => new Error(result.status === "dropped" ? "the server dropped this message before the turn took it; send it again" : "the server did not accept this message");

/** Performs one idempotent zeta delivery attempt and publishes its accepted user row. Durable retry and stop policy lives in RunRecord.deliveries. */

export function createDelivery(newId: () => string = () => `web-${crypto.randomUUID()}`, reconcile?: (event: RunEvent) => void) {
  const request = async (client: ZetaClient, method: Method, { text, id, intent }: Message) => {
    try {
      return (await client.request(method, { text, ...(id ? { delivery_id: id } : {}) }, { timeoutMs: 15_000, intent })) as Accepted;
    } catch (error) {
      // The id was accepted before, but the server no longer has its result: its outcome still says what happened.
      const outcome = (error as { data?: { outcome?: unknown } }).data?.outcome;
      if (code(error) === DETAILS_EVICTED) return { accepted: outcome !== "dropped", status: String(outcome) };
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
    if (result.accepted === true && message.id && reconcile)
      reconcile({ type: "user_message", text: message.text, mode: used, intent: message.intent, delivery_id: message.id });
  };
  const fresh = (client: ZetaClient, text: string, deliveryId = newId()): Message =>
    ({ text, intent: deliveryId, id: client.features.includes("delivery_id") ? deliveryId : null });
  return {
    async submit(client: ZetaClient, text: string, steer: boolean, deliveryId = newId()) {
      const message = fresh(client, text, deliveryId);
      const delivered = await deliver(client, steer ? "steer" : "send", message);
      if (delivered.result.accepted === false) throw refusal(delivered.result);
      reconcileAccepted(message, delivered.used, delivered.result);
      return delivered;
    },
    async retry(client: ZetaClient, text: string, intent: string, deliveryId = newId()) {
      const message = { text, intent, id: client.features.includes("delivery_id") ? deliveryId : null };
      const delivered = await deliver(client, "send", message);
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
};
type DeliveryRunStore = import("./run-state").RunStateStore;
type WorkspaceEffect = import("./run-state").WorkspaceEffect;
type OperationId = import("./run-state").OperationId;
type RunId = import("./run-state").RunId;
type DeliveryRecord = { delivery: ReturnType<typeof createDelivery>; store?: DeliveryStore };

/** The small effect seam: reducer effects enter; owner- and operation-tagged results return through RunStateStore.dispatch. */
function createDeliveryEffectExecutor(client: () => ZetaClient | null, runs: DeliveryRunStore, record: (runId: string) => DeliveryRecord, finish: (operationId: OperationId, error?: unknown) => void) {
  const executeOne = async (effect: WorkspaceEffect) => {
    if (effect.type !== "deliver" && effect.type !== "delivery-status" && effect.type !== "abort") return;
    const target = client();
    if (!target) {
      const error = new Error("not connected to zeta serve");
      if (effect.type === "abort") { runs.dispatch({ type: "STOP_FAIL", runId: effect.runId, operationId: effect.operationId }); finish(effect.operationId, error); }
      if (effect.type === "deliver" && "intentId" in effect) { const delivery = runs.get(effect.runId).deliveries.get(effect.intentId); if (delivery?.state !== "retrying") runs.dispatch({ type: "DELIVERY_ACK", runId: effect.runId, intentId: effect.intentId, operationId: effect.operationId, attemptId: delivery?.attemptId ?? effect.intentId, failed: true }); finish(effect.operationId, error); }
      return;
    }
    if (effect.type === "abort") { try { await record(effect.runId).delivery.stop(target); runs.dispatch({ type: "STOP_OK", runId: effect.runId, operationId: effect.operationId }); finish(effect.operationId); } catch (error) { runs.dispatch({ type: "STOP_FAIL", runId: effect.runId, operationId: effect.operationId }); finish(effect.operationId, error); } return; }
    if (!("intentId" in effect)) return;
    const delivery = runs.get(effect.runId).deliveries.get(effect.intentId);
    if (!delivery || delivery.operationId !== effect.operationId) return;
    if (effect.type === "delivery-status") {
      try {
        const result = await target.request("delivery_status", { delivery_id: delivery.attemptId }, { timeoutMs: 15_000 }) as { status?: string; outcome?: string };
        const status = result.status === "evicted" ? result.outcome : result.status;
        if (status === "delivered" || status === "dropped") runs.dispatch({ type: "DELIVERY_STATUS", runId: effect.runId, intentId: effect.intentId, operationId: effect.operationId, status });
      } catch { /* A reconnect or later turn end queries durable truth again. */ }
      return;
    }
    const attemptId = delivery.state === "retrying" ? `web-${crypto.randomUUID()}` : delivery.attemptId;
    try {
      const sent = delivery.state === "retrying"
        ? await record(effect.runId).delivery.retry(target, delivery.text, delivery.id, attemptId)
        : await record(effect.runId).delivery.submit(target, delivery.text, delivery.method === "steer", attemptId);
      runs.dispatch({ type: "DELIVERY_ACK", runId: effect.runId, intentId: effect.intentId, operationId: effect.operationId, attemptId, queued: sent.used === "steer" });
      finish(effect.operationId);
    } catch (error) {
      if (delivery.state !== "retrying") runs.dispatch({ type: "DELIVERY_ACK", runId: effect.runId, intentId: effect.intentId, operationId: effect.operationId, attemptId, failed: true });
      finish(effect.operationId, error);
    }
  };
  return { execute(effects: readonly WorkspaceEffect[]) { for (const effect of effects) void executeOne(effect); } };
}

/** Coordinates UI bindings and reducer commands; all zeta calls are in the effect executor above. */
export function createDeliveryManager(client: () => ZetaClient | null, runs: DeliveryRunStore) {
  const records = new Map<string, DeliveryRecord>();
  const pending = new Map<string, { resolve(value?: unknown): void; reject(error: unknown): void }>();
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
  const executor = createDeliveryEffectExecutor(client, runs, record, finish);
  runs.setEffectExecutor(executor.execute);
  return {
    bind(runId: string, store: DeliveryStore | undefined) { record(runId).store = store; runs.reconcileDeliveries(runId); },
    reconcile(runId: string) { runs.reconcileDeliveries(runId); },
    observeActive(runId: string | null, connected: boolean) { const previous = activeRun; activeRun = runId; if (!runId && previous && connected) runs.reconcileDeliveries(previous); },
    promote(from: string, to: string) { const item = records.get(from); if (!item || from === to) return; records.delete(from); records.set(to, item); },
    submit(runId: string, text: string, steer: boolean, deliveryId = `web-${crypto.randomUUID()}`) {
      const operationId = crypto.randomUUID() as OperationId;
      const result = new Promise((resolve, reject) => pending.set(operationId, { resolve, reject }));
      runs.beginDelivery(runId, { id: deliveryId, attemptId: deliveryId, method: steer ? "steer" : "send", text, images: [] }, operationId);
      return result;
    },
    stop(runId: string) { const operationId = crypto.randomUUID() as OperationId; const result = new Promise((resolve, reject) => pending.set(operationId, { resolve, reject })); runs.stop(runId, operationId); return result; },
    resend(runId: string, intentId: string) { runs.dispatch({ type: "DELIVERY_RESEND", runId: runId as RunId, intentId }); },
    dispose() { records.clear(); pending.clear(); runs.setEffectExecutor(() => {}); },
  };
}
export type DeliveryManager = ReturnType<typeof createDeliveryManager>;

/** Stops the running turn and everything it started (zeta's default session-scope abort). */
export const stopTurn = (client: ZetaClient) => client.request("abort", {}, { timeoutMs: 15_000 });
