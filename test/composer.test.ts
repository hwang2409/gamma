import { expect, test } from "bun:test";
import { createRunStateStore, type RunModel } from "../src/run-state";
import type { QueuedImage } from "../src/image-queue";

const image = (url: string) => ({ url, name: `${url}.png`, mime_type: "image/png", data: "", size: 1, width: 1, height: 1 }) as QueuedImage;
const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

test("unactivated snapshots stay referentially stable for React", () => {
  const state = createRunStateStore(1, storage());
  expect(state.get("draft:unmounted")).toBe(state.get("draft:unmounted"));
  state.dispose();
});

test("run state preserves follow-up text when an old run accepts after navigation", () => {
  const store = createRunStateStore(1, storage());
  store.activate("run-a");
  store.edit("run-a", { text: "send this" });
  store.beginDelivery("run-a", { id: "delivery-a", method: "send", text: "send this", images: [] });
  store.edit("run-a", { text: "send thiskeep this unsent follow-up" });
  store.activate("run-b");
  store.settleDelivery("run-a", "delivery-a", "accepted");
  expect(store.get("run-a").text).toBe("keep this unsent follow-up");
});

test("a pending first delivery follows its temporary run id promotion", () => {
  const store = createRunStateStore(1, storage());
  store.activate("blank:0");
  store.edit("blank:0", { text: "first promptfollow-up" });
  store.beginDelivery("blank:0", { id: "first", method: "send", text: "first prompt", images: [] });
  store.promote("blank:0", "session-1");
  store.settleDelivery("blank:0", "first", "accepted");
  expect(store.get("session-1").text).toBe("follow-up");
});

test("run state evicts only clean inactive records", () => {
  const store = createRunStateStore(1, storage());
  store.activate("dirty");
  store.edit("dirty", { text: "private", attachments: [image("blob:dirty")] });
  store.activate("pending");
  store.beginDelivery("pending", { id: "p", method: "send", text: "", images: [] });
  for (const id of ["clean-a", "clean-b", "clean-c"]) store.activate(id);
  expect(store.get("dirty").text).toBe("private");
  expect(store.get("dirty").attachments.map((item) => item.url)).toEqual(["blob:dirty"]);
  expect(store.get("pending").deliveries.has("p")).toBe(true);
});

test("settled image deliveries retain no submitted data", () => {
  const originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = () => {};
  try {
    const store = createRunStateStore(1, storage());
    store.activate("images");
    for (let index = 0; index < 100; index++) {
      const item = { ...image(`blob:${index}`), data: "x".repeat(699_000) };
      const id = `delivery-${index}`;
      store.edit("images", { attachments: [item] });
      store.beginDelivery("images", { id, method: "send_images", text: `image ${index}`, images: [item] });
      store.settleDelivery("images", id, "accepted");
    }
    expect(store.get("images").deliveries.size).toBe(0);
    expect(store.get("images").attachments).toEqual([]);
  } finally { URL.revokeObjectURL = originalRevoke; }
});

test("random run-state sequences preserve all five invariants after every operation", () => {
  const saved = storage();
  const originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = () => {};
  try {
    for (let seed = 1; seed <= 40; seed++) {
      let random = seed;
      const next = (max: number) => ((random = (random * 48271) % 0x7fffffff) % max);
      let store = createRunStateStore(10_000, saved);
      const ids = ["run-0", "run-1", "run-2", "run-3"];
      let active = ids[0]!;
      let sequence = 0;
      const expected = new Map<string, { text: string; images: QueuedImage[]; pending: Map<string, { text: string; images: QueuedImage[] }>; model: RunModel }>();
      const state = (id: string) => {
        let value = expected.get(id);
        if (!value) { value = { text: "", images: [], pending: new Map(), model: { choice: "default" } }; expected.set(id, value); }
        return value;
      };
      store.activate(active);
      state(active);
      for (let step = 0; step < 200; step++) {
        const current = state(active);
        switch (next(12)) {
          case 0: { const text = `typed-${seed}-${step}`; current.text += text; store.edit(active, { text: current.text }); break; }
          case 1: { const item = image(`blob:${seed}:${step}`); current.images.push(item); store.edit(active, { attachments: [...current.images] }); break; }
          case 2: {
            if ([...current.pending].length) break;
            const id = `delivery-${seed}-${sequence++}`;
            current.pending.set(id, { text: current.text, images: [...current.images] });
            store.beginDelivery(active, { id, method: current.images.length ? "send_images" : "send", text: current.text, images: [...current.images] });
            break;
          }
          case 3: {
            const entry = [...current.pending].at(0); if (!entry) break;
            const [id, sent] = entry; current.pending.delete(id);
            if (current.text.startsWith(sent.text)) current.text = current.text.slice(sent.text.length);
            current.images = current.images.filter((item) => !sent.images.includes(item));
            store.settleDelivery(active, id, "accepted");
            break;
          }
          case 4: { const id = [...current.pending.keys()].at(0); if (id) { current.pending.delete(id); store.settleDelivery(active, id, "rejected"); } break; }
          case 5: case 6: case 7: { active = ids[next(ids.length)]!; state(active); store.activate(active); break; }
          case 8: { active = ids[next(ids.length)]!; state(active); store.activate(active); break; }
          case 9: {
            const model = `model-${next(3)}`;
            current.model = { choice: "explicit", model, resolvedDefault: current.model.resolvedDefault };
            store.setModel(active, current.model);
            break;
          }
          case 10: {
            const session = `session-${seed}`;
            store.resolveDefault(session, "zeta-default", true);
            store.dispose();
            store = createRunStateStore(10_000, saved);
            store.activate(session, { choice: "explicit", model: "override" });
            store.resolveDefault(session, "override", false);
            expect(store.get(session).model).toEqual({ choice: "explicit", model: "override", resolvedDefault: "zeta-default" });
            expected.clear(); active = session; state(active).model = store.get(active).model;
            break;
          }
          case 11: {
            const promoted = `promoted-${seed}-${step}`;
            const source = state(active);
            store.promote(active, promoted);
            expected.delete(active);
            expected.set(promoted, source);
            ids[ids.indexOf(active)] = promoted;
            active = promoted;
            break;
          }
        }
        for (const [id, model] of expected) {
          const actual = store.get(id);
          expect(actual.text).toBe(model.text); // I1: navigation, acceptance, and eviction do not lose unsent text.
          expect(actual.attachments.map((item) => item.url)).toEqual(model.images.map((item) => item.url)); // I3: dirty attachments are retained.
          expect(actual.model).toEqual(model.model); // I4: the model follows the run and survives reload.
          expect([...actual.deliveries.keys()].sort()).toEqual([...model.pending.keys()].sort()); // I2: pending deliveries remain only on their owner.
          for (const deliveryId of model.pending.keys()) {
            const owners = [...expected.keys()].filter((candidate) => store.get(candidate).deliveries.has(deliveryId));
            expect(owners).toEqual([id]);
          }
        }
        for (const [id, model] of expected) if (id !== active && (model.text || model.images.length || model.pending.size)) expect(store.get(id)).not.toEqual({ text: "", attachments: [], deliveries: new Map(), model: { choice: "default" } }); // I3
        // I5 is checked by the exact text equality above after every acceptance: the reference removes only the submitted prefix from current store text.
      }
      store.dispose();
    }
  } finally { URL.revokeObjectURL = originalRevoke; }
});
