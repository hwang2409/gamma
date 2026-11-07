import type { QueuedImage } from "./image-queue";

export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type DraftRunId = Brand<`draft:${string}`, "DraftRunId">;
export type SessionId = Brand<string, "SessionId">;
export type RunId = DraftRunId | SessionId;
export type EntryId = Brand<string, "EntryId">;
export type IntentId = Brand<string, "IntentId">;
export type OperationId = Brand<string, "OperationId">;
export type DeliveryMethod = "send" | "steer" | "send_images";
export type PendingDelivery = { id: string; attemptId: string; operationId: OperationId; method: DeliveryMethod; text: string; images: readonly QueuedImage[]; state: "requesting" | "queued" | "retrying" | "dropped" };
export type RunModel =
  | { choice: "default"; resolvedDefault?: string }
  | { choice: "explicit"; model: string; resolvedDefault?: string };
export type RunSettingsState =
  | { kind: "unknown"; desired?: { model?: string; approval_mode?: "ask" | "allow" } }
  | { kind: "loading"; operationId: OperationId; desired?: { model?: string; approval_mode?: "ask" | "allow" } }
  | { kind: "ready"; model?: string; approval_mode?: "ask" | "allow"; desired?: { model?: string; approval_mode?: "ask" | "allow" } }
  | { kind: "failed"; error: string };
export type RunLifecycle =
  | { kind: "draft" }
  | { kind: "creating"; operationId: OperationId }
  | { kind: "opening"; operationId?: OperationId; waitingForIdle?: SessionId }
  | { kind: "open"; lease?: unknown; title?: string; transcript?: string }
  | { kind: "failed"; error: string }
  | { kind: "closed" };
export type RunRecord = {
  readonly id: RunId;
  readonly lifecycle: RunLifecycle;
  readonly text: string;
  readonly attachments: readonly QueuedImage[];
  readonly deliveries: ReadonlyMap<string, PendingDelivery>;
  readonly stopOperation?: OperationId;
  readonly model: RunModel;
  readonly settings: RunSettingsState;
};
export type AttachmentState =
  | { kind: "detached" }
  | { kind: "attached"; sessionId: SessionId; turn: "idle" | "running" | "tool" | "approval" }
  | { kind: "disconnected"; lastAttached?: SessionId; lastTurnOwner?: SessionId };
export type BrowserEntry = { readonly id: EntryId; readonly run: RunId };
export type WorkspaceState = {
  readonly entry: BrowserEntry;
  readonly runs: ReadonlyMap<RunId, RunRecord>;
  readonly aliases: ReadonlyMap<DraftRunId, SessionId>;
  readonly attachment: AttachmentState;
  readonly notice?: { runId: SessionId };
};
export type WorkspaceEffect =
  | { type: "history-push" | "history-replace-current"; entryId: EntryId; runId: RunId }
  | { type: "status" }
  | { type: "resume" | "open-history" | "load-settings" | "abort"; runId: SessionId; operationId: OperationId }
  | { type: "delivery-status"; runId: SessionId; operationId: OperationId; intentId: string }
  | { type: "new-session" | "set-settings"; runId: RunId; operationId: OperationId }
  | { type: "deliver"; runId: RunId; operationId: OperationId; intentId: string }
  | { type: "persist-draft"; runId: RunId; text: string }
  | { type: "release-lease"; runId: SessionId };
