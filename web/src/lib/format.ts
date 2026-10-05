/** Small, pure formatters for the UI: tool summaries, paths, times, counts. */

/** Argument keys that best describe a tool call, most specific first. */
const KEY_ARGS = [
  "command",
  "path",
  "file_path",
  "url",
  "query",
  "pattern",
  "name",
  "handle",
  "task_id",
  "prompt",
] as const;

/**
 * One line for a tool call: the tool name and its most telling argument,
 * for example `bash` + `pytest -q` or `read` + `src/app.py`.
 */
export function toolTarget(args: Record<string, unknown>): string {
  for (const key of KEY_ARGS) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") {
      return firstLine(value);
    }
  }
  const first = Object.entries(args)[0];
  if (first === undefined) {
    return "";
  }
  const [key, value] = first;
  return `${key}=${firstLine(typeof value === "string" ? value : (JSON.stringify(value) ?? ""))}`;
}

function firstLine(value: string): string {
  const line = value.trim().split("\n", 1)[0] ?? "";
  return line.length < value.trim().length ? `${line} …` : line;
}

/**
 * A path short enough for a status line: the home directory becomes `~`
 * and long paths keep their last segments.
 */
export function shortPath(path: string | null | undefined, keep = 3): string {
  if (!path) {
    return "";
  }
  const home = /^\/(?:Users|home)\/[^/]+/.exec(path);
  const rest = home ? `~${path.slice(home[0].length)}` : path;
  const parts = rest.split("/").filter((part) => part !== "");
  if (parts.length <= keep + 1) {
    return rest;
  }
  return `…/${parts.slice(-keep).join("/")}`;
}

/** `0.4s`, `12s`, `3m 05s`, `1h 02m`. */
export function formatSeconds(seconds: number): string {
  if (seconds < 10) {
    return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  }
  const whole = Math.floor(seconds);
  if (whole < 60) {
    return `${whole}s`;
  }
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `950`, `1.2k`, `34k`, `1.5M`. */
export function formatCount(value: number): string {
  if (value < 1000) {
    return String(value);
  }
  if (value < 10_000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** `just now`, `5m ago`, `3h ago`, `2d ago`, then a date. Times are epoch ms. */
export function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** True on Apple platforms, where the command key is the modifier. */
export function isApple(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** The modifier key label for shortcut hints. */
export function modKey(): string {
  return isApple() ? "⌘" : "Ctrl+";
}
