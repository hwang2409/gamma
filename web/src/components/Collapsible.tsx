/**
 * Long plain text, shown in part until the reader asks for the rest.
 * The cut is by lines, so nothing has to be measured. Preformatted text can
 * name a language and is then highlighted once the highlighter has loaded.
 */

import { useState } from "react";

import { useHighlight } from "../lib/highlight";

interface Props {
  text: string;
  /** Lines shown while collapsed. */
  lines?: number;
  className?: string;
  /** Render as preformatted text (tool output) or as wrapped prose. */
  mono?: boolean;
  /** highlight.js language for preformatted text. */
  language?: string | null;
}

export function CollapsibleText({
  text,
  lines = 12,
  className,
  mono = true,
  language = null,
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const all = text.replace(/\n+$/, "").split("\n");
  const hidden = all.length - lines;
  const cut = !open && hidden > 2;
  const shown = cut ? all.slice(0, lines).join("\n") : all.join("\n");
  const highlighted = useHighlight(shown, mono ? language : null);
  const Tag = mono ? "pre" : "p";
  return (
    <div className={className ? `collapsible ${className}` : "collapsible"}>
      <Tag className={cut ? "faded" : undefined}>{highlighted ?? shown}</Tag>
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
