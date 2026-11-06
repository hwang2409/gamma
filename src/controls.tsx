import type { ZetaClient } from "@fulcrum/zeta";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { catalogModels, catalogProviders, settingModel, settingsRequest, type SessionSettings } from "./settings";

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

/** Vim keys in the composer: on unless turned off, kept in localStorage. */
export function useVimSetting() {
  const [on, setOn] = useState(() => localStorage.getItem(VIM) !== "off");
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

function ModelPicker({ value, models, onChange }: { value: string; models: string[]; onChange(value: string): void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const options = ["", ...models.filter((model) => model !== "")];
  const label = value ? value : "default (claude-opus-4-6)";
  const close = useCallback(() => { setOpen(false); button.current?.focus(); }, []);
  useDismiss(open, root, close);
  useEffect(() => { if (open) { setActive(Math.max(0, options.indexOf(value))); root.current?.querySelector<HTMLElement>("[role=listbox]")?.focus(); } }, [open, value]);
  const key = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((item) => Math.min(options.length - 1, item + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((item) => Math.max(0, item - 1)); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(options.length - 1); }
    else if (event.key === "Enter") { event.preventDefault(); onChange(options[active] ?? ""); close(); }
  };
  return <div className="model-picker" ref={root}>
    <button ref={button} type="button" className="composer-tool" aria-haspopup="listbox" aria-expanded={open} aria-label={`model: ${label}`} title={label} onClick={() => setOpen(!open)}>{label}</button>
    {open ? <div role="listbox" aria-label="model" tabIndex={0} onKeyDown={key}>
      {options.map((model, index) => <button type="button" role="option" aria-selected={model === value} data-active={index === active || undefined} key={model || "default"} onClick={() => { onChange(model); close(); }}>{model || "default (claude-opus-4-6)"}</button>)}
    </div> : null}
  </div>;
}

/**
 * The run's model and approval mode, from zeta. A blank run has no session yet: it shows zeta's catalog and the mode
 * the first send starts the run with (`nextRunModel`, then `set_settings` for YOLO).
 */
export function RunSettings({ client, sessionId, yolo, onYolo }: { client: ZetaClient | null; sessionId: string | null; yolo: boolean; onYolo(value: boolean): void }) {
  // zeta lists these methods under hello's `requests`, which fulcrum's client does not expose, so a request tells:
  // only "method not found" hides the controls.
  const [unsupported, setUnsupported] = useState(false);
  const [settings, setSettings] = useState<SessionSettings>({});
  const [models, setModels] = useState<string[]>(() => cachedCatalog().models);
  const [pending, setPending] = useState(() => nextRunModel().model ?? "");
  const [error, setError] = useState("");
  const [confirmYolo, setConfirmYolo] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    if (!client) return;
    try {
      // New zeta servers serve the catalog from the connected controller, even before a session exists.
      const catalog = await client.request("model_catalog", sessionId ? { session_id: sessionId } : {}, { timeoutMs: 15_000 });
      localStorage.setItem(CATALOG, JSON.stringify(catalog));
      setModels(catalogModels(catalog));
    } catch (cause) {
      if ((cause as { code?: unknown }).code === -32601) { setUnsupported(true); return; }
      if (!sessionId) return;
    }
    if (sessionId) {
      try {
        const next = settingModel(await client.request("session_settings", { session_id: sessionId }, { timeoutMs: 15_000 }));
        setSettings(next);
        onYolo(next.approval_mode === "allow");
      } catch (cause) { setError(cause instanceof Error ? cause.message : "settings unavailable"); }
    }
  }, [client, sessionId, onYolo]);
  useEffect(() => { setError(""); void load(); }, [load]);
  useEffect(() => {
    if (!confirmYolo) return;
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setConfirmYolo(false); } };
    addEventListener("keydown", onKey); return () => removeEventListener("keydown", onKey);
  }, [confirmYolo]);
  if (!client || unsupported) return null;
  const change = async (patch: Partial<SessionSettings>) => {
    setError("");
    try {
      await client.request("set_settings", { session_id: sessionId, ...settingsRequest(settings, patch) });
      if (patch.model) localStorage.setItem(MODEL, patch.model);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "could not change settings"); }
  };
  const pick = (model: string) => {
    if (sessionId) return void change({ model });
    localStorage.setItem(MODEL, model);
    setPending(model);
  };
  const toggle = () => {
    if (!yolo) { setConfirmYolo(true); requestAnimationFrame(() => confirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus()); return; }
    if (sessionId) void change({ approval_mode: "ask" });
    else onYolo(false);
  };
  const confirmAllow = () => { setConfirmYolo(false); if (sessionId) void change({ approval_mode: "allow" }); else onYolo(true); };
  return (
    <>
      <ModelPicker value={sessionId ? settings.model ?? "" : pending} models={models} onChange={pick} />
      <button
        type="button"
        className="composer-tool approval-mode"
        data-yolo={yolo || undefined}
        aria-pressed={yolo}
        aria-label={yolo ? "approval mode: YOLO, tools run without asking" : "approval mode: Ask, tools ask before they run"}
        title={yolo ? "tools run without asking · press to ask again" : "tools ask before they run · press for YOLO"}
        onClick={toggle}
      >
        {yolo ? "YOLO" : "Ask"}
      </button>
      {error ? <span className="settings-error" role="alert" title={error}>{error}</span> : null}
      {confirmYolo ? <div ref={confirmRef} className="confirm-popover" role="dialog" aria-label="allow tools without asking">
        <p>allow tools to run without asking in this run?</p>
        <div className="actions"><button type="button" className="primary" onClick={confirmAllow}>allow</button><button type="button" className="ghost" onClick={() => setConfirmYolo(false)}>keep asking</button></div>
      </div> : null}
    </>
  );
}

/** The header's settings popover: theme and vim keys. */
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
