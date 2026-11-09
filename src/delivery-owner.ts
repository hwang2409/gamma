import type { QueuedImage } from "./image-queue";
import type { DeliveryMethod, DraftRunId, OperationId, RunId, RunRecord, SessionId, WorkspaceEffect, WorkspaceState } from "./run-state";

/**
 * The owner of every message the user sent: its delivery id, its state, and the one rule for whether and with which id
 * gamma sends it to zeta. Gamma sends only for the user's Enter, a resend click, or one automatic resend of a steer that
 * zeta dropped at a natural turn end in the same view. Nothing else sends.
 */

/**
 * requesting: an attempt is on its way to zeta. queued: zeta took the id and its outcome is still open (a steer waits for
 * the turn). dropped: not delivered; the transcript row offers a resend.
 */
export type PendingDelivery = {
  /** The message's identity for its whole life (the transcript row's intent). */
  id: string;
  /** The delivery id of the current attempt. It is saved before the attempt goes out, and every retry reads it. */
  attemptId: string;
  operationId: OperationId;
  method: DeliveryMethod;
  text: string;
  images: readonly QueuedImage[];
  state: "requesting" | "queued" | "dropped";
  /** Sent by this page life for the run it shows. Never saved (a reload loses it); a bfcache restore (PAGE_RESTORED) and leaving the run clear it. */
  here?: true;
  /** zeta settled `attemptId` as dropped, so a resend needs a new id. Without it a resend reuses the id and zeta dedupes. */
  spent?: true;
  /** How this attempt was resent from `dropped`; an automatic resend runs at most once per message. */
  resent?: "auto" | "click";
  /** Why a dropped message was not delivered, for its row. */
  why?: "stop" | "dropped" | "unconfirmed";
};
/** The delivery id of a draft whose send is not confirmed: Enter on the same text reuses it, so zeta dedupes it. */
export type RetryDraft = { id: string; key: string; operationId?: OperationId };

export type SendRequest =
  /** Enter on the composer's text: which id the new delivery takes. */
  | { kind: "enter"; text: string; images: readonly QueuedImage[] }
  /** The moment an attempt goes to zeta. */
  | { kind: "attempt"; intentId: string }
  /** The user's resend click on a dropped row. */
  | { kind: "resend"; intentId: string }
  /** zeta dropped a queued steer; `reason` is the drop reason zeta gave for this delivery, if this view saw it. */
  | { kind: "auto"; intentId: string; reason?: string };
/** `blocked` says why nothing is sent now; `id` is the delivery id the send uses. */
export type SendDecision = { id: string; blocked?: string };

export const OTHER_SESSION = "this run is not open yet; your message is still in the draft";
const MANUAL = "only the user can send this again";
const newId = () => `web-${crypto.randomUUID()}`;
const newOperation = () => crypto.randomUUID() as OperationId;
export const deliveryKey = (text: string, images: readonly QueuedImage[]) => JSON.stringify([text, images.map((image) => image.url)]);
const canonical = (state: WorkspaceState, id: RunId): RunId => state.aliases.get(id as DraftRunId) ?? id;

/** The one decision: whether a send for this run goes now, and with which delivery id. */
export function decideSend(state: WorkspaceState, runId: RunId, request: SendRequest): SendDecision {
  const run = canonical(state, runId);
  const record = state.runs.get(run);
  if (request.kind === "enter") {
    const retry = record?.retryDelivery;
    return { id: retry && retry.key === deliveryKey(request.text, request.images) ? retry.id : newId() };
  }
  const delivery = record?.deliveries.get(request.intentId);
  if (!delivery) return { id: "", blocked: MANUAL };
  // zeta's `send` has no session_id yet, so it lands in whatever run zeta has attached: that must be this draft's run.
  if (!state.connected || state.attachment.kind !== "attached" || state.attachment.sessionId !== run) return { id: delivery.attemptId, blocked: OTHER_SESSION };
  if (request.kind === "attempt") return { id: delivery.attemptId };
  if (delivery.method === "opaque") return { id: delivery.attemptId, blocked: MANUAL };
  if (request.kind === "resend") return delivery.state === "dropped" ? { id: delivery.spent ? newId() : delivery.attemptId } : { id: delivery.attemptId, blocked: MANUAL };
  return delivery.method === "steer" && delivery.here && !delivery.resent && request.reason === "turn_end" ? { id: newId() } : { id: delivery.attemptId, blocked: MANUAL };
}

