import type { QueuedImage } from "./image-queue";

export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type DraftRunId = Brand<`draft:${string}`, "DraftRunId">;
export type SessionId = Brand<string, "SessionId">;
export type RunId = DraftRunId | SessionId;
export type EntryId = Brand<string, "EntryId">;
export type IntentId = Brand<string, "IntentId">;
export type OperationId = Brand<string, "OperationId">;
export type DeliveryMethod = "send" | "steer" | "send_images";
export type PendingDelivery = { id: string; method: DeliveryMethod; text: string; images: readonly QueuedImage[]; state?: "requesting" | "queued" | "retrying" | "dropped" };
export type RunModel =
  | { choice: "default"; resolvedDefault?: string }
  | { choice: "explicit"; model: string; resolvedDefault?: string };
export type RunSettingsState =
  | { kind: "unknown"; desired?: { model?: string; approval_mode?: "ask" | "allow" } }
  | { kind: "loading"; operationId: OperationId }
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
  readonly model: RunModel;
  readonly settings: RunSettingsState;
};
export type AttachmentState =
  | { kind: "detached" }
  | { kind: "attached"; sessionId: SessionId; turn: "idle" | "running" | "tool" | "approval" }
  | { kind: "disconnected"; lastAttached?: SessionId; lastTurnOwner?: SessionId };
export type WorkspaceState = {
  readonly entry: { id: EntryId; run: RunId };
  readonly runs: ReadonlyMap<RunId, RunRecord>;
  readonly aliases: ReadonlyMap<DraftRunId, SessionId>;
  readonly attachment: AttachmentState;
};
export type WorkspaceEffect =
  | { type: "history-push" | "history-replace-current"; entryId: EntryId; runId: RunId }
  | { type: "status" }
  | { type: "resume" | "open-history" | "load-settings" | "delivery-status" | "abort"; runId: SessionId; operationId: OperationId }
  | { type: "new-session" | "deliver" | "set-settings"; runId: RunId; operationId: OperationId }
  | { type: "persist-draft"; runId: RunId; text: string }
  | { type: "release-lease"; runId: SessionId };
