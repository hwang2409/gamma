/** A small set of line icons, drawn inline so nothing loads from elsewhere. */

const PATHS = {
  check: "M3.5 8.5l3 3 6-7",
  x: "M4 4l8 8M12 4l-8 8",
  ban: "M8 14A6 6 0 108 2a6 6 0 000 12zM3.8 3.8l8.4 8.4",
  pause: "M6 4v8M10 4v8",
  chevronRight: "M6 3.5L10.5 8 6 12.5",
  chevronDown: "M3.5 6L8 10.5 12.5 6",
  chevronLeft: "M10 3.5L5.5 8l4.5 4.5",
  arrowUp: "M8 13V3M3.5 7.5L8 3l4.5 4.5",
  arrowDown: "M8 3v10M3.5 8.5L8 13l4.5-4.5",
  copy: "M5.5 5.5V3.5a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1h-2M2.5 6.5a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1h-6a1 1 0 01-1-1z",
  sun: "M8 11a3 3 0 100-6 3 3 0 000 6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1",
  moon: "M13.5 9.5A6 6 0 016.5 2.5a6 6 0 107 7z",
  monitor: "M2 3h12v8H2zM6 14h4M8 11v3",
  shield: "M8 1.8l5 2v4c0 3.2-2.2 5.4-5 6.4-2.8-1-5-3.2-5-6.4v-4z",
  steer: "M3 8h8M8 4.5L11.5 8 8 11.5M13.5 3.5v9",
  alert: "M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5v.5",
  plus: "M8 3v10M3 8h10",
  folder: "M2 4.5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1z",
  box: "M8 1.8L13.5 4.9v6.2L8 14.2 2.5 11.1V4.9zM2.7 5L8 8l5.3-3M8 8v6",
  clock: "M8 14A6 6 0 108 2a6 6 0 000 12zM8 5v3.2l2 1.3",
  inbox: "M2.5 9.5L4 4h8l1.5 5.5M2.5 9.5V12a1 1 0 001 1h9a1 1 0 001-1V9.5M2.5 9.5h3l1 1.5h3l1-1.5h3",
} as const;

export type IconName = keyof typeof PATHS;

interface Props {
  name: IconName;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 16, className }: Props): React.JSX.Element {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** An indeterminate ring for work in progress. Still under reduced motion. */
export function Spinner({ size = 14 }: { size?: number }): React.JSX.Element {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}
