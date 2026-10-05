/**
 * The model's thinking, kept quiet: one ash line that shows the latest
 * sentence while it streams, and opens on demand into the full text.
 */

import { useState } from "react";

import { Icon } from "./Icon";
import { Reveal } from "./Reveal";

interface Props {
  id: string;
  text: string;
  /** True while thinking still streams and no answer has started. */
  live: boolean;
}

export function Thinking({ id, text, live }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const lines = text.trim().split("\n").filter((line) => line.trim() !== "");
  const preview = (live ? lines.at(-1) : lines[0]) ?? "";
  return (
    <div className={live ? "thinking is-live" : "thinking"}>
      <button
        type="button"
        className="thinking-line"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span className="thinking-label">{live ? "Thinking" : "Thought"}</span>
        {!open && <span className="thinking-preview">{preview}</span>}
        <Icon name="chevronRight" size={14} className="chevron" />
      </button>
      <Reveal open={open} id={id}>
        <p className="thinking-text">{text.trim()}</p>
      </Reveal>
    </div>
  );
}