export type WorkspaceEvent =
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
  | { type: "DELIVERY_ACK"; runId: RunId; intentId: string; queued?: boolean }
  | { type: "DELIVERY_STATUS"; runId: RunId; intentId: string; status: "delivered" | "dropped" }
  | { type: "STOP"; runId: SessionId }
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
  const effects: WorkspaceEffect[] = [];
  const update = (id: RunId, change: (record: RunRecord) => RunRecord) => {
    const target = canonical({ ...state, aliases }, id);
    runs.set(target, change(runs.get(target) ?? blank(target)));
  };
  switch (event.type) {
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
    case "STATUS": attachment = event.sessionId ? { kind: "attached", sessionId: event.sessionId, turn: event.turn } : { kind: "detached" }; break;
    case "RESUME_OK": attachment = { kind: "attached", sessionId: event.runId, turn: "idle" }; update(event.runId, (record) => ({ ...record, lifecycle: { kind: "opening", operationId: event.operationId }, settings: { kind: "loading", operationId: event.operationId } })); effects.push({ type: "load-settings", runId: event.runId, operationId: event.operationId }); break;
    case "RESUME_BUSY": update(event.runId, (record) => ({ ...record, lifecycle: { kind: "opening", operationId: event.operationId, waitingForIdle: event.owner } })); break;
    case "RESUME_FAIL": update(event.runId, (record) => operationMatches(record, event.operationId) ? { ...record, lifecycle: { kind: "failed", error: event.error } } : record); break;
    case "FIRST_PAGE": update(event.runId, (record) => !event.operationId || operationMatches(record, event.operationId) ? { ...record, lifecycle: { kind: "open", lease: event.lease, title: event.title, transcript: event.transcript } } : record); break;
    case "TURN_START": if (attachment.kind === "attached" && attachment.sessionId === event.runId) attachment = { ...attachment, turn: event.turn ?? "running" }; break;
    case "TURN_END": if (attachment.kind === "attached" && attachment.sessionId === event.runId) attachment = { ...attachment, turn: "idle" }; break;
    case "DELIVERY_ACK": update(event.runId, (record) => { const deliveries = new Map(record.deliveries); const delivery = deliveries.get(event.intentId); if (delivery) event.queued ? deliveries.set(event.intentId, { ...delivery, state: "queued" }) : deliveries.delete(event.intentId); return { ...record, deliveries }; }); break;
    case "DELIVERY_STATUS": update(event.runId, (record) => { const deliveries = new Map(record.deliveries); const delivery = deliveries.get(event.intentId); if (event.status === "delivered") deliveries.delete(event.intentId); else if (delivery) deliveries.set(event.intentId, { ...delivery, state: "retrying" }); return { ...record, deliveries }; }); break;
    case "STOP": update(event.runId, (record) => ({ ...record, deliveries: new Map([...record.deliveries].map(([id, delivery]) => [id, delivery.method === "steer" ? { ...delivery, state: "dropped" as const } : delivery])) })); effects.push({ type: "abort", runId: event.runId, operationId: crypto.randomUUID() as OperationId }); break;
    case "DISCONNECT": attachment = { kind: "disconnected", ...(attachment.kind === "attached" ? { lastAttached: attachment.sessionId, ...(attachment.turn !== "idle" ? { lastTurnOwner: attachment.sessionId } : {}) } : {}) }; break;
    case "RECONNECT": effects.push({ type: "status" }); break;
    case "SETTINGS_OK": update(event.runId, (record) => record.settings.kind === "loading" && record.settings.operationId !== event.operationId ? record : { ...record, settings: { kind: "ready", model: event.model, approval_mode: event.approval_mode } }); break;
    case "SETTINGS_FAIL": update(event.runId, (record) => record.settings.kind === "loading" && record.settings.operationId !== event.operationId ? record : { ...record, settings: { kind: "failed", error: event.error } }); break;
  }
  return { state: { entry, runs, aliases, attachment }, effects };
}

export const selectedRun = (state: WorkspaceState) => state.runs.get(canonical(state, state.entry.run));

type DefaultModels = Record<string, string>;
type RunStorage = Pick<globalThis.Storage, "getItem" | "setItem">;
const DEFAULTS_KEY = "gamma-run-defaults";
const DRAFTS_KEY = "gamma-run-drafts";
const DEFAULTS_LIMIT = 32;
const parseMap = (storage: RunStorage | undefined, key: string): Record<string, string> => { try { const value = JSON.parse(storage?.getItem(key) ?? "null"); return value && typeof value === "object" ? value : {}; } catch { return {}; } };

