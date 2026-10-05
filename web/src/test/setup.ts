import "@testing-library/dom";

// jsdom has no layout, so it has no ResizeObserver or matchMedia. The UI
// only needs them to exist; nothing in a unit test resizes.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

// Node 26 defines its own global localStorage, which is undefined unless
// Node is started with --localstorage-file, and it hides jsdom's. Reading it
// prints a warning, so the tests replace it without reading it first.
const values = new Map<string, string>();
const memory: Storage = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => void values.delete(key),
  setItem: (key, value) => void values.set(key, String(value)),
};
Object.defineProperty(globalThis, "localStorage", { value: memory, configurable: true });
