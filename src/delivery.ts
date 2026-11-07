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

/**
 * Sends the composer's draft to zeta: `send` starts a turn, `steer` adds to the running one. With the negotiated
 * `delivery_id` feature every attempt carries an id, and a retry of the same text reuses it, so a retry after a timeout
 * or a dropped socket can never deliver the message twice (docs/serve-protocol.md, "client delivery IDs"). The id is
 * dropped once the server has accepted or definitely dropped the message, so the next message gets a fresh one. When
 * the turn starts or ends between the click and the server, the other method runs once with the same id.
 *
 * Zeta delivers a steer at the next provider boundary of the running turn. A turn that ends first (a final answer with
 * no tool call) drops it, and the protocol leaves the resend to the client. `turnEnded` does that, as the zeta TUI does:
 * each dropped steer goes out again as a new message, in order, with a new delivery id. After a stop the user meant to
 * drop them, so they stay dropped, and `turnEnded` names them so the view can show they never reached the agent.
 *
 * Each message keeps one `intent` across every attempt, and the client stamps it on zeta's `user_message` echo, so the
 * steer's row becomes the resent message's row: the user sees one row per message they wrote.
 */
export function createDelivery(newId: () => string = () => `web-${crypto.randomUUID()}`, reconcile?: (event: RunEvent) => void) {
  let unsettled: Message | null = null;
  let steers: Message[] = [];
  // The user's stop of the running turn: resolves to whether it ended the turn (it failed, or found no turn: false).
  let stopping: Promise<boolean> | null = null;
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
  /** Delivers one attempt; a steer that zeta queued is remembered, since the turn may still drop it. */
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
    if (used === "steer" && message.id && result.accepted !== false) steers.push(message);
    return { result, used };
  };
  const reconcileAccepted = (message: Message, used: Method, result: Accepted) => {
    if (result.accepted === true && message.id && reconcile)
      reconcile({ type: "user_message", text: message.text, mode: used, intent: message.intent, delivery_id: message.id });
  };
  const fresh = (client: ZetaClient, text: string, deliveryId = newId()): Message =>
    ({ text, intent: deliveryId, id: client.features.includes("delivery_id") ? deliveryId : null });
  const dropped = async (client: ZetaClient, id: string) => {
    const { status, outcome } = (await client.request("delivery_status", { delivery_id: id }, { timeoutMs: 15_000 })) as { status?: string; outcome?: string };
    return status === "dropped" || (status === "evicted" && outcome === "dropped");
  };
  return {
    async submit(client: ZetaClient, text: string, steer: boolean, deliveryId?: string) {
      const message = unsettled?.text === text ? unsettled : fresh(client, text, deliveryId);
      unsettled = message;
      const delivered = await deliver(client, steer ? "steer" : "send", message);
      unsettled = null;
      if (delivered.result.accepted === false) throw refusal(delivered.result);
      reconcileAccepted(message, delivered.used, delivered.result);
    },
    /** Stops the running turn (zeta's default session-scope abort); `turnEnded` then knows the user ended it. */
    stop(client: ZetaClient) {
      const request = stopTurn(client);
      stopping = request.then((result) => (result as { aborted?: boolean } | null)?.aborted !== false, () => false);
      return request;
    },
    /**
     * Call when the running turn ends. Resends the steers it dropped, unless the user's stop ended it: then they stay
     * dropped, and their intents are returned so the view can mark those rows as not delivered. A stop that failed or
     * found no turn is not a stop: the turn ended on its own, so its dropped steers are resent.
     */
    async turnEnded(client: ZetaClient) {
      const ended = steers;
      steers = [];
      const stopped = await (stopping ?? false);
      stopping = null;
      const undelivered: string[] = [];
      // A query that fails (a dropped socket) leaves its steer unmarked, the safe side; the others still count.
      const statuses = await Promise.allSettled(ended.map((message) => dropped(client, message.id!)));
      for (const [index, message] of ended.entries()) {
        const status = statuses[index]!;
        if (status.status === "rejected" || !status.value) continue;
        if (stopped) { undelivered.push(message.intent); continue; }
        const retry = { ...message, id: newId() };
        const delivered = await deliver(client, "send", retry);
        if (delivered.result.accepted === false) throw refusal(delivered.result);
        reconcileAccepted(retry, delivered.used, delivered.result);
      }
      return undelivered;
    },
  };
}