/** React adapter over the workspace record data. Browser policy uses reduceWorkspace directly. */
export function createRunStateStore(cleanLimit = 8, storage: RunStorage | undefined = globalThis.localStorage, draftStorage: RunStorage | undefined = globalThis.sessionStorage) {
  const records = new Map<string, RunRecord>();
  const aliases = new Map<string, string>();
  const listeners = new Set<() => void>();
  let active: string | null = null;
  let defaults = parseMap(storage, DEFAULTS_KEY);
  let drafts = parseMap(draftStorage, DRAFTS_KEY);
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const emit = () => listeners.forEach((listener) => listener());
  const key = (id: string) => aliases.get(id) ?? id;
  const value = (id: string): RunRecord => records.get(key(id)) ?? { ...blank(id as RunId), text: drafts[key(id)] ?? "" };
  const write = (id: string, record: RunRecord) => { const target = key(id); records.delete(target); records.set(target, record); emit(); };
  const revoke = (images: readonly QueuedImage[]) => images.forEach((image) => URL.revokeObjectURL(image.url));
  const dirty = (record: RunRecord) => Boolean(record.text || record.attachments.length || record.deliveries.size || record.lifecycle.kind === "creating");
  const evict = () => { let clean = [...records].filter(([id, record]) => id !== active && !dirty(record)); while (clean.length > cleanLimit) { const [id, record] = clean.shift()!; revoke(record.attachments); records.delete(id); } };
  const persistDrafts = () => { persistTimer = null; try { draftStorage?.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch {} };
  const queueDraft = (id: string, text: string) => { if (text) drafts[key(id)] = text; else delete drafts[key(id)]; if (persistTimer) clearTimeout(persistTimer); persistTimer = setTimeout(persistDrafts, 120); };
  const persistDefault = (id: string, model: string) => { delete defaults[id]; defaults[id] = model; defaults = Object.fromEntries(Object.entries(defaults).slice(-DEFAULTS_LIMIT)); try { storage?.setItem(DEFAULTS_KEY, JSON.stringify(defaults)); } catch {} };
  return {
    canonical(id: string) { return key(id); },
    get(id: string) { return value(id); },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    activate(id: string, initialModel: RunModel = { choice: "default" }) { active = key(id); if (!records.has(active)) records.set(active, { ...value(id), id: active as RunId, model: initialModel }); evict(); emit(); },
    edit(id: string, patch: { text?: string; attachments?: readonly QueuedImage[] }) { const current = value(id); const text = patch.text ?? current.text; write(id, { ...current, text, attachments: patch.attachments ?? current.attachments }); if (patch.text !== undefined) queueDraft(id, text); evict(); },
    removeAttachment(id: string, index: number) { const current = value(id); const image = current.attachments[index]; if (!image) return; URL.revokeObjectURL(image.url); write(id, { ...current, attachments: current.attachments.filter((_, item) => item !== index) }); },
    beginDelivery(id: string, delivery: PendingDelivery) { const current = value(id); const deliveries = new Map(current.deliveries); deliveries.set(delivery.id, { ...delivery, state: delivery.state ?? "requesting" }); write(id, { ...current, deliveries }); },
    settleDelivery(id: string, deliveryId: string, status: "accepted" | "rejected") { const current = value(id); const delivery = current.deliveries.get(deliveryId); if (!delivery) return; const deliveries = new Map(current.deliveries); deliveries.delete(deliveryId); if (status === "rejected") return write(id, { ...current, deliveries }); const text = current.text.startsWith(delivery.text) ? current.text.slice(delivery.text.length) : current.text; const attachments = current.attachments.filter((image) => !delivery.images.includes(image)); revoke(delivery.images.filter((image) => !attachments.includes(image))); queueDraft(id, text); write(id, { ...current, text, attachments, deliveries }); evict(); },
    promote(from: string, to: string) { if (from === to) return; const source = value(from); const target = records.get(to); records.delete(from); records.set(to, target && dirty(target) ? target : { ...source, id: to as RunId, lifecycle: { kind: "opening" } }); aliases.set(from, to); if (drafts[from]) { drafts[to] = drafts[from]; delete drafts[from]; queueDraft(to, drafts[to]!); } if (active === from) active = to; emit(); },
    setModel(id: string, model: RunModel) { write(id, { ...value(id), model }); },
    resolveDefault(id: string, currentModel: string, createdWithDefault: boolean) { const persisted = defaults[id]; if (persisted) return this.setModel(id, currentModel === persisted ? { choice: "default", resolvedDefault: persisted } : { choice: "explicit", model: currentModel, resolvedDefault: persisted }); if (createdWithDefault) { persistDefault(id, currentModel); return this.setModel(id, { choice: "default", resolvedDefault: currentModel }); } this.setModel(id, { choice: "explicit", model: currentModel }); },
    dispose() { if (persistTimer) { clearTimeout(persistTimer); persistDrafts(); } records.forEach((record) => revoke(record.attachments)); records.clear(); aliases.clear(); listeners.clear(); },
  };
}
export type RunStateStore = ReturnType<typeof createRunStateStore>;