/** This page life no longer counts as the view that sent these deliveries, so none of them is resent automatically. */
export const leaveView = (record: RunRecord): RunRecord => ({ ...record, deliveries: new Map([...record.deliveries].map(([id, delivery]) => [id, { ...delivery, here: undefined }])) });

/** Whether this page shows `runId` live: it is the selected run, zeta has it attached, and its own open completed. */
export const showsLive = (state: WorkspaceState, runId: RunId) => {
  const run = canonical(state, runId);
  const record = state.runs.get(run);
  const reopening = Boolean(record?.openOperation) && record?.openOperation !== record?.openedBy;
  return canonical(state, state.entry.run) === run && state.attachment.kind === "attached" && state.attachment.sessionId === run && Boolean(record?.open) && !record?.open?.stale && !reopening;
};

/** Takes a message zeta accepted out of the draft it was sent from. */
const consumeDelivered = (record: RunRecord, delivery: PendingDelivery): RunRecord => ({ ...record, text: record.text.startsWith(delivery.text) ? record.text.slice(delivery.text.length) : record.text, attachments: record.attachments.filter((image) => !delivery.images.includes(image)) });
export const restoreText = (current: string, restored: string) => current.startsWith(restored) ? current : current ? `${restored}${current.startsWith("\n") ? "" : "\n"}${current}` : restored;

export type DeliveryEvent =
  | { type: "DELIVERY_BEGIN"; runId: RunId; delivery: PendingDelivery; operationId: OperationId }
  | { type: "DELIVERY_ACK"; runId: RunId; intentId: string; operationId: OperationId; attemptId: string; queued?: boolean; failed?: boolean; /** zeta did no work for this id, so a retry needs a new one. */ refused?: boolean; /** Nothing left gamma: the draft's retry id stays as it was. */ blocked?: boolean }
  /**
   * zeta's `delivery_status` answer for a delivery or for the draft's retry id. The reply has no drop reason
   * (zeta delivery.py:348-368); `reason` is the one zeta's live delivery_status event gave for this delivery, if this view saw it.
   */
  | { type: "DELIVERY_STATUS"; runId: RunId; intentId: string; operationId: OperationId; status: "delivered" | "dropped" | "unknown"; reason?: string }
  | { type: "DELIVERY_SETTLE"; runId: RunId; intentId: string; accepted: boolean }
  | { type: "DELIVERY_RESEND"; runId: RunId; intentId: string };

/** Asks zeta what became of each open delivery (and the draft's unconfirmed retry id), only from the page that shows the run live. */
export function queryDeliveries(state: WorkspaceState, record: RunRecord, effects: WorkspaceEffect[], withRetry = false): RunRecord {
  if (!showsLive(state, record.id)) return record;
  const runId = record.id as SessionId;
  let deliveries: Map<string, PendingDelivery> | undefined;
  for (const [intentId, delivery] of record.deliveries) {
    if (delivery.method === "send_images" || delivery.state === "requesting" || (delivery.state === "dropped" && (delivery.spent || delivery.why === "stop"))) continue;
    const operationId = newOperation();
    (deliveries ??= new Map(record.deliveries)).set(intentId, { ...delivery, operationId });
    effects.push({ type: "delivery-status", runId, operationId, intentId });
  }
  let retryDelivery = record.retryDelivery;
  if (withRetry && retryDelivery) { retryDelivery = { ...retryDelivery, operationId: newOperation() }; effects.push({ type: "delivery-status", runId, operationId: retryDelivery.operationId!, intentId: retryDelivery.id }); }
  return deliveries || retryDelivery !== record.retryDelivery ? { ...record, ...(deliveries ? { deliveries } : {}), retryDelivery } : record;
}

