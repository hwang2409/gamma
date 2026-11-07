import type { QueuedImage } from "./image-queue";
import type { OpenFailure, OpenRun, SessionMeta, ServerStatus } from "./session";
import { catalogModels, catalogProviders } from "./settings";

export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type DraftRunId = Brand<`draft:${string}`, "DraftRunId">;
export type SessionId = Brand<string, "SessionId">;
export type RunId = DraftRunId | SessionId;
export type EntryId = Brand<string, "EntryId">;
export type IntentId = Brand<string, "IntentId">;
export type OperationId = Brand<string, "OperationId">;
export type DeliveryMethod = "send" | "steer" | "send_images" | "opaque";
export type PendingDelivery = { id: string; attemptId: string; operationId: OperationId; method: DeliveryMethod; text: string; images: readonly QueuedImage[]; state: "requesting" | "queued" | "retrying" | "dropped" };
export type SessionSettings = { model?: string; approval_mode?: "ask" | "allow" };
export type RunModel = (
  | { choice: "default"; resolvedDefault?: string }
  | { choice: "explicit"; model: string; resolvedDefault?: string }
) & { deferred?: boolean };
export type RunSettingsState = {
  readonly loaded?: SessionSettings;
  readonly desired?: SessionSettings;
  readonly pending?: { operationId: OperationId; kind: "load" | "write" };
  readonly error?: string;
};
export type ModelCatalog = { models: readonly string[]; providers: Readonly<Record<string, string>> };
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
  readonly openOperation?: OperationId;
  readonly open?: OpenRun;
  readonly openingMessages?: number;
  readonly openError?: OpenFailure;
  readonly session?: SessionMeta;
  readonly submitting?: boolean;
  readonly lastDeliveryMethod?: DeliveryMethod;
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
  readonly connected?: boolean;
  readonly notice?: { runId: SessionId };
  readonly modelCatalog?: ModelCatalog;
  readonly catalogPending?: OperationId;
  readonly catalogError?: string;
};
export type WorkspaceEffect =
  | { type: "status"; operationId?: OperationId }
  | { type: "open-session"; runId: SessionId; operationId: OperationId }
  | { type: "load-settings"; runId: SessionId; operationId: OperationId }
  | { type: "abort"; runId: SessionId; operationId: OperationId }
  | { type: "delivery-status"; runId: SessionId; operationId: OperationId; intentId: string }
  | { type: "new-session"; runId: DraftRunId; operationId: OperationId; choice?: { model?: string; provider?: string; approval_mode?: "ask" | "allow" } }
  | { type: "load-catalog"; operationId: OperationId; runId?: SessionId }
  | { type: "set-settings"; runId: SessionId; operationId: OperationId; settings: SessionSettings }
  | { type: "deliver"; runId: RunId; operationId: OperationId; intentId: string }
  | { type: "send-images"; runId: SessionId; operationId: OperationId; intentId: string }
  | { type: "persist-draft"; runId: RunId; text: string }
  | { type: "release-lease"; runId: SessionId };