export type WorkspaceEvent =
  | { type: "ENSURE_RUN"; runId: RunId; model?: RunModel; text?: string }
  | { type: "COMPOSER_EDIT"; runId: RunId; text?: string; attachments?: readonly QueuedImage[] }
  | { type: "REMOVE_ATTACHMENT"; runId: RunId; index: number }
  | { type: "DELIVERY_SETTLE"; runId: RunId; intentId: string; accepted: boolean }
  | { type: "PROMOTE"; runId: DraftRunId; sessionId: SessionId }
  | { type: "MODEL_SET"; runId: RunId; model: RunModel }
  | { type: "APPROVAL_MODE_SET"; runId: RunId; approval_mode: "ask" | "allow" }
  | { type: "DISMISS_NOTICE" }
  | { type: "NEW_RUN"; entryId: EntryId; runId: DraftRunId }
  | { type: "NAVIGATED"; entryId: EntryId; runId: RunId }
  | { type: "FIRST_SEND"; runId: DraftRunId; operationId: OperationId }
  | { type: "NEW_SESSION_OK"; runId: DraftRunId; sessionId: SessionId; operationId: OperationId }
  | { type: "NEW_SESSION_FAIL"; runId: DraftRunId; operationId: OperationId; error: string }
  | { type: "STATUS"; sessionId?: SessionId; turn: "idle" | "running" | "tool" | "approval" }
  | { type: "RESUME_OK"; runId: SessionId; operationId: OperationId }
  | { type: "RESUME_BUSY"; runId: SessionId; owner: SessionId; operationId: OperationId }
  | { type: "RESUME_FAIL"; runId: SessionId; operationId: OperationId; error: string }
  | { type: "FIRST_PAGE"; runId: SessionId; operationId?: OperationId; lease?: unknown; title?: string; transcript?: string }
  | { type: "TURN_START"; runId: SessionId; turn?: "running" | "tool" | "approval" }
  | { type: "TURN_END"; runId: SessionId }
  | { type: "DELIVERY_BEGIN"; runId: RunId; delivery: PendingDelivery; operationId: OperationId }
  | { type: "DELIVERY_ACK"; runId: RunId; intentId: string; operationId: OperationId; attemptId: string; queued?: boolean; failed?: boolean }
  | { type: "DELIVERY_STATUS"; runId: RunId; intentId: string; operationId: OperationId; status: "delivered" | "dropped" }
  | { type: "DELIVERY_RECONCILE"; runId: RunId }
  | { type: "DELIVERY_RESEND"; runId: RunId; intentId: string }
  | { type: "SETTINGS_DESIRED"; runId: RunId; model?: string; approval_mode?: "ask" | "allow" }
  | { type: "STOP"; runId: SessionId; operationId?: OperationId }
  | { type: "STOP_OK" | "STOP_FAIL"; runId: SessionId; operationId: OperationId }
  | { type: "DISCONNECT" }
  | { type: "RECONNECT" }
  | { type: "SETTINGS_OK"; runId: SessionId; operationId: OperationId; model?: string; approval_mode?: "ask" | "allow" }
  | { type: "SETTINGS_FAIL"; runId: SessionId; operationId: OperationId; error: string };

const canonical = (state: WorkspaceState, id: RunId): RunId => state.aliases.get(id as DraftRunId) ?? id;
const blank = (id: RunId): RunRecord => ({ id, lifecycle: id.startsWith("draft:") ? { kind: "draft" } : { kind: "opening" }, text: "", attachments: [], deliveries: new Map(), model: { choice: "default" }, settings: { kind: "unknown" } });
const operationMatches = (record: RunRecord | undefined, operationId: OperationId) => record?.lifecycle.kind === "creating" ? record.lifecycle.operationId === operationId : record?.lifecycle.kind === "opening" ? !record.lifecycle.operationId || record.lifecycle.operationId === operationId : false;

