import { useEffect, useState } from "react";

/** The current time in epoch seconds, refreshed while `live` is true. */
export function useNow(live: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!live) {
      return;
    }
    setNow(Date.now() / 1000);
    const timer = window.setInterval(() => setNow(Date.now() / 1000), intervalMs);
    return () => window.clearInterval(timer);
  }, [live, intervalMs]);
  return now;
}