export type WorkspaceEvent =
  | { type: "ENSURE_RUN"; runId: RunId; model?: RunModel; text?: string }
  | { type: "COMPOSER_EDIT"; runId: RunId; text?: string; attachments?: readonly QueuedImage[] }
  | { type: "REMOVE_ATTACHMENT"; runId: RunId; index: number }
  | { type: "DELIVERY_SETTLE"; runId: RunId; intentId: string; accepted: boolean }
  | { type: "PROMOTE"; runId: DraftRunId; sessionId: SessionId }
  | { type: "MODEL_SET"; runId: RunId; model: RunModel }
  | { type: "MODEL_DEFERRED"; runId: RunId; deferred: boolean }
  | { type: "DISMISS_NOTICE" }
  | { type: "EVICT"; runIds: readonly RunId[] }
  | { type: "NEW_RUN"; entryId: EntryId; runId: DraftRunId }
  | { type: "NAVIGATED"; entryId: EntryId; runId: RunId }
  | { type: "FIRST_SEND"; runId: DraftRunId; operationId: OperationId; choice?: { model?: string; provider?: string; approval_mode?: "ask" | "allow" } }
  | { type: "NEW_SESSION_OK"; runId: DraftRunId; sessionId: SessionId; operationId: OperationId; session?: SessionMeta }
  | { type: "NEW_SESSION_FAIL"; runId: DraftRunId; operationId: OperationId; error: string; busy?: boolean }
  | { type: "STATUS"; sessionId?: SessionId; session?: SessionMeta; turn: "idle" | "running" | "tool" | "approval"; operationId?: OperationId }
  | { type: "OPEN_REQUEST"; runId: SessionId; operationId: OperationId }
  | { type: "OPEN_PROGRESS"; runId: SessionId; operationId: OperationId; messages: number }
  | { type: "OPEN_OK"; runId: SessionId; operationId: OperationId; open: OpenRun; session?: SessionMeta }
  | { type: "OPEN_COMPLETE"; runId: SessionId; operationId: OperationId; open: OpenRun }
  | { type: "OPEN_FAIL"; runId: SessionId; operationId: OperationId; error: string; busy: boolean }
  | { type: "OPEN_DISMISS"; runId: SessionId }
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
  | { type: "SETTINGS_LOAD" | "SETTINGS_WRITE"; runId: SessionId; operationId: OperationId }
  | { type: "CATALOG_LOAD"; runId?: SessionId; operationId: OperationId }
  | { type: "CATALOG_OK"; operationId: OperationId; catalog: ModelCatalog }
  | { type: "CATALOG_FAIL"; operationId: OperationId; error: string }
  | { type: "STOP"; runId: SessionId; operationId?: OperationId }
  | { type: "STOP_OK" | "STOP_FAIL"; runId: SessionId; operationId: OperationId }
  | { type: "DISCONNECT" }
  | { type: "RECONNECT" }
  | { type: "SETTINGS_OK"; runId: SessionId; operationId: OperationId; model?: string; approval_mode?: "ask" | "allow" }
  | { type: "SETTINGS_FAIL"; runId: SessionId; operationId: OperationId; error: string };

const canonical = (state: WorkspaceState, id: RunId): RunId => state.aliases.get(id as DraftRunId) ?? id;
const blank = (id: RunId): RunRecord => ({ id, lifecycle: id.startsWith("draft:") ? { kind: "draft" } : { kind: "opening" }, text: "", attachments: [], deliveries: new Map(), model: { choice: "default" }, settings: {} });
const operationMatches = (record: RunRecord | undefined, operationId: OperationId) => record?.lifecycle.kind === "creating" ? record.lifecycle.operationId === operationId : record?.lifecycle.kind === "opening" ? !record.lifecycle.operationId || record.lifecycle.operationId === operationId : false;
const restoreText = (current: string, restored: string) => current.startsWith(restored) ? current : current ? `${restored}${current.startsWith("\n") ? "" : "\n"}${current}` : restored;