const deliverEffect = (record: RunRecord, operationId: OperationId, intentId: string, method: DeliveryMethod): WorkspaceEffect =>
  method === "send_images" ? { type: "send-images", runId: record.id as SessionId, operationId, intentId } : { type: "deliver", runId: record.id, operationId, intentId };

/** What a zeta answer about the draft's retry id means: delivered clears the unchanged draft; dropped spends the id. */
const retryStatus = (record: RunRecord, event: Extract<DeliveryEvent, { type: "DELIVERY_STATUS" }>): RunRecord => {
  const retry = record.retryDelivery;
  if (retry?.id !== event.intentId || retry.operationId !== event.operationId || event.status === "unknown") return record;
  const unchanged = retry.key === deliveryKey(record.text, record.attachments);
  return { ...record, text: event.status === "delivered" && unchanged ? "" : record.text, retryDelivery: undefined };
};

const statusOf = (state: WorkspaceState, record: RunRecord, event: Extract<DeliveryEvent, { type: "DELIVERY_STATUS" }>, effects: WorkspaceEffect[]): RunRecord => {
  // An answer is about the session zeta had attached when it answered; once this page left the run, a later open asks again.
  if (!showsLive(state, record.id)) return record;
  const delivery = record.deliveries.get(event.intentId);
  if (!delivery) return retryStatus(record, event);
  if (delivery.operationId !== event.operationId) return record;
  const deliveries = new Map(record.deliveries);
  const set = (next: Partial<PendingDelivery>) => { deliveries.set(event.intentId, { ...delivery, ...next }); return { ...record, deliveries }; };
  if (event.status === "delivered") { deliveries.delete(event.intentId); return { ...consumeDelivered(record, delivery), deliveries, retryDelivery: undefined }; }
  if (delivery.method === "opaque") { deliveries.delete(event.intentId); return { ...record, text: restoreText(record.text, delivery.text), deliveries }; }
  if (event.status === "dropped") {
    const auto = decideSend(state, record.id, { kind: "auto", intentId: event.intentId, reason: event.reason });
    if (!auto.blocked) {
      const operationId = newOperation();
      effects.push({ type: "deliver", runId: record.id, operationId, intentId: event.intentId });
      return set({ attemptId: auto.id, operationId, method: "send", state: "requesting", resent: "auto", spent: undefined, why: undefined });
    }
    if (delivery.method === "steer" || delivery.resent) return set({ state: "dropped", spent: true, why: "dropped" });
    deliveries.delete(event.intentId);
    return { ...record, text: restoreText(record.text, delivery.text), deliveries, retryDelivery: undefined };
  }
  // unknown: zeta never took this id. Only the user sends it again: a resent message keeps its row; any other goes back to the draft with its id.
  if (delivery.resent) return set({ state: "dropped", why: "unconfirmed" });
  deliveries.delete(event.intentId);
  return { ...record, text: restoreText(record.text, delivery.text), deliveries, retryDelivery: { id: delivery.attemptId, key: deliveryKey(delivery.text, delivery.images) } };
};