type DeliveryStore = {
  hasMessageDelivery(id: string): boolean;
  dispatch(event: RunEvent): void;
  getState(): { outline: readonly { id: string }[] };
  getItem(id: string): unknown;
  subscribe(listener: () => void): () => void;
};
type DeliveryRecord = {
  delivery: ReturnType<typeof createDelivery>;
  store?: DeliveryStore;
  unsubscribe?: () => void;
  provisional: Map<string, unknown>;
  text: Map<string, string>;
  waiting: Set<string>;
  undelivered: Set<string>;
};

/** Owns delivery reconciliation by run, so navigation cannot unmount an accepted steer's state. */
export function createDeliveryManager(client: () => ZetaClient | null) {
  const records = new Map<string, DeliveryRecord>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const find = (store: DeliveryStore, id: string) => store.getState().outline.map(({ id: itemId }) => store.getItem(itemId) as { type?: string; event?: { type?: string; delivery_id?: string } } | undefined).find((item) => item?.type === "user" && item.event?.type === "user_message" && item.event.delivery_id === id);
  const record = (runId: string): DeliveryRecord => {
    const prior = records.get(runId); if (prior) return prior;
    const next = {} as DeliveryRecord;
    next.provisional = new Map(); next.text = new Map(); next.waiting = new Set(); next.undelivered = new Set();
    next.delivery = createDelivery(undefined, (event) => {
      const id = event.type === "user_message" ? event.delivery_id : undefined;
      if (!id || !next.store) return;
      if (next.store.hasMessageDelivery(id)) { next.waiting.delete(id); emit(); return; }
      next.store.dispatch(event); next.provisional.set(id, find(next.store, id)); next.waiting.add(id); emit();
    });
    records.set(runId, next); return next;
  };
  const reconcileRows = (item: DeliveryRecord) => {
    if (!item.store) return;
    for (const [id, fallback] of item.provisional) if (find(item.store, id) !== fallback) { item.provisional.delete(id); item.waiting.delete(id); emit(); }
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    marks(runId: string) { const item = record(runId); return { waiting: item.waiting as ReadonlySet<string>, undelivered: item.undelivered as ReadonlySet<string> }; },
    bind(runId: string, store: DeliveryStore | undefined) { const item = record(runId); if (item.store === store) return; item.unsubscribe?.(); item.store = store; item.unsubscribe = store?.subscribe(() => reconcileRows(item)); reconcileRows(item); },
    async submit(runId: string, text: string, steer: boolean, deliveryId?: string) { const target = client(); if (!target) throw new Error("not connected to zeta serve"); const item = record(runId); if (deliveryId) item.text.set(deliveryId, text); return item.delivery.submit(target, text, steer, deliveryId); },
    stop(runId: string) { const target = client(); return target ? record(runId).delivery.stop(target) : Promise.reject(new Error("not connected to zeta serve")); },
    async turnEnded(runId: string) { const target = client(); if (!target) return; const item = record(runId); for (const id of item.provisional.keys()) item.waiting.delete(id); item.provisional.clear(); const dropped = await item.delivery.turnEnded(target); dropped.forEach((id) => item.undelivered.add(id)); emit(); },
    async resend(runId: string, intentId: string) { const item = record(runId); const text = item.text.get(intentId); if (!text) return; item.undelivered.delete(intentId); emit(); await this.submit(runId, text, false); },
    dispose() { records.forEach((item) => item.unsubscribe?.()); records.clear(); listeners.clear(); },
  };
}
export type DeliveryManager = ReturnType<typeof createDeliveryManager>;

/** Stops the running turn and everything it started (zeta's default session-scope abort). */
export const stopTurn = (client: ZetaClient) => client.request("abort", {}, { timeoutMs: 15_000 });
