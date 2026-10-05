import { useEffect, useState } from "react";

/**
 * Keep the last value on screen for a short exit after it goes away.
 *
 * Returns the value to render and whether it is leaving. A new value replaces
 * a leaving one at once. The exit time should match the CSS exit duration.
 */
export function usePresence<T>(value: T | undefined, exitMs: number): {
  shown: T | undefined;
  leaving: boolean;
} {
  const [last, setLast] = useState(value);
  if (value !== undefined && value !== last) {
    setLast(value);
  }
  const leaving = value === undefined && last !== undefined;

  useEffect(() => {
    if (!leaving) {
      return;
    }
    const timer = window.setTimeout(() => setLast(undefined), exitMs);
    return () => window.clearTimeout(timer);
  }, [leaving, exitMs]);

  return { shown: value ?? last, leaving };
}
