/** Copy text to the clipboard and confirm for a moment. */

import { useEffect, useState } from "react";

import { Icon } from "./Icon";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }): React.JSX.Element {
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
      className="ghost-button small"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
      aria-label={copied ? "Copied" : label}
    >
      {/* Both icons stay mounted and cross-fade, so the change animates both ways. */}
      <span className="icon-swap" data-on={copied}>
        <Icon name="check" size={14} className="swap-on" />
        <Icon name="copy" size={14} className="swap-off" />
      </span>
      <span aria-hidden="true">{copied ? "Copied" : label}</span>
    </button>
  );
}
