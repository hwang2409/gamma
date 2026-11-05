import type { ZetaClient } from "@fulcrum/zeta";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setOpen(false); button.current?.focus(); }, []);
  useDismiss(open, root, close);
  useEffect(() => { if (open) root.current?.querySelector<HTMLElement>("[aria-selected=true], [role=option]")?.focus(); }, [open]);
  return (
    <div className="model-picker" ref={root}>
      <button ref={button} type="button" className="composer-tool" aria-haspopup="listbox" aria-expanded={open} aria-label={`model: ${value || "default"}`} onClick={() => setOpen(!open)}>
        {value || "default model"}
      </button>
      {open ? (
        <div role="listbox" aria-label="model">
          {models.map((model) => (
            <button type="button" role="option" aria-selected={model === value} key={model} onClick={() => { onChange(model); close(); }}>{model}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The run's model and approval mode, from zeta. A blank run has no session to ask yet, so it offers the catalog the
 * last run saw and passes the pick to `new_session`.
 */
export function RunSettings({ client, sessionId, onYolo }: { client: ZetaClient | null; sessionId: string | null; onYolo(value: boolean): void }) {
  const supported = (name: string) => client?.features.includes(name) ?? false;
  const [settings, setSettings] = useState<SessionSettings>({});
  const [models, setModels] = useState<string[]>(() => cachedCatalog().models);
  const [pending, setPending] = useState(() => nextRunModel().model ?? "");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!client || !sessionId) return;
    try {
      if (client.features.includes("session_settings")) {
        const next = settingModel(await client.request("session_settings", { session_id: sessionId }));
        setSettings(next);
        onYolo(next.approval_mode === "allow");
      } else onYolo(false);
      if (client.features.includes("model_catalog")) {
        const catalog = await client.request("model_catalog", { session_id: sessionId });
        localStorage.setItem(CATALOG, JSON.stringify(catalog));
        setModels(catalogModels(catalog));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "settings unavailable"); }
  }, [client, sessionId, onYolo]);
  useEffect(() => { setError(""); void load(); }, [load]);
  useEffect(() => { if (!sessionId) onYolo(false); }, [sessionId, onYolo]);
  if (!client) return null;
  if (!sessionId) {
    if (!supported("model_catalog") || !models.length) return null;
    return <ModelPicker value={pending} models={models} onChange={(model) => { localStorage.setItem(MODEL, model); setPending(model); }} />;
  }
  const change = async (patch: Partial<SessionSettings>) => {
    setError("");
    try {
      await client.request("set_settings", { session_id: sessionId, ...settingsRequest(settings, patch) });
      if (patch.model) localStorage.setItem(MODEL, patch.model);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "could not change settings"); }
  };
  const yolo = settings.approval_mode === "allow";
  return (
    <>
      {supported("model_catalog") && models.length ? <ModelPicker value={settings.model ?? ""} models={models} onChange={(model) => void change({ model })} /> : null}
      {supported("set_settings") ? (
        <button
          type="button"
          className="composer-tool approval-mode"
          data-yolo={yolo || undefined}
          aria-pressed={yolo}
          title={yolo ? "tools run without asking · press to ask again" : "tools ask before they run · press for YOLO"}
          onClick={() => { if (!yolo && !confirm("allow tools to run automatically in this run?")) return; void change({ approval_mode: yolo ? "ask" : "allow" }); }}
        >
          {yolo ? "YOLO" : "Ask"}
        </button>
      ) : null}
      {error ? <span className="settings-error" role="alert" title={error}>{error}</span> : null}
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
