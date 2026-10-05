/**
 * Tool calls: one compact row each, grouped when they run back to back.
 *
 * A row reads `bash  pytest -q   1.2s ✓`. It expands to the full arguments
 * and output. A failed call shows the first line of its error without
 * expanding. A finished group of more than a few calls folds into one
 * summary line, but failed calls stay visible.
 */

import { useState } from "react";

import { formatSeconds, toolTarget } from "../lib/format";
import type { ToolPhase } from "../lib/transcript";
import { toolSeconds, type ToolGroup as Group, type ToolRow as Row } from "../lib/view";
import { CollapsibleText } from "./Collapsible";
import { Icon, Spinner } from "./Icon";

const FOLD_AT = 4;

const PHASE_LABEL: Record<ToolPhase, string> = {
  awaiting_approval: "needs approval",
  running: "running",
  done: "done",
  error: "failed",
  denied: "denied",
};

const finished = (row: Row) => row.phase !== "running" && row.phase !== "awaiting_approval";

export function ToolGroup({ group, now }: { group: Group; now: number }): React.JSX.Element {
  const foldable = group.rows.length >= FOLD_AT && group.rows.every(finished);
  const [unfolded, setUnfolded] = useState(false);
  const folded = foldable && !unfolded;
  const failed = group.rows.filter((row) => row.phase === "error");
  const seconds = group.rows.reduce(
    (total, row) => total + (row.tool ? toolSeconds(row.tool, now) : 0),
    0,
  );
  const visible = folded ? failed : group.rows;

  return (
    <section className="tool-group" aria-label={`${group.rows.length} tool calls`}>
      {foldable && (
        <button
          type="button"
          className="tool-group-head"
          aria-expanded={!folded}
          onClick={() => setUnfolded(!unfolded)}
        >
          <Icon name={folded ? "chevronRight" : "chevronDown"} size={14} className="chevron" />
          <span>
            {group.rows.length} tool calls
            {failed.length > 0 && <span className="danger-text"> · {failed.length} failed</span>}
          </span>
          <span className="tool-duration">{formatSeconds(seconds)}</span>
        </button>
      )}
      {visible.length > 0 && (
        <ul className="tool-rows">
          {visible.map((row) => (
            <ToolRow key={row.id} row={row} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ToolRow({ row, now }: { row: Row; now: number }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const target = toolTarget(row.args);
  const tool = row.tool;
  const output = tool ? (tool.result ?? tool.output) : "";
  const errorLine = row.phase === "error" ? firstLine(output) : "";
  const decision = approvalNote(row);
  const detailsId = `${row.id}-details`;

  return (
    <li className={`tool-row phase-${row.phase}`}>
      <button
        type="button"
        className="tool-line"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen(!open)}
      >
        <PhaseIcon phase={row.phase} />
        <span className="tool-name">{row.name}</span>
        <span className="tool-target">{target}</span>
        <span className="tool-meta">
          {decision !== null && <span className="tool-decision">{decision}</span>}
          {row.phase === "awaiting_approval" || row.phase === "denied" ? (
            <span className="tool-phase">{PHASE_LABEL[row.phase]}</span>
          ) : (
            tool !== null && (
              <span className="tool-duration">{formatSeconds(toolSeconds(tool, now))}</span>
            )
          )}
          <span className="visually-hidden">{PHASE_LABEL[row.phase]}</span>
        </span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} className="chevron" />
      </button>
      {!open && errorLine !== "" && <p className="tool-error-line">{errorLine}</p>}
      {open && (
        <div className="tool-details" id={detailsId}>
          <ToolArguments args={row.args} />
          {output !== "" ? (
            <CollapsibleText
              className={row.phase === "error" ? "tool-output is-error" : "tool-output"}
              text={output}
              lines={16}
            />
          ) : (
            <p className="tool-empty">
              {row.phase === "running" ? "Waiting for output…" : "No output."}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function ToolArguments({ args }: { args: Record<string, unknown> }): React.JSX.Element | null {
  const entries = Object.entries(args);
  if (entries.length === 0) {
    return null;
  }
  return (
    <dl className="tool-args">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            <CollapsibleText
              text={typeof value === "string" ? value : JSON.stringify(value, null, 2)}
              lines={8}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function PhaseIcon({ phase }: { phase: ToolPhase }): React.JSX.Element {
  switch (phase) {
    case "running":
      return (
        <span className="phase-icon">
          <Spinner size={12} />
        </span>
      );
    case "done":
      return <Icon name="check" size={14} className="phase-icon" />;
    case "error":
      return <Icon name="x" size={14} className="phase-icon" />;
    case "denied":
      return <Icon name="ban" size={14} className="phase-icon" />;
    case "awaiting_approval":
      return <Icon name="pause" size={14} className="phase-icon" />;
  }
}

function approvalNote(row: Row): string | null {
  const approval = row.approval;
  if (approval === null || approval.phase === "pending") {
    return null;
  }
  if (approval.phase === "approved") {
    return approval.scope === "always_tool" ? "always allowed" : "approved";
  }
  return approval.phase === "closed" ? "approval closed" : null;
}

function firstLine(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}
