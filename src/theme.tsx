import { themes, type ThemeName } from "@fulcrum/react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

export const AUTO = "auto";
export type ThemeChoice = ThemeName | typeof AUTO;
const KEY = "fulcrum-web-theme";
const choices: readonly ThemeChoice[] = [AUTO, ...themes];
// Swatches: bg, fg, accent, ok, warn, danger, then three syntax colors. Drawn under each option's own theme.
const swatches = ["bg", "fg", "accent", "ok", "warn", "danger", "tok-keyword", "tok-string", "tok-function"];

const stored = (): ThemeChoice => {
  const value = new URLSearchParams(location.search).get("theme") ?? localStorage.getItem(KEY);
  return value && (choices as readonly string[]).includes(value) ? (value as ThemeChoice) : AUTO;
};

/** The active theme on `<html>`, kept in localStorage; `?theme=` overrides it (screenshots and links). */
export function useTheme() {
  const [theme, setTheme] = useState<ThemeChoice>(stored);
  useLayoutEffect(() => {
    if (theme === AUTO) delete document.documentElement.dataset.fulcrumTheme;
    else document.documentElement.dataset.fulcrumTheme = theme;
    localStorage.setItem(KEY, theme);
  }, [theme]);
  return [theme, setTheme] as const;
}

function Swatch({ theme }: { theme: ThemeChoice }) {
  return (
    <span className="swatch" aria-hidden="true" data-fulcrum-theme={theme === AUTO ? undefined : theme}>
      {swatches.map((name) => <span key={name} style={{ background: `var(--fulcrum-${name})` }} />)}
    </span>
  );
}

/** A listbox popup, not a native select: arrows, Home, End, Enter, and Escape; it opens on the current theme. */
export function ThemePicker({ theme, onChange }: { theme: ThemeChoice; onChange(theme: ThemeChoice): void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => choices.indexOf(theme));
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => { if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active, id, open]);
  const show = () => { setActive(choices.indexOf(theme)); setOpen(true); };
  const close = (focus = true) => { setOpen(false); if (focus) button.current?.focus(); };
  const pick = (index: number) => { onChange(choices[index]!); close(); };
  const onKey = (event: KeyboardEvent) => {
    const last = choices.length - 1;
    const moves: Record<string, number> = { ArrowDown: Math.min(last, active + 1), ArrowUp: Math.max(0, active - 1), Home: 0, End: last };
    if (event.key in moves) { event.preventDefault(); setActive(moves[event.key]!); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick(active); }
    else if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "Tab") close(false);
  };
  return (
    <div className="theme-picker" ref={root}>
      <button
        ref={button}
        type="button"
        className="theme-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); } }}
      >
        <span className="theme-label">theme</span>
        <span className="theme-name">{theme}</span>
        <Swatch theme={theme} />
      </button>
      {open ? (
        <ul
          ref={list}
          id={`${id}-list`}
          className="theme-list"
          role="listbox"
          tabIndex={-1}
          aria-label="theme"
          aria-activedescendant={`${id}-${active}`}
          onKeyDown={onKey}
        >
          {choices.map((choice, index) => (
            <li
              key={choice}
              id={`${id}-${index}`}
              role="option"
              aria-selected={choice === theme}
              data-active={index === active || undefined}
              onPointerMove={() => setActive(index)}
              onClick={() => pick(index)}
            >
              <span>{choice === AUTO ? "auto (github, follows the OS)" : choice}</span>
              {choice === AUTO ? null : <Swatch theme={choice} />}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
