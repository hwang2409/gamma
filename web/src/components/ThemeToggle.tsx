/** One button that cycles the theme: system, light, dark. */

import { useTheme, type ThemePreference } from "../lib/theme";
import { Icon, type IconName } from "./Icon";

const ICON: Record<ThemePreference, IconName> = {
  system: "monitor",
  light: "sun",
  dark: "moon",
};

const NEXT: Record<ThemePreference, string> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const ORDER: ThemePreference[] = ["system", "light", "dark"];

export function ThemeToggle(): React.JSX.Element {
  const { preference, cycle } = useTheme();
  return (
    <button
      type="button"
      className="icon-button"
      onClick={cycle}
      aria-label={`Theme: ${preference}. Switch to ${NEXT[preference]}.`}
      title={`Theme: ${preference}`}
    >
      {/* All three icons stay mounted and cross-fade. */}
      <span className="icon-stack">
        {ORDER.map((name) => (
          <span key={name} className="icon-stack-item" data-on={name === preference}>
            <Icon name={ICON[name]} />
          </span>
        ))}
      </span>
    </button>
  );
}