/** Pure owner of run identity, lifecycle, attachment, settings, delivery, and browser-entry policy. */
export function reduceWorkspace(state: WorkspaceState, event: WorkspaceEvent): { state: WorkspaceState; effects: WorkspaceEffect[] } {
  let runs = new Map(state.runs);
  let aliases = new Map(state.aliases);
  let entry = state.entry;
  let attachment = state.attachment;
  let notice = state.notice;
  const effects: WorkspaceEffect[] = [];
  const update = (id: RunId, change: (record: RunRecord) => RunRecord) => {
    const target = canonical({ ...state, aliases }, id);
    runs.set(target, change(runs.get(target) ?? blank(target)));
  };
  switch (event.type) {
    case "ENSURE_RUN": if (!runs.has(canonical({ ...state, aliases }, event.runId))) runs.set(event.runId, { ...blank(event.runId), ...(event.model ? { model: event.model } : {}), ...(event.text ? { text: event.text } : {}) }); break;
    case "COMPOSER_EDIT": update(event.runId, (record) => ({ ...record, text: event.text ?? record.text, attachments: event.attachments ?? record.attachments })); break;
    case "REMOVE_ATTACHMENT": update(event.runId, (record) => ({ ...record, attachments: record.attachments.filter((_, index) => index !== event.index) })); break;
    case "DELIVERY_SETTLE": update(event.runId, (record) => { const deliveries = new Map(record.deliveries); const delivery = deliveries.get(event.intentId); deliveries.delete(event.intentId); if (!delivery || !event.accepted) return { ...record, deliveries }; return { ...record, text: record.text.startsWith(delivery.text) ? record.text.slice(delivery.text.length) : record.text, attachments: record.attachments.filter((image) => !delivery.images.includes(image)), deliveries }; }); break;
    case "PROMOTE": { const source = runs.get(event.runId) ?? blank(event.runId); const target = runs.get(event.sessionId); runs.delete(event.runId); runs.set(event.sessionId, target && (target.text || target.attachments.length || target.deliveries.size) ? target : { ...source, id: event.sessionId, lifecycle: { kind: "opening" } }); aliases.set(event.runId, event.sessionId); if (entry.run === event.runId) entry = { ...entry, run: event.sessionId }; else notice = { runId: event.sessionId }; break; }
    case "MODEL_SET": update(event.runId, (record) => ({ ...record, model: event.model })); break;
    case "APPROVAL_MODE_SET": update(event.runId, (record) => ({ ...record, settings: record.settings.kind === "ready" ? { ...record.settings, approval_mode: event.approval_mode } : { kind: "ready", approval_mode: event.approval_mode } })); break;
    case "DISMISS_NOTICE": notice = undefined; break;
    case "NEW_RUN":
      runs.set(event.runId, blank(event.runId)); entry = { id: event.entryId, run: event.runId };
      effects.push({ type: "history-push", entryId: event.entryId, runId: event.runId }); break;
    case "NAVIGATED": {
      const target = canonical({ ...state, aliases }, event.runId);
      entry = { id: event.entryId, run: target }; if (!runs.has(target)) runs.set(target, blank(target));
      if (target !== event.runId) effects.push({ type: "history-replace-current", entryId: event.entryId, runId: target });
      break;
    }
    case "FIRST_SEND":
      update(event.runId, (record) => record.lifecycle.kind === "draft" ? { ...record, lifecycle: { kind: "creating", operationId: event.operationId } } : record);
      if (attachment.kind !== "attached" || attachment.turn === "idle") effects.push({ type: "new-session", runId: event.runId, operationId: event.operationId }); break;
    case "NEW_SESSION_OK": {
      const source = runs.get(event.runId); if (!operationMatches(source, event.operationId)) break;
      const promoted = { ...source!, id: event.sessionId, lifecycle: { kind: "opening", operationId: event.operationId } as RunLifecycle };
      runs.delete(event.runId); runs.set(event.sessionId, promoted); aliases.set(event.runId, event.sessionId);
      if (entry.id === state.entry.id && entry.run === event.runId) { entry = { ...entry, run: event.sessionId }; effects.push({ type: "history-replace-current", entryId: entry.id, runId: event.sessionId }); }
      break;
    }
    case "NEW_SESSION_FAIL": update(event.runId, (record) => operationMatches(record, event.operationId) ? { ...record, lifecycle: { kind: "failed", error: event.error } } : record); break;
    case "STATUS":
      attachment = event.sessionId ? { kind: "attached", sessionId: event.sessionId, turn: event.turn } : { kind: "detached" };
      if (event.sessionId) for (const intentId of runs.get(event.sessionId)?.deliveries.keys() ?? []) effects.push({ type: "delivery-status", runId: event.sessionId, operationId: crypto.randomUUID() as OperationId, intentId });
      break;
    case "RESUME_OK":
      if (attachment.kind === "attached" && attachment.turn !== "idle" && attachment.sessionId !== event.runId) break;
      attachment = { kind: "attached", sessionId: event.runId, turn: "idle" }; update(event.runId, (record) => ({ ...record, lifecycle: { kind: "opening", operationId: event.operationId }, settings: { kind: "loading", operationId: event.operationId, ...(record.settings.kind === "unknown" && record.settings.desired ? { desired: record.settings.desired } : {}) } })); effects.push({ type: "load-settings", runId: event.runId, operationId: event.operationId });
      for (const intentId of runs.get(event.runId)?.deliveries.keys() ?? []) effects.push({ type: "delivery-status", runId: event.runId, operationId: crypto.randomUUID() as OperationId, intentId }); break;
    case "RESUME_BUSY": update(event.runId, (record) => ({ ...record, lifecycle: { kind: "opening", operationId: event.operationId, waitingForIdle: event.owner } })); break;
    case "RESUME_FAIL": update(event.runId, (record) => operationMatches(record, event.operationId) ? { ...record, lifecycle: { kind: "failed", error: event.error } } : record); break;
    case "FIRST_PAGE": update(event.runId, (record) => !event.operationId || operationMatches(record, event.operationId) ? { ...record, lifecycle: { kind: "open", lease: event.lease, title: event.title, transcript: event.transcript } } : record); break;
    case "TURN_START": if (attachment.kind === "attached" && attachment.sessionId === event.runId) attachment = { ...attachment, turn: event.turn ?? "running" }; break;
    case "TURN_END": if (attachment.kind === "attached" && attachment.sessionId === event.runId) attachment = { ...attachment, turn: "idle" }; break;
    case "DELIVERY_BEGIN": update(event.runId, (record) => { const deliveries = new Map(record.deliveries); deliveries.set(event.delivery.id, event.delivery); if (event.delivery.method !== "send_images") effects.push({ type: "deliver", runId: record.id, operationId: event.operationId, intentId: event.delivery.id }); return { ...record, deliveries }; }); break;
    case "DELIVERY_ACK": update(event.runId, (record) => { const deliveries = new Map(record.deliveries); const delivery = deliveries.get(event.intentId); if (delivery?.operationId !== event.operationId) return record; if (event.queued && !event.failed) deliveries.set(event.intentId, { ...delivery, attemptId: event.attemptId, state: "queued" }); else deliveries.delete(event.intentId); if (event.failed) return { ...record, deliveries }; return { ...record, text: record.text.startsWith(delivery.text) ? record.text.slice(delivery.text.length) : record.text, attachments: record.attachments.filter((image) => !delivery.images.includes(image)), deliveries }; }); break;
    case "DELIVERY_RESEND": update(event.runId, (record) => { const deliveries = new Map(record.deliveries); const delivery = deliveries.get(event.intentId); if (delivery?.state === "dropped") { const operationId = crypto.randomUUID() as OperationId; deliveries.set(event.intentId, { ...delivery, operationId, state: "retrying" }); effects.push({ type: "deliver", runId: record.id, operationId, intentId: event.intentId }); } return { ...record, deliveries }; }); break;
    case "DELIVERY_RECONCILE": update(event.runId, (record) => { const deliveries = new Map(record.deliveries); for (const [intentId, delivery] of deliveries) { if (delivery.state === "dropped" || delivery.state === "requesting") continue; const operationId = crypto.randomUUID() as OperationId; deliveries.set(intentId, { ...delivery, operationId }); effects.push({ type: "delivery-status", runId: record.id as SessionId, operationId, intentId }); } return { ...record, deliveries }; }); break;
    case "DELIVERY_STATUS": update(event.runId, (record) => { const deliveries = new Map(record.deliveries); const delivery = deliveries.get(event.intentId); if (delivery?.operationId !== event.operationId) return record; if (event.status === "delivered") deliveries.delete(event.intentId); else if (delivery.state !== "dropped") { const operationId = crypto.randomUUID() as OperationId; deliveries.set(event.intentId, { ...delivery, operationId, state: "retrying" }); effects.push({ type: "deliver", runId: record.id, operationId, intentId: event.intentId }); } return { ...record, deliveries }; }); break;
    case "SETTINGS_DESIRED": update(event.runId, (record) => ({ ...record, settings: { kind: "unknown", desired: { model: event.model, approval_mode: event.approval_mode } } })); break;
    case "STOP": { const operationId = event.operationId ?? crypto.randomUUID() as OperationId; update(event.runId, (record) => ({ ...record, stopOperation: operationId })); effects.push({ type: "abort", runId: event.runId, operationId }); break; }
    case "STOP_OK": update(event.runId, (record) => record.stopOperation !== event.operationId ? record : ({ ...record, stopOperation: undefined, deliveries: new Map([...record.deliveries].map(([id, delivery]) => [id, delivery.method === "steer" ? { ...delivery, state: "dropped" as const } : delivery])) })); break;
    case "STOP_FAIL": update(event.runId, (record) => record.stopOperation === event.operationId ? { ...record, stopOperation: undefined } : record); break;
    case "DISCONNECT": for (const [id, record] of runs) if ([...record.deliveries.values()].some((delivery) => delivery.state === "requesting")) update(id, (current) => ({ ...current, deliveries: new Map([...current.deliveries].map(([intentId, delivery]) => [intentId, delivery.state === "requesting" ? { ...delivery, state: "queued" as const } : delivery])) })); attachment = { kind: "disconnected", ...(attachment.kind === "attached" ? { lastAttached: attachment.sessionId, ...(attachment.turn !== "idle" ? { lastTurnOwner: attachment.sessionId } : {}) } : {}) }; break;
    case "RECONNECT":
      effects.push({ type: "status" });
      if (attachment.kind === "disconnected" && attachment.lastAttached) for (const intentId of runs.get(attachment.lastAttached)?.deliveries.keys() ?? []) effects.push({ type: "delivery-status", runId: attachment.lastAttached, operationId: crypto.randomUUID() as OperationId, intentId });
      break;
    case "SETTINGS_OK": update(event.runId, (record) => record.settings.kind === "loading" && record.settings.operationId !== event.operationId ? record : { ...record, settings: { kind: "ready", model: (record.settings.kind === "unknown" || record.settings.kind === "loading") ? record.settings.desired?.model ?? event.model : event.model, approval_mode: (record.settings.kind === "unknown" || record.settings.kind === "loading") ? record.settings.desired?.approval_mode ?? event.approval_mode : event.approval_mode } }); break;
    case "SETTINGS_FAIL": update(event.runId, (record) => record.settings.kind === "loading" && record.settings.operationId !== event.operationId ? record : { ...record, settings: { kind: "failed", error: event.error } }); break;
  }
  return { state: { entry, runs, aliases, attachment, ...(notice ? { notice } : {}) }, effects };
}

