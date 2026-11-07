import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { RunStateStore } from "./run-state";
import type { DeliveryManager } from "./delivery";
import { catalogModels, catalogProviders } from "./settings";

const CATALOG = "gamma-catalog";
const MODEL = "gamma-model";
const VIM = "gamma-vim";

type Catalog = { models: string[]; providers: Record<string, string> };
const cachedCatalog = (): Catalog => {
  try { const value = JSON.parse(localStorage.getItem(CATALOG) ?? "null"); return { models: catalogModels(value), providers: catalogProviders(value) }; }
  catch { return { models: [], providers: {} }; }
};
/** The model the next new run starts with: the last one picked, when zeta's catalog still has it. */
export function nextRunModel(): { model?: string; provider?: string } {
  const model = localStorage.getItem(MODEL);
  const catalog = cachedCatalog();
  if (!model || !catalog.models.includes(model)) return {};
  return { model, ...(catalog.providers[model] ? { provider: catalog.providers[model] } : {}) };
}

/** Vim keys in the composer: opt-in and kept in localStorage. */
export function useVimSetting() {
  const [on, setOn] = useState(() => localStorage.getItem(VIM) === "on");
  const set = useCallback((value: boolean) => { localStorage.setItem(VIM, value ? "on" : "off"); setOn(value); }, []);
  return [on, set] as const;
}

/** Closes on Escape (unless an inner control took it) and on a press outside `root`. */
function useDismiss(open: boolean, root: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); close(); } };
    const press = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", press);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", press); };
  }, [open, root, close]);
}

function ModelPicker({ value, models, resolvedDefault, allowDefault, onChange }: { value: string; models: string[]; resolvedDefault?: string; allowDefault: boolean; onChange(value: string): void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const typeahead = useRef({ text: "", at: 0 });
  const options = [...(allowDefault ? [""] : []), ...models.filter((model) => model !== "")];
  const defaultLabel = resolvedDefault ? `default (${resolvedDefault})` : "default";
  const label = value || defaultLabel;
  const close = useCallback(() => { setOpen(false); button.current?.focus(); }, []);
  useDismiss(open, root, close);
  useEffect(() => { if (open) { setActive(Math.max(0, options.indexOf(value))); root.current?.querySelector<HTMLElement>("[role=listbox]")?.focus(); } }, [open, value]);
  const key = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((item) => Math.min(options.length - 1, item + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((item) => Math.max(0, item - 1)); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(options.length - 1); }
    else if (event.key === "Enter") { event.preventDefault(); onChange(options[active] ?? ""); close(); }
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const text = `${now - typeahead.current.at < 700 ? typeahead.current.text : ""}${event.key}`.toLowerCase();
      typeahead.current = { text, at: now };
      const found = options.findIndex((option) => (option || defaultLabel).toLowerCase().startsWith(text));
      if (found >= 0) { event.preventDefault(); setActive(found); }
    }
  };
  return <div className="model-picker" ref={root}>
    <button ref={button} type="button" className="composer-tool" aria-haspopup="listbox" aria-expanded={open} aria-label={`model: ${label}`} title={label} onClick={() => setOpen(!open)}>{label}</button>
    {open ? <div role="listbox" aria-label="model" tabIndex={0} aria-activedescendant={`${listId}-${active}`} onKeyDown={key} onBlur={(event) => { if (!root.current?.contains(event.relatedTarget)) setOpen(false); }}>
      {options.map((model, index) => <button id={`${listId}-${index}`} tabIndex={-1} type="button" role="option" aria-selected={model === value} data-active={index === active || undefined} key={model || "default"} onClick={() => { onChange(model); close(); }}>{model || defaultLabel}</button>)}
    </div> : null}
  </div>;
}

/**
 * The run's model and approval mode, from zeta. A blank run has no session yet: it shows zeta's catalog and the mode
 * the first send starts the run with (`nextRunModel`, then `set_settings` for YOLO).
 */
