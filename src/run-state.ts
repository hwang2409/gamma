import type { QueuedImage } from "./image-queue";

export type RunId = string;
export type DeliveryMethod = "send" | "steer" | "send_images";
export type DeliveryStatus = "pending" | "accepted" | "rejected";
export type PendingDelivery = {
  id: string;
  method: DeliveryMethod;
  status: DeliveryStatus;
  text: string;
  images: readonly QueuedImage[];
};
export type RunModel =
  | { choice: "default"; resolvedDefault?: string }
  | { choice: "explicit"; model: string; resolvedDefault?: string };
export type RunRecord = {
  readonly text: string;
  readonly attachments: readonly QueuedImage[];
  readonly deliveries: ReadonlyMap<string, PendingDelivery>;
  readonly model: RunModel;
};

type DefaultModels = Record<string, string>;
type RunStorage = Pick<globalThis.Storage, "getItem" | "setItem">;
const EMPTY: RunRecord = { text: "", attachments: [], deliveries: new Map(), model: { choice: "default" } };
const DEFAULTS_KEY = "gamma-run-defaults";
const DEFAULTS_LIMIT = 32;

const parseDefaults = (storage?: RunStorage): DefaultModels => {
  try {
    const value = JSON.parse(storage?.getItem(DEFAULTS_KEY) ?? "null");
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
};

/** Owns all mutable state that must survive a run view mounting, unmounting, or moving through browser history. */
export function createRunStateStore(cleanLimit = 8, storage: RunStorage | undefined = globalThis.localStorage) {
  const records = new Map<RunId, RunRecord>();
  const aliases = new Map<RunId, RunId>();
  const listeners = new Set<() => void>();
  let active: RunId | null = null;
  let defaults = parseDefaults(storage);
  const emit = () => listeners.forEach((listener) => listener());
  const key = (id: RunId) => aliases.get(id) ?? id;
  const value = (id: RunId) => records.get(key(id)) ?? EMPTY;
  const write = (id: RunId, record: RunRecord) => { const target = key(id); records.delete(target); records.set(target, record); emit(); };
  const revoke = (images: readonly QueuedImage[]) => images.forEach((image) => URL.revokeObjectURL(image.url));
  const dirty = (record: RunRecord) => Boolean(record.text || record.attachments.length || [...record.deliveries.values()].some((delivery) => delivery.status === "pending"));
  const evict = () => {
    let clean = [...records].filter(([id, record]) => id !== active && !dirty(record));
    while (clean.length > cleanLimit) {
      const [id, record] = clean.shift()!;
      revoke(record.attachments);
      records.delete(id);
    }
  };
  const persistDefault = (id: RunId, model: string) => {
    delete defaults[id];
    defaults[id] = model;
    defaults = Object.fromEntries(Object.entries(defaults).slice(-DEFAULTS_LIMIT));
    try { storage?.setItem(DEFAULTS_KEY, JSON.stringify(defaults)); } catch { /* storage can be unavailable in private browser contexts */ }
  };
  return {
    get(id: RunId): RunRecord { return value(id); },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    activate(id: RunId, initialModel: RunModel = { choice: "default" }) { active = id; if (!records.has(id)) records.set(id, { ...EMPTY, model: initialModel }); evict(); emit(); },
    edit(id: RunId, patch: { text?: string; attachments?: readonly QueuedImage[] }) {
      const current = value(id);
      write(id, { ...current, text: patch.text ?? current.text, attachments: patch.attachments ?? current.attachments });
      evict();
    },
    removeAttachment(id: RunId, index: number) {
      const current = value(id);
      const image = current.attachments[index];
      if (!image) return;
      URL.revokeObjectURL(image.url);
      write(id, { ...current, attachments: current.attachments.filter((_, item) => item !== index) });
    },
    beginDelivery(id: RunId, delivery: Omit<PendingDelivery, "status">) {
      const current = value(id);
      const deliveries = new Map(current.deliveries);
      deliveries.set(delivery.id, { ...delivery, status: "pending" });
      write(id, { ...current, deliveries });
    },
    settleDelivery(id: RunId, deliveryId: string, status: "accepted" | "rejected") {
      const current = value(id);
      const delivery = current.deliveries.get(deliveryId);
      if (!delivery || delivery.status !== "pending") return;
      const deliveries = new Map(current.deliveries);
      deliveries.set(deliveryId, { ...delivery, status });
      if (status === "rejected") { write(id, { ...current, deliveries }); return; }
      const text = current.text.startsWith(delivery.text) ? current.text.slice(delivery.text.length) : current.text;
      const attachments = current.attachments.filter((image) => !delivery.images.includes(image));
      revoke(delivery.images.filter((image) => !attachments.includes(image)));
      write(id, { ...current, text, attachments, deliveries });
      evict();
    },
    promote(from: RunId, to: RunId) {
      if (from === to) return;
      const source = value(from);
      const target = records.get(to);
      records.delete(from);
      records.set(to, target && dirty(target) ? target : source);
      aliases.set(from, to);
      if (active === from) active = to;
      emit();
    },
    setModel(id: RunId, model: RunModel) { write(id, { ...value(id), model }); },
    resolveDefault(id: RunId, currentModel: string, createdWithDefault: boolean) {
      const persisted = defaults[id];
      if (persisted) return this.setModel(id, currentModel === persisted ? { choice: "default", resolvedDefault: persisted } : { choice: "explicit", model: currentModel, resolvedDefault: persisted });
      if (createdWithDefault) {
        persistDefault(id, currentModel);
        return this.setModel(id, { choice: "default", resolvedDefault: currentModel });
      }
      this.setModel(id, { choice: "explicit", model: currentModel });
    },
    evict,
    dispose() { records.forEach((record) => revoke(record.attachments)); records.clear(); aliases.clear(); listeners.clear(); },
  };
}
export type RunStateStore = ReturnType<typeof createRunStateStore>;