export const selectedRun = (state: WorkspaceState) => state.runs.get(canonical(state, state.entry.run));

type DefaultModels = Record<string, string>;
type RunStorage = Pick<globalThis.Storage, "getItem" | "setItem">;
const DEFAULTS_KEY = "gamma-run-defaults";
const DRAFTS_KEY = "gamma-run-drafts";
const DELIVERIES_KEY = "gamma-deliveries";
const DEFAULTS_LIMIT = 32;
const parseMap = (storage: RunStorage | undefined, key: string): Record<string, string> => { try { const value = JSON.parse(storage?.getItem(key) ?? "null"); return value && typeof value === "object" ? value : {}; } catch { return {}; } };

/** React facade over the live reducer. It owns no run facts; every change is a WorkspaceEvent. */
export function createRunStateStore(cleanLimit = 8, storage: RunStorage | undefined = globalThis.localStorage, draftStorage: RunStorage | undefined = globalThis.sessionStorage, initialEntry: BrowserEntry = { id: "initial" as EntryId, run: "draft:initial" as DraftRunId }) {
  const seed = initialEntry.run;
  let state: WorkspaceState = { entry: initialEntry, runs: new Map(), aliases: new Map(), attachment: { kind: "detached" } };
  const listeners = new Set<() => void>();
  let active: RunId = seed;
  let defaults = parseMap(storage, DEFAULTS_KEY);
  let drafts = parseMap(draftStorage, DRAFTS_KEY);
  let persistedDeliveries: Record<string, Array<Omit<PendingDelivery, "images">>> = {};
  try { persistedDeliveries = JSON.parse(draftStorage?.getItem(DELIVERIES_KEY) ?? "{}"); } catch {}
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let executeEffects: (effects: readonly WorkspaceEffect[]) => void = () => {};
  const emit = () => listeners.forEach((listener) => listener());
  const persistDeliveries = () => { try { draftStorage?.setItem(DELIVERIES_KEY, JSON.stringify(Object.fromEntries([...state.runs].flatMap(([id, record]) => { const textOnly = [...record.deliveries.values()].filter((delivery) => delivery.method !== "send_images").map(({ images: _, ...delivery }) => delivery); return textOnly.length ? [[id, textOnly]] : []; })))); } catch {} };
  const dispatch = (event: WorkspaceEvent, notify = true) => { const result = reduceWorkspace(state, event); state = result.state; persistDeliveries(); if (event.type === "DELIVERY_ACK" && !event.failed) queueDraft(event.runId, state.runs.get(canonical(state, event.runId))?.text ?? ""); executeEffects(result.effects); if (notify) emit(); };
  const key = (id: string) => canonical(state, id as RunId);
  const restoredDeliveries = (id: string) => new Map((persistedDeliveries[id] ?? []).flatMap((delivery) => delivery?.id && delivery.text && delivery.operationId && delivery.attemptId ? [[delivery.id, { ...delivery, images: [], state: delivery.state === "requesting" ? "queued" : delivery.state } as PendingDelivery]] : []));
  const value = (id: string): RunRecord => { const target = key(id); let current = state.runs.get(target); if (!current) { dispatch({ type: "ENSURE_RUN", runId: target, text: drafts[target] }, false); current = state.runs.get(target)!; const deliveries = restoredDeliveries(target); if (deliveries.size) { const runs = new Map(state.runs); current = { ...current, deliveries }; runs.set(target, current); state = { ...state, runs }; } } return current; };
  const revoke = (images: readonly QueuedImage[]) => images.forEach((image) => URL.revokeObjectURL(image.url));
  const dirty = (record: RunRecord) => Boolean(record.text || record.attachments.length || record.deliveries.size || record.lifecycle.kind === "creating");
  const evict = () => { const runs = new Map(state.runs); let clean = [...runs].filter(([id, record]) => id !== active && !dirty(record)); while (clean.length > cleanLimit) { const [id, record] = clean.shift()!; revoke(record.attachments); runs.delete(id); } state = { ...state, runs }; };
  const persistDrafts = () => { persistTimer = null; try { draftStorage?.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch {} };
  const queueDraft = (id: string, text: string) => { const target = key(id); if (text) drafts[target] = text; else delete drafts[target]; if (persistTimer) clearTimeout(persistTimer); persistTimer = setTimeout(persistDrafts, 120); };
  const persistDefault = (id: string, model: string) => { delete defaults[id]; defaults[id] = model; defaults = Object.fromEntries(Object.entries(defaults).slice(-DEFAULTS_LIMIT)); try { storage?.setItem(DEFAULTS_KEY, JSON.stringify(defaults)); } catch {} };
  const facade = {
    canonical(id: string) { return key(id); },
    get(id: string) { return value(id); },
    getEntry() { return state.entry; },
    getNotice() { return state.notice ?? null; },
    dispatch,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    activate(id: string, initialModel: RunModel = { choice: "default" }) { active = key(id); const existed = state.runs.has(active); value(active); if (!existed) dispatch({ type: "MODEL_SET", runId: active, model: initialModel }); evict(); },
    edit(id: string, patch: { text?: string; attachments?: readonly QueuedImage[] }) { const current = value(id); const text = patch.text ?? current.text; dispatch({ type: "COMPOSER_EDIT", runId: key(id), text, ...(patch.attachments ? { attachments: patch.attachments } : {}) }); if (patch.text !== undefined) queueDraft(id, text); evict(); },
    removeAttachment(id: string, index: number) { const image = value(id).attachments[index]; if (!image) return; URL.revokeObjectURL(image.url); dispatch({ type: "REMOVE_ATTACHMENT", runId: key(id), index }); },
    beginDelivery(id: string, delivery: Omit<PendingDelivery, "operationId" | "state">, operationId = crypto.randomUUID() as OperationId) { dispatch({ type: "DELIVERY_BEGIN", runId: key(id), delivery: { ...delivery, operationId, state: "requesting" }, operationId }); return operationId; },
    reconcileDeliveries(id: string) { dispatch({ type: "DELIVERY_RECONCILE", runId: key(id) }); },
    stop(id: string, operationId?: OperationId) { const runId = key(id); if (!runId.startsWith("draft:")) dispatch({ type: "STOP", runId: runId as SessionId, operationId }); },
    setEffectExecutor(executor: (effects: readonly WorkspaceEffect[]) => void) { executeEffects = executor; },
    settleDelivery(id: string, deliveryId: string, status: "accepted" | "rejected") { const delivery = value(id).deliveries.get(deliveryId); if (!delivery) return; const kept = value(id).attachments.filter((image) => !delivery.images.includes(image)); if (status === "accepted") revoke(delivery.images.filter((image) => !kept.includes(image))); dispatch({ type: "DELIVERY_SETTLE", runId: key(id), intentId: deliveryId, accepted: status === "accepted" }); queueDraft(id, value(id).text); evict(); },
    promote(from: string, to: string) { if (from === to) return; dispatch({ type: "PROMOTE", runId: from as DraftRunId, sessionId: to as SessionId }); if (drafts[from]) { drafts[to] = drafts[from]; delete drafts[from]; queueDraft(to, drafts[to]!); } if (active === from) active = to as SessionId; },
    setModel(id: string, model: RunModel) { dispatch({ type: "MODEL_SET", runId: key(id), model }); },
    setApprovalMode(id: string, approval_mode: "ask" | "allow") { dispatch({ type: "APPROVAL_MODE_SET", runId: key(id), approval_mode }); },
    dismissNotice() { dispatch({ type: "DISMISS_NOTICE" }); },
    resolveDefault(id: string, currentModel: string, createdWithDefault: boolean) { const persisted = defaults[id]; if (persisted) return facade.setModel(id, currentModel === persisted ? { choice: "default", resolvedDefault: persisted } : { choice: "explicit", model: currentModel, resolvedDefault: persisted }); if (createdWithDefault) { persistDefault(id, currentModel); return facade.setModel(id, { choice: "default", resolvedDefault: currentModel }); } facade.setModel(id, { choice: "explicit", model: currentModel }); },
    dispose() { if (persistTimer) { clearTimeout(persistTimer); persistDrafts(); } executeEffects = () => {}; state.runs.forEach((record) => revoke(record.attachments)); state = { ...state, runs: new Map(), aliases: new Map() }; listeners.clear(); },
  };
  return facade;
}
export type RunStateStore = ReturnType<typeof createRunStateStore>;
