/**
 * Theme preference: follow the system, or force light or dark.
 *
 * The choice is stored in localStorage and applied as `data-theme` on
 * <html>; tokens.css does the rest. index.html applies the stored value
 * before first paint so the page never flashes the wrong theme.
 */

import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

const KEY = "gamma.theme";
const ORDER: ThemePreference[] = ["system", "light", "dark"];

function stored(): ThemePreference {
  const value = window.localStorage.getItem(KEY);
  return value === "light" || value === "dark" ? value : "system";
}

function apply(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", preference);
  }
}

export function useTheme(): { preference: ThemePreference; cycle: () => void } {
  const [preference, setPreference] = useState<ThemePreference>(stored);

  useEffect(() => {
    apply(preference);
    if (preference === "system") {
      window.localStorage.removeItem(KEY);
    } else {
      window.localStorage.setItem(KEY, preference);
    }
  }, [preference]);

  const cycle = useCallback(() => {
    setPreference((current) => ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? "system");
  }, []);

  return { preference, cycle };
}
