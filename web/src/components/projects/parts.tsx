/**
 * Small shared pieces for the project views: an id you can copy, a quiet
 * badge, the loading / error / "update Zeta" states, and time formatting.
 *
 * Meaning stays in weight, fill, and shape — the same greyscale language as
 * the rest of gamma — so nothing here introduces a hue.
 */

import { useEffect, useState } from "react";

import { relativeTime } from "../../lib/format";
import type { Resource } from "../../lib/useResource";
import { Icon, Spinner } from "../Icon";
import { Node } from "../Node";

/** A short, monospaced id with a copy button; the name leads, the id trails. */
export function IdChip({ id, label = "id" }: { id: string; label?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="id-chip"
      title={`Copy ${label}`}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(id).then(() => setCopied(true));
      }}
    >
      <span className="mono id-chip-text">{id}</span>
      <span className="icon-swap" data-on={copied} aria-hidden="true">
        <Icon name="check" size={12} className="swap-on" />
        <Icon name="copy" size={12} className="swap-off" />
      </span>
    </button>
  );
}

/** A quiet pill for a role, kind, or status. `tone="warn"` adds the ring. */
export function Badge({
  children,
  tone = "plain",
}: {
  children: React.ReactNode;
  tone?: "plain" | "strong" | "warn";
}): React.JSX.Element {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** Render a resource's non-ready states, or hand the data to `children`. */
export function ViewState<T>({
  resource,
  children,
}: {
  resource: Resource<T>;
  children: (data: T) => React.ReactNode;
}): React.JSX.Element {
  switch (resource.status) {
    case "loading":
      return (
        <p className="view-state">
          <Spinner size={13} /> Loading…
        </p>
      );
    case "unsupported":
      return (
        <div className="view-state view-state-block">
          <p className="view-state-title">
            <Node kind="info" />
            This Zeta does not serve projects yet
          </p>
          <p className="view-state-help">
            The projects view needs a newer Zeta. Update the <code>zeta</code> on this machine,
            then reload.
          </p>
        </div>
      );
    case "error":
      return (
        <p className="view-state view-state-error" role="alert">
          <Node kind="error" />
          {resource.message}
        </p>
      );
    case "ready":
      return <>{children(resource.data)}</>;
  }
}

/** An ISO timestamp as "5m ago", with the full local time in the tooltip. */
export function Time({ iso, now }: { iso: string | null; now: number }): React.JSX.Element {
  if (!iso) {
    return <span className="dim">—</span>;
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return <span className="dim">{iso}</span>;
  }
  return (
    <time dateTime={iso} title={new Date(ms).toLocaleString()}>
      {relativeTime(ms, now)}
    </time>
  );
}