/** The delivery cases of the workspace reducer. `state` is the workspace as this event sees it. */
export function reduceDelivery(state: WorkspaceState, record: RunRecord, event: DeliveryEvent, effects: WorkspaceEffect[]): RunRecord {
  const deliveries = new Map(record.deliveries);
  const delivery = event.type === "DELIVERY_BEGIN" ? undefined : deliveries.get(event.intentId);
  switch (event.type) {
    case "DELIVERY_BEGIN":
      deliveries.set(event.delivery.id, { ...event.delivery, here: true });
      effects.push(deliverEffect(record, event.operationId, event.delivery.id, event.delivery.method));
      return { ...record, deliveries, submitting: false, lastDeliveryMethod: event.delivery.method, deliveryNote: undefined };
    case "DELIVERY_SETTLE":
      deliveries.delete(event.intentId);
      return delivery && event.accepted ? { ...consumeDelivered(record, delivery), deliveries } : { ...record, deliveries };
    case "DELIVERY_ACK": {
      if (delivery?.operationId !== event.operationId) return record;
      // A blocked attempt never reached zeta: the row or the draft goes back as it was, and an inherited retry id stays.
      if (event.blocked) {
        if (delivery.resent) deliveries.set(event.intentId, { ...delivery, state: "dropped", why: delivery.why ?? "dropped" }); else deliveries.delete(event.intentId);
        return { ...record, deliveries };
      }
      if (!event.failed) {
        if (event.queued) deliveries.set(event.intentId, { ...delivery, attemptId: event.attemptId, state: "queued", spent: undefined, why: undefined }); else deliveries.delete(event.intentId);
        return { ...consumeDelivered(record, delivery), deliveries, retryDelivery: undefined };
      }
      // A resent message lives as its row, not in the draft: it goes back to dropped, and its resend reuses the id unless zeta refused it.
      if (delivery.resent) { deliveries.set(event.intentId, { ...delivery, state: "dropped", spent: event.refused ? true : undefined, why: event.refused ? "dropped" : "unconfirmed" }); return { ...record, deliveries }; }
      // A failure keeps the draft and its attempt id (zeta answers duplicate:true if the first one landed); only a refusal needs a new id.
      deliveries.delete(event.intentId);
      return { ...record, deliveries, retryDelivery: event.refused || !event.attemptId ? undefined : { id: event.attemptId, key: deliveryKey(delivery.text, delivery.images) } };
    }
    case "DELIVERY_STATUS": return statusOf(state, record, event, effects);
    case "DELIVERY_RESEND": {
      if (delivery?.state !== "dropped") return record;
      const decision = decideSend(state, record.id, { kind: "resend", intentId: event.intentId });
      if (decision.blocked) return { ...record, deliveryNote: `resend waits: ${decision.blocked === OTHER_SESSION ? "zeta has another run attached; nothing was sent" : decision.blocked}` };
      const operationId = newOperation();
      deliveries.set(event.intentId, { ...delivery, attemptId: decision.id, operationId, method: "send", state: "requesting", resent: "click", spent: undefined, why: undefined });
      effects.push({ type: "deliver", runId: record.id, operationId, intentId: event.intentId });
      return { ...record, deliveries, deliveryNote: undefined };
    }
  }
}

/** The note the composer shows for the draft's delivery: a blocked resend, or a draft whose last send is not confirmed. */
export const deliveryNote = (record: RunRecord) => {
  if (record.deliveryNote) return record.deliveryNote;
  const retry = record.retryDelivery;
  if (!retry || !record.text) return null;
  return retry.key === deliveryKey(record.text, record.attachments)
    ? "this may already be sent · the draft is kept, and Enter will not run it twice"
    : "edited · Enter sends this as a new message";
};

/** One run's entry in the tab's sessionStorage: its draft text, its unconfirmed retry id, and its open deliveries. */
export type SavedRun = { text?: string; retry?: RetryDraft; deliveries?: Array<Omit<PendingDelivery, "images">> };
export const savedRun = (record: RunRecord): SavedRun | null => {
  const deliveries = [...record.deliveries.values()].filter((delivery) => delivery.method !== "send_images").map(({ images: _, here: __, ...delivery }) => delivery);
  const retry = record.retryDelivery ? { id: record.retryDelivery.id, key: record.retryDelivery.key } : undefined;
  return record.text || retry || deliveries.length ? { ...(record.text ? { text: record.text } : {}), ...(retry ? { retry } : {}), ...(deliveries.length ? { deliveries } : {}) } : null;
};
/** Puts a saved entry into a run this page has not held yet. What the page already holds wins. */
export const restoreSaved = (record: RunRecord, saved: SavedRun | undefined): RunRecord => {
  if (!saved || typeof saved !== "object") return record;
  const restored = new Map((saved.deliveries ?? []).flatMap((delivery) => delivery?.id && delivery.text && delivery.operationId && delivery.attemptId
    ? [[delivery.id, { ...delivery, images: [], state: delivery.state === "requesting" ? "queued" : delivery.state } as PendingDelivery]] : []));
  return {
    ...record,
    text: record.text || saved.text || "",
    deliveries: record.deliveries.size || !restored.size ? record.deliveries : restored,
    retryDelivery: record.retryDelivery ?? (saved.retry?.id && saved.retry.key ? { id: saved.retry.id, key: saved.retry.key } : undefined),
  };
};