export function RunSettings({ available, deliveries, sessionId, createdWithDefault, running, store, runId }: { available: boolean; deliveries: DeliveryManager; sessionId: string | null; createdWithDefault: boolean; running: boolean; store: RunStateStore; runId: string }) {
  const record = useSyncExternalStore(store.subscribe, () => store.get(runId));
  const catalogState = useSyncExternalStore(store.subscribe, store.getCatalog);
  const settings = record.settings;
  const shown = sessionId ? (settings.pending ? settings.desired : settings.loaded ?? settings.desired) : settings.desired;
  const shownModel = settings.error && sessionId ? settings.loaded?.model : shown?.model;
  const selected = shownModel && shownModel !== record.model.resolvedDefault ? shownModel : "";
  const yolo = (settings.error && sessionId ? settings.loaded : shown)?.approval_mode === "allow";
  const [confirmYolo, setConfirmYolo] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const approvalButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!available) return;
    void deliveries.loadCatalog(sessionId).catch(() => {});
    if (sessionId) void deliveries.loadSettings(sessionId).catch(() => {});
  }, [available, deliveries, sessionId]);
  useEffect(() => {
    if (!sessionId || running || !record.model.deferred) return;
    void deliveries.changeSettings(sessionId, {}).then(() => store.setModelDeferred(runId, false)).catch(() => {});
  }, [deliveries, running, record.model.deferred, runId, sessionId, store]);
  useEffect(() => {
    if (sessionId && settings.loaded?.model) store.resolveDefault(runId, settings.loaded.model, createdWithDefault);
  }, [sessionId, settings.loaded?.model, store, runId, createdWithDefault]);
  const closeConfirm = useCallback(() => { setConfirmYolo(false); approvalButton.current?.focus(); }, []);
  useDismiss(confirmYolo, confirmRef, closeConfirm);
  useEffect(() => { if (confirmYolo) confirmRef.current?.querySelector<HTMLButtonElement>("button[data-safe]")?.focus(); }, [confirmYolo]);
  if (!available || catalogState.catalogError?.includes("-32601")) return null;
  const change = (patch: import("./run-state").SessionSettings) => {
    if (!sessionId) { store.desireSettings(runId, patch); return; }
    if (running) { store.desireSettings(runId, patch); store.setModelDeferred(runId, true); return; }
    void deliveries.changeSettings(sessionId, patch).catch(() => {});
  };
  const pick = (model: string) => {
    if (model) localStorage.setItem(MODEL, model); else localStorage.removeItem(MODEL);
    if (!sessionId) { store.setModel(runId, model ? { choice: "explicit", model } : { choice: "default" }); return; }
    const target = model || record.model.resolvedDefault;
    if (target) change({ model: target });
  };
  const toggle = () => { if (!yolo) setConfirmYolo(true); else change({ approval_mode: "ask" }); };
  const confirmAllow = () => { closeConfirm(); change({ approval_mode: "allow" }); };
  return (
    <>
      <ModelPicker value={selected} models={[...(catalogState.modelCatalog?.models ?? [])]} resolvedDefault={sessionId ? record.model.resolvedDefault : undefined} allowDefault={!sessionId || Boolean(record.model.resolvedDefault)} onChange={pick} />
      <button ref={approvalButton} type="button" className="composer-tool approval-mode" data-yolo={yolo || undefined} aria-pressed={yolo} aria-label={yolo ? "approval mode: YOLO, tools run without asking" : "approval mode: Ask, tools ask before they run"} title={yolo ? "tools run without asking · press to ask again" : "tools ask before they run · press for YOLO"} onClick={toggle}>
        {yolo ? "YOLO" : "Ask"}
      </button>
      {record.model.deferred ? <span className="model-deferred" role="status">settings apply to the next turn</span> : null}
      {settings.error ? <span className="settings-error" role="alert" title={settings.error}>{settings.error}</span> : null}
      {confirmYolo ? <div ref={confirmRef} className="yolo-confirm" role="dialog" aria-modal="true" aria-label="enable YOLO mode">
        <strong>run tools without asking?</strong><span>commands can change files and run programs.</span>
        <div><button type="button" className="ghost" data-safe onClick={closeConfirm}>cancel</button><button type="button" className="danger" onClick={confirmAllow}>allow</button></div>
      </div> : null}
    </>
  );
}

export function SettingsMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setOpen(false); button.current?.focus(); }, []);
  useDismiss(open, root, close);
  useEffect(() => { if (open) root.current?.querySelector<HTMLElement>(".settings-popover button")?.focus(); }, [open]);
  return (
    <div className="settings-menu" ref={root}>
      <button ref={button} type="button" className="ghost" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>settings</button>
      {open ? <div className="settings-popover" role="dialog" aria-label="settings">{children}</div> : null}
    </div>
  );
}

export function VimToggle({ on, onChange }: { on: boolean; onChange(value: boolean): void }) {
  return (
    <button type="button" className="ghost vim-toggle" aria-pressed={on} onClick={() => onChange(!on)}>
      <span>vim keys</span>
      <span className="vim-state">{on ? "on" : "off"}</span>
    </button>
  );
}