/** Pure owner of run identity, lifecycle, attachment, settings, delivery, and browser-entry policy. */
export function reduceWorkspace(state: WorkspaceState, event: WorkspaceEvent): { state: WorkspaceState; effects: WorkspaceEffect[] } {
  let runs = new Map(state.runs);
  let aliases = new Map(state.aliases);
  let entry = state.entry;
  let attachment = state.attachment;
  let connected = state.connected ?? false;
  let notice = state.notice;
  const effects: WorkspaceEffect[] = [];
  const update = (id: RunId, change: (record: RunRecord) => RunRecord) => {
    const target = canonical({ ...state, aliases }, id);
    runs.set(target, change(runs.get(target) ?? blank(target)));
  };
  const activeOwner = () => attachment.kind === "attached" && attachment.turn !== "idle" ? attachment.sessionId : attachment.kind === "disconnected" ? attachment.lastTurnOwner : undefined;
  const openingOwner = () => [...runs.values()].some((record) => record.submitting || record.lifecycle.kind === "creating" || [...record.deliveries.values()].some((delivery) => delivery.state === "requesting"));
  const cancelSelectedOpen = (next: RunId) => {
    const selected = canonical({ ...state, aliases }, entry.run);
    if (selected === next) return;
    update(selected, (record) => record.openOperation ? { ...record, openOperation: undefined, openingMessages: undefined } : record);
  };
  const beginOpen = (runId: SessionId, operationId: OperationId) => {
    const owner = activeOwner();
    update(runId, (record) => owner && owner !== runId
      ? { ...record, openError: { id: runId, message: `${owner} has the active turn`, busy: true } }
      : { ...record, lifecycle: { kind: "opening", operationId }, openOperation: operationId, openingMessages: 0, openError: undefined });
    if (!owner || owner === runId) effects.push({ type: "open-session", runId, operationId });
  };
  switch (event.type) {
    case "ENSURE_RUN": if (!runs.has(canonical({ ...state, aliases }, event.runId))) runs.set(event.runId, { ...blank(event.runId), ...(event.model ? { model: event.model } : {}), ...(event.text ? { text: event.text } : {}) }); break;
    case "EVICT": for (const id of event.runIds) { const record = runs.get(id); if (record?.open && !id.startsWith("draft:")) effects.push({ type: "release-lease", runId: id as SessionId }); runs.delete(id); } break;
    case "COMPOSER_EDIT": update(event.runId, (record) => ({ ...record, text: event.text ?? record.text, attachments: event.attachments ?? record.attachments })); break;
    case "REMOVE_ATTACHMENT": update(event.runId, (record) => ({ ...record, attachments: record.attachments.filter((_, index) => index !== event.index) })); break;
    case "DELIVERY_SETTLE": update(event.runId, (record) => { const deliveries = new Map(record.deliveries); const delivery = deliveries.get(event.intentId); deliveries.delete(event.intentId); if (!delivery || !event.accepted) return { ...record, deliveries }; return { ...record, text: record.text.startsWith(delivery.text) ? record.text.slice(delivery.text.length) : record.text, attachments: record.attachments.filter((image) => !delivery.images.includes(image)), deliveries }; }); break;
    case "PROMOTE": { const source = runs.get(event.runId) ?? blank(event.runId); const target = runs.get(event.sessionId); runs.delete(event.runId); runs.set(event.sessionId, target && (target.text || target.attachments.length || target.deliveries.size) ? target : { ...source, id: event.sessionId, lifecycle: { kind: "opening" } }); aliases.set(event.runId, event.sessionId); if (entry.run === event.runId) entry = { ...entry, run: event.sessionId }; else notice = { runId: event.sessionId }; break; }
    case "MODEL_SET": update(event.runId, (record) => ({ ...record, model: { ...event.model, deferred: record.model.deferred }, settings: record.id.startsWith("draft:") ? { ...record.settings, desired: { ...record.settings.desired, model: event.model.choice === "explicit" ? event.model.model : undefined } } : record.settings })); break;
    case "MODEL_DEFERRED": update(event.runId, (record) => ({ ...record, model: { ...record.model, deferred: event.deferred } })); break;
    case "DISMISS_NOTICE": notice = undefined; break;
    case "NEW_RUN":
      cancelSelectedOpen(event.runId); runs.set(event.runId, blank(event.runId)); entry = { id: event.entryId, run: event.runId }; break;
    case "NAVIGATED": {
      const target = canonical({ ...state, aliases }, event.runId);
      cancelSelectedOpen(target); entry = { id: event.entryId, run: target }; if (!runs.has(target)) runs.set(target, blank(target));
      if (connected && !target.startsWith("draft:") && !openingOwner()) beginOpen(target as SessionId, crypto.randomUUID() as OperationId);
      break;
    }
    case "FIRST_SEND":
      update(event.runId, (record) => record.lifecycle.kind === "draft" || record.lifecycle.kind === "failed" ? { ...record, lifecycle: { kind: "creating", operationId: event.operationId }, openError: undefined, submitting: true } : record);
      if (attachment.kind !== "attached" || attachment.turn === "idle") effects.push({ type: "new-session", runId: event.runId, operationId: event.operationId, choice: event.choice }); break;
    case "NEW_SESSION_OK": {
      const source = runs.get(event.runId); if (!operationMatches(source, event.operationId)) break;
      const promoted = { ...source!, id: event.sessionId, lifecycle: { kind: "opening", operationId: event.operationId } as RunLifecycle, openOperation: event.operationId, openingMessages: 0, openError: undefined, session: event.session };
      runs.delete(event.runId); runs.set(event.sessionId, promoted); aliases.set(event.runId, event.sessionId); attachment = { kind: "attached", sessionId: event.sessionId, turn: "idle" };
      effects.push({ type: "open-session", runId: event.sessionId, operationId: event.operationId });
      if (entry.id === state.entry.id && entry.run === event.runId) entry = { ...entry, run: event.sessionId };
      break;
    }
    case "NEW_SESSION_FAIL": {
      const accepted = operationMatches(runs.get(canonical({ ...state, aliases }, event.runId)), event.operationId);
      update(event.runId, (record) => accepted ? { ...record, lifecycle: { kind: "failed", error: event.error }, openError: { id: event.runId, message: event.error, busy: event.busy ?? false }, submitting: false } : record);
      const selected = canonical({ ...state, aliases }, entry.run);
      if (accepted && selected !== event.runId && !selected.startsWith("draft:")) beginOpen(selected as SessionId, crypto.randomUUID() as OperationId);
      break;
    }
    case "STATUS": {
      attachment = event.sessionId ? { kind: "attached", sessionId: event.sessionId, turn: event.turn } : { kind: "detached" };
      if (event.sessionId) {
        update(event.sessionId, (record) => ({ ...record, session: event.session ?? record.session }));
        for (const intentId of runs.get(event.sessionId)?.deliveries.keys() ?? []) effects.push({ type: "delivery-status", runId: event.sessionId, operationId: crypto.randomUUID() as OperationId, intentId });
      }
      const selected = canonical({ ...state, aliases }, entry.run);
      const selectedRecord = runs.get(selected);
      if (!selected.startsWith("draft:") && !openingOwner() && (!selectedRecord?.open || selectedRecord.open.stale)) beginOpen(selected as SessionId, event.operationId ?? crypto.randomUUID() as OperationId);
      break;
    }
    case "OPEN_REQUEST": if (!openingOwner()) beginOpen(event.runId, event.operationId); break;
    case "OPEN_PROGRESS": update(event.runId, (record) => record.openOperation === event.operationId ? { ...record, openingMessages: event.messages } : record); break;
    case "OPEN_OK": update(event.runId, (record) => record.openOperation === event.operationId ? { ...record, lifecycle: { kind: "open", lease: event.open.lease }, open: event.open, openingMessages: undefined, openError: undefined, session: event.session ?? record.session } : record); break;
    case "OPEN_COMPLETE": update(event.runId, (record) => record.openOperation === event.operationId ? { ...record, lifecycle: { kind: "open", lease: event.open.lease }, open: event.open, openingMessages: undefined } : record); break;
    case "OPEN_FAIL": update(event.runId, (record) => record.openOperation === event.operationId ? { ...record, lifecycle: record.open ? record.lifecycle : { kind: "failed", error: event.error }, openOperation: undefined, openingMessages: undefined, openError: { id: event.runId, message: event.error, busy: event.busy } } : record); break;
    case "OPEN_DISMISS": update(event.runId, (record) => ({ ...record, openError: undefined })); break;
    case "RESUME_OK": {
      const creatingOwner = [...runs.values()].some((record) => record.submitting && record.lifecycle.kind === "creating");
      if (creatingOwner || (attachment.kind === "attached" && attachment.turn !== "idle" && attachment.sessionId !== event.runId)) break;
      attachment = { kind: "attached", sessionId: event.runId, turn: "idle" }; update(event.runId, (current) => ({ ...current, lifecycle: { kind: "opening", operationId: event.operationId }, settings: { ...current.settings, pending: { operationId: event.operationId, kind: "load" }, error: undefined } })); effects.push({ type: "load-settings", runId: event.runId, operationId: event.operationId });
      for (const intentId of runs.get(event.runId)?.deliveries.keys() ?? []) effects.push({ type: "delivery-status", runId: event.runId, operationId: crypto.randomUUID() as OperationId, intentId }); break;
    }
    case "RESUME_BUSY": update(event.runId, (record) => ({ ...record, lifecycle: { kind: "opening", operationId: event.operationId, waitingForIdle: event.owner } })); break;
    case "RESUME_FAIL": update(event.runId, (record) => operationMatches(record, event.operationId) ? { ...record, lifecycle: { kind: "failed", error: event.error } } : record); break;
    case "FIRST_PAGE": update(event.runId, (record) => !event.operationId || operationMatches(record, event.operationId) ? { ...record, lifecycle: { kind: "open", lease: event.lease, title: event.title, transcript: event.transcript } } : record); break;
    case "TURN_START": if (attachment.kind === "attached" && attachment.sessionId === event.runId) attachment = { ...attachment, turn: event.turn ?? "running" }; break;
    case "TURN_END": {
      if (attachment.kind !== "attached" || attachment.sessionId !== event.runId) break;
      attachment = { ...attachment, turn: "idle" };
      break;
    }
    case "DELIVERY_BEGIN": update(event.runId, (record) => { const deliveries = new Map(record.deliveries); deliveries.set(event.delivery.id, event.delivery); effects.push(event.delivery.method === "send_images" ? { type: "send-images", runId: record.id as SessionId, operationId: event.operationId, intentId: event.delivery.id } : { type: "deliver", runId: record.id, operationId: event.operationId, intentId: event.delivery.id }); return { ...record, deliveries, submitting: false, lastDeliveryMethod: event.delivery.method }; }); break;
    case "DELIVERY_ACK": {
      update(event.runId, (record) => { const deliveries = new Map(record.deliveries); const delivery = deliveries.get(event.intentId); if (delivery?.operationId !== event.operationId) return record; if (event.queued && !event.failed && delivery.state !== "retrying") deliveries.set(event.intentId, { ...delivery, attemptId: event.attemptId, state: "queued" }); else deliveries.delete(event.intentId); if (event.failed) return { ...record, deliveries }; return { ...record, text: record.text.startsWith(delivery.text) ? record.text.slice(delivery.text.length) : record.text, attachments: record.attachments.filter((image) => !delivery.images.includes(image)), deliveries }; });
      const selected = canonical({ ...state, aliases }, entry.run);
      if (event.failed && selected !== canonical({ ...state, aliases }, event.runId) && !selected.startsWith("draft:") && !openingOwner()) beginOpen(selected as SessionId, crypto.randomUUID() as OperationId);
      break;
    }
    case "DELIVERY_RESEND": update(event.runId, (record) => { const deliveries = new Map(record.deliveries); const delivery = deliveries.get(event.intentId); if (delivery?.state === "dropped" && delivery.method !== "opaque") { const operationId = crypto.randomUUID() as OperationId; deliveries.set(event.intentId, { ...delivery, operationId, state: "retrying" }); effects.push({ type: "deliver", runId: record.id, operationId, intentId: event.intentId }); } return { ...record, deliveries }; }); break;
    case "DELIVERY_RECONCILE": update(event.runId, (record) => { const deliveries = new Map(record.deliveries); for (const [intentId, delivery] of deliveries) { if (delivery.state === "dropped" || delivery.state === "requesting") continue; const operationId = crypto.randomUUID() as OperationId; deliveries.set(intentId, { ...delivery, operationId }); effects.push({ type: "delivery-status", runId: record.id as SessionId, operationId, intentId }); } return { ...record, deliveries }; }); break;
    case "DELIVERY_STATUS": update(event.runId, (record) => { const deliveries = new Map(record.deliveries); const delivery = deliveries.get(event.intentId); if (delivery?.operationId !== event.operationId) return record; if (event.status === "delivered") deliveries.delete(event.intentId); else if (delivery.method === "opaque") { deliveries.delete(event.intentId); return { ...record, text: restoreText(record.text, delivery.text), deliveries }; } else if (delivery.state !== "dropped") { const operationId = crypto.randomUUID() as OperationId; deliveries.set(event.intentId, { ...delivery, operationId, state: "retrying" }); effects.push({ type: "deliver", runId: record.id, operationId, intentId: event.intentId }); } return { ...record, deliveries }; }); break;
    case "SETTINGS_DESIRED": update(event.runId, (record) => ({ ...record, model: event.model === undefined ? record.model : { ...(event.model ? { choice: "explicit" as const, model: event.model } : { choice: "default" as const, resolvedDefault: record.model.resolvedDefault }), deferred: record.model.deferred }, settings: { ...record.settings, desired: { ...record.settings.desired, ...(event.model !== undefined ? { model: event.model || undefined } : {}), ...(event.approval_mode !== undefined ? { approval_mode: event.approval_mode } : {}) }, error: undefined } })); break;
    case "SETTINGS_LOAD": update(event.runId, (record) => { effects.push({ type: "load-settings", runId: event.runId, operationId: event.operationId }); return { ...record, settings: { ...record.settings, pending: { operationId: event.operationId, kind: "load" }, error: undefined } }; }); break;
    case "SETTINGS_WRITE": update(event.runId, (record) => { const settings = { ...record.settings.loaded, ...record.settings.desired }; effects.push({ type: "set-settings", runId: event.runId, operationId: event.operationId, settings }); return { ...record, settings: { ...record.settings, pending: { operationId: event.operationId, kind: "write" }, error: undefined } }; }); break;
    case "CATALOG_LOAD": state = { ...state, catalogPending: event.operationId, catalogError: undefined }; effects.push({ type: "load-catalog", operationId: event.operationId, ...(event.runId ? { runId: event.runId } : {}) }); break;
    case "CATALOG_OK": if (state.catalogPending === event.operationId) { state = { ...state, modelCatalog: event.catalog, catalogPending: undefined, catalogError: undefined }; } break;
    case "CATALOG_FAIL": if (state.catalogPending === event.operationId) state = { ...state, catalogPending: undefined, catalogError: event.error }; break;
    case "STOP": { const operationId = event.operationId ?? crypto.randomUUID() as OperationId; update(event.runId, (record) => ({ ...record, stopOperation: operationId })); effects.push({ type: "abort", runId: event.runId, operationId }); break; }
    case "STOP_OK": update(event.runId, (record) => record.stopOperation !== event.operationId ? record : ({ ...record, stopOperation: undefined, deliveries: new Map([...record.deliveries].filter(([, delivery]) => delivery.method === "steer").map(([id, delivery]) => [id, { ...delivery, state: "dropped" as const }])) })); break;
    case "STOP_FAIL": update(event.runId, (record) => record.stopOperation === event.operationId ? { ...record, stopOperation: undefined } : record); break;
    case "DISCONNECT":
      connected = false;
      for (const [id, record] of runs) update(id, (current) => ({ ...current, ...(current.open ? { open: { ...current.open, stale: true } } : {}), deliveries: new Map([...record.deliveries].map(([intentId, delivery]) => [intentId, delivery.state === "requesting" ? { ...delivery, state: "queued" as const } : delivery])) }));
      attachment = { kind: "disconnected", ...(attachment.kind === "attached" ? { lastAttached: attachment.sessionId, ...(attachment.turn !== "idle" ? { lastTurnOwner: attachment.sessionId } : {}) } : {}) }; break;
    case "RECONNECT":
      connected = true;
      effects.push({ type: "status", operationId: crypto.randomUUID() as OperationId });
      if (attachment.kind === "disconnected" && attachment.lastAttached) for (const intentId of runs.get(attachment.lastAttached)?.deliveries.keys() ?? []) effects.push({ type: "delivery-status", runId: attachment.lastAttached, operationId: crypto.randomUUID() as OperationId, intentId });
      break;
    case "SETTINGS_OK": update(event.runId, (record) => record.settings.pending?.operationId !== event.operationId ? record : { ...record, settings: { loaded: { model: event.model, approval_mode: event.approval_mode }, desired: record.settings.desired } }); break;
    case "SETTINGS_FAIL": update(event.runId, (record) => record.settings.pending?.operationId !== event.operationId ? record : { ...record, settings: { ...record.settings, pending: undefined, error: event.error }, submitting: false }); break;
  }
  return { state: { ...state, entry, runs, aliases, attachment, connected, ...(notice ? { notice } : { notice: undefined }) }, effects };
}

