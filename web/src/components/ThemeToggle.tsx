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
      <Icon name={ICON[preference]} />
    </button>
  );
}
