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
      <Icon name={copied ? "check" : "copy"} size={14} />
      <span aria-hidden="true">{copied ? "Copied" : label}</span>
    </button>
  );
}
