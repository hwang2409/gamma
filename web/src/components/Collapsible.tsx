/**
 * Long plain text, shown in part until the reader asks for the rest.
 * The cut is by lines, so nothing has to be measured.
 */

import { useState } from "react";

interface Props {
  text: string;
  /** Lines shown while collapsed. */
  lines?: number;
  className?: string;
  /** Render as preformatted text (tool output) or as wrapped prose. */
  mono?: boolean;
}

export function CollapsibleText({ text, lines = 12, className, mono = true }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const all = text.replace(/\n+$/, "").split("\n");
  const hidden = all.length - lines;
  const shown = open || hidden <= 2 ? all.join("\n") : all.slice(0, lines).join("\n");
  const Tag = mono ? "pre" : "p";
  return (
    <div className={className ? `collapsible ${className}` : "collapsible"}>
      <Tag className={open || hidden <= 2 ? undefined : "faded"}>{shown}</Tag>
      {hidden > 2 && (
        <button
          type="button"
          className="more-button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Show less" : `Show ${hidden} more lines`}
        </button>
      )}
    </div>
  );
}