export const selectedRun = (state: WorkspaceState) => state.runs.get(canonical(state, state.entry.run));
export const hasPendingDelivery = (record: RunRecord) => [...record.deliveries.values()].some((delivery) => delivery.state !== "dropped");
export const activeRun = (state: WorkspaceState) => state.attachment.kind === "attached" && state.attachment.turn !== "idle" ? state.attachment.sessionId : state.attachment.kind === "disconnected" ? state.attachment.lastTurnOwner ?? null : null;
export const workspaceRunState = (state: WorkspaceState) => {
  const record = selectedRun(state);
  const selected = state.entry.run.startsWith("draft:") ? null : state.entry.run as SessionId;
  return {
    selected,
    open: record?.open ?? null,
    opening: selected && !record?.open && record?.openOperation ? { id: selected, messages: record.openingMessages ?? 0 } : null,
    openError: record?.openError ?? null,
    session: record?.session ?? null,
    active: activeRun(state),
    attached: state.attachment.kind === "attached" ? state.attachment.sessionId : null,
  };
};

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
  let cachedCatalog: ModelCatalog | undefined;
  try { const raw = JSON.parse(storage?.getItem("gamma-catalog") ?? "null"); cachedCatalog = { models: catalogModels(raw), providers: catalogProviders(raw) }; } catch {}
  let state: WorkspaceState = { entry: initialEntry, runs: new Map(), aliases: new Map(), attachment: { kind: "detached" }, ...(cachedCatalog ? { modelCatalog: cachedCatalog } : {}) };
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
  const evict = () => { const clean = [...state.runs].filter(([id, record]) => id !== active && !dirty(record)); const evicted: RunId[] = []; while (clean.length > cleanLimit) { const [id, record] = clean.shift()!; revoke(record.attachments); evicted.push(id); } if (evicted.length) dispatch({ type: "EVICT", runIds: evicted }, false); };
  const persistDrafts = () => { persistTimer = null; try { draftStorage?.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch {} };
  const queueDraft = (id: string, text: string) => { const target = key(id); if (text) drafts[target] = text; else delete drafts[target]; if (persistTimer) clearTimeout(persistTimer); persistTimer = setTimeout(persistDrafts, 120); };
  const persistDefault = (id: string, model: string) => { delete defaults[id]; defaults[id] = model; defaults = Object.fromEntries(Object.entries(defaults).slice(-DEFAULTS_LIMIT)); try { storage?.setItem(DEFAULTS_KEY, JSON.stringify(defaults)); } catch {} };
  const facade = {
    canonical(id: string) { return key(id); },
    get(id: string) { return value(id); },
    getEntry() { return state.entry; },
    getNotice() { return state.notice ?? null; },
    getCatalog() { return state; },
    dispatch,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    activate(id: string, initialModel: RunModel = { choice: "default" }) { active = key(id); const existed = state.runs.has(active); value(active); if (!existed) dispatch({ type: "MODEL_SET", runId: active, model: initialModel }); evict(); },
    edit(id: string, patch: { text?: string; attachments?: readonly QueuedImage[] }) { const current = value(id); const text = patch.text ?? current.text; dispatch({ type: "COMPOSER_EDIT", runId: key(id), text, ...(patch.attachments ? { attachments: patch.attachments } : {}) }); if (patch.text !== undefined) queueDraft(id, text); evict(); },
    consumeDraft(id: string, text: string) { const current = value(id).text; const next = current.startsWith(text) ? current.slice(text.length) : current; dispatch({ type: "COMPOSER_EDIT", runId: key(id), text: next }); queueDraft(id, next); },
    restoreDraft(id: string, text: string) { const next = restoreText(value(id).text, text); dispatch({ type: "COMPOSER_EDIT", runId: key(id), text: next }); queueDraft(id, next); },
    removeAttachment(id: string, index: number) { const image = value(id).attachments[index]; if (!image) return; URL.revokeObjectURL(image.url); dispatch({ type: "REMOVE_ATTACHMENT", runId: key(id), index }); },
    beginDelivery(id: string, delivery: Omit<PendingDelivery, "operationId" | "state">, operationId = crypto.randomUUID() as OperationId) { dispatch({ type: "DELIVERY_BEGIN", runId: key(id), delivery: { ...delivery, operationId, state: "requesting" }, operationId }); return operationId; },
    reconcileDeliveries(id: string) { dispatch({ type: "DELIVERY_RECONCILE", runId: key(id) }); },
    requestOpen(id: string, operationId = crypto.randomUUID() as OperationId) { const runId = key(id); if (!runId.startsWith("draft:")) dispatch({ type: "OPEN_REQUEST", runId: runId as SessionId, operationId }); return operationId; },
    startSession(id: string, choice: { model?: string; provider?: string; approval_mode?: "ask" | "allow" } = {}, operationId = crypto.randomUUID() as OperationId) { const runId = key(id); if (runId.startsWith("draft:")) dispatch({ type: "FIRST_SEND", runId: runId as DraftRunId, operationId, choice }); return operationId; },
    isCurrentOperation(id: string, operationId: OperationId) { const record = state.runs.get(key(id)); return record?.openOperation === operationId || (record?.lifecycle.kind === "creating" && record.lifecycle.operationId === operationId); },
    stop(id: string, operationId?: OperationId) { const runId = key(id); if (!runId.startsWith("draft:")) dispatch({ type: "STOP", runId: runId as SessionId, operationId }); },
    setEffectExecutor(executor: (effects: readonly WorkspaceEffect[]) => void) { executeEffects = executor; },
    settleDelivery(id: string, deliveryId: string, status: "accepted" | "rejected") { const delivery = value(id).deliveries.get(deliveryId); if (!delivery) return; const kept = value(id).attachments.filter((image) => !delivery.images.includes(image)); if (status === "accepted") revoke(delivery.images.filter((image) => !kept.includes(image))); dispatch({ type: "DELIVERY_SETTLE", runId: key(id), intentId: deliveryId, accepted: status === "accepted" }); queueDraft(id, value(id).text); evict(); },
    promote(from: string, to: string) { if (from === to) return; dispatch({ type: "PROMOTE", runId: from as DraftRunId, sessionId: to as SessionId }); if (drafts[from]) { drafts[to] = drafts[from]; delete drafts[from]; queueDraft(to, drafts[to]!); } if (active === from) active = to as SessionId; },
    setModel(id: string, model: RunModel) { dispatch({ type: "MODEL_SET", runId: key(id), model }); },
    setModelDeferred(id: string, deferred: boolean) { dispatch({ type: "MODEL_DEFERRED", runId: key(id), deferred }); },
    desireSettings(id: string, settings: SessionSettings) { dispatch({ type: "SETTINGS_DESIRED", runId: key(id), ...settings }); },
    loadSettings(id: string, operationId: OperationId) { const runId = key(id); if (!runId.startsWith("draft:")) dispatch({ type: "SETTINGS_LOAD", runId: runId as SessionId, operationId }); },
    writeSettings(id: string, operationId: OperationId) { const runId = key(id); if (!runId.startsWith("draft:")) dispatch({ type: "SETTINGS_WRITE", runId: runId as SessionId, operationId }); },
    loadCatalog(id: string | null, operationId: OperationId) { const runId = id ? key(id) : null; dispatch({ type: "CATALOG_LOAD", ...(runId && !runId.startsWith("draft:") ? { runId: runId as SessionId } : {}), operationId }); },
    dismissNotice() { dispatch({ type: "DISMISS_NOTICE" }); },
    resolveDefault(id: string, currentModel: string, createdWithDefault: boolean) { const persisted = defaults[id]; if (persisted) return facade.setModel(id, currentModel === persisted ? { choice: "default", resolvedDefault: persisted } : { choice: "explicit", model: currentModel, resolvedDefault: persisted }); if (createdWithDefault) { persistDefault(id, currentModel); return facade.setModel(id, { choice: "default", resolvedDefault: currentModel }); } facade.setModel(id, { choice: "explicit", model: currentModel }); },
    dispose() { if (persistTimer) { clearTimeout(persistTimer); persistDrafts(); } const releases = [...state.runs].flatMap(([id, record]) => record.open && !id.startsWith("draft:") ? [{ type: "release-lease" as const, runId: id as SessionId }] : []); executeEffects(releases); executeEffects = () => {}; state.runs.forEach((record) => revoke(record.attachments)); state = { ...state, runs: new Map(), aliases: new Map() }; listeners.clear(); },
  };
  return facade;
}
export type RunStateStore = ReturnType<typeof createRunStateStore>;
