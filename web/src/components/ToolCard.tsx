/** One collapsible card per tool call: arguments, live output, and result. */

import { useState } from "react";

import type { ToolItem, ToolPhase } from "../lib/transcript";

const PHASE_LABEL: Record<ToolPhase, string> = {
  awaiting_approval: "waiting for approval",
  running: "running",
  done: "done",
  error: "failed",
  denied: "canceled",
};

export function argumentSummary(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([key, value]) => {
    const rendered =
      typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
    const short = rendered.length > 80 ? `${rendered.slice(0, 80)}...` : rendered;
    return `${key}=${short}`;
  });
  return parts.join(" ");
}

export function ToolCard({ item }: { item: ToolItem }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const body = item.result ?? item.output;
  return (
    <section className={`card tool tool-${item.phase}`} aria-label={`tool ${item.name}`}>
      <button
        type="button"
        className="card-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="tool-name">{item.name}</span>
        <span className="tool-args">{argumentSummary(item.args)}</span>
        <span className="tool-phase">{PHASE_LABEL[item.phase]}</span>
      </button>
      {open && (
        <div className="card-body">
          <h4>Arguments</h4>
          <pre>{JSON.stringify(item.args, null, 2)}</pre>
          {item.output !== "" && (
            <>
              <h4>Output</h4>
              <pre>{item.output}</pre>
            </>
          )}
          {item.result !== null && (
            <>
              <h4>Result</h4>
              <pre>{item.result}</pre>
            </>
          )}
        </div>
      )}
      {!open && body !== "" && <pre className="tool-preview">{body.slice(0, 400)}</pre>}
    </section>
  );
}
