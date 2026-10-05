/**
 * Tool calls: one ledger line each on the spine, grouped when they run back
 * to back.
 *
 * A line reads `bash  pytest -q            1.2s`, with a node whose shape
 * says the state. It opens in place to the full arguments and output. A
 * failed call shows the first line of its error without opening. A finished
 * group of several calls folds into one summary line; failed calls stay
 * visible.
 */

import { useState } from "react";

import { formatSeconds, toolTarget } from "../lib/format";
import { languageForPath } from "../lib/highlight";
import type { ToolPhase } from "../lib/transcript";
import { toolSeconds, type ToolGroup as Group, type ToolRow as Row } from "../lib/view";
import { CollapsibleText } from "./Collapsible";
import { Icon } from "./Icon";
import { Node, type NodeKind } from "./Node";
import { Reveal } from "./Reveal";

const FOLD_AT = 4;

const PHASE_LABEL: Record<ToolPhase, string> = {
  awaiting_approval: "needs approval",
  running: "running",
  done: "done",
  error: "failed",
  denied: "denied",
};

const PHASE_NODE: Record<ToolPhase, NodeKind> = {
  awaiting_approval: "waiting",
  running: "live",
  done: "done",
  error: "error",
  denied: "denied",
};

/** Tools whose output is the content of the file named by `path`. */
const FILE_OUTPUT_TOOLS = new Set(["read", "read_file", "cat", "view"]);

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
          className="tool-line tool-group-head"
          aria-expanded={!folded}
          onClick={() => setUnfolded(!unfolded)}
        >
          <Node kind="done" className="is-stack" />
          <span className="tool-summary">
            {group.rows.length} tool calls
            {failed.length > 0 && <strong>, {failed.length} failed</strong>}
          </span>
          <span className="tool-meta">
            <span className="tool-duration">{formatSeconds(seconds)}</span>
          </span>
          <Icon name="chevronRight" size={14} className="chevron" />
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
  const path = typeof row.args.path === "string" ? row.args.path : null;
  const outputLanguage =
    row.phase !== "error" && FILE_OUTPUT_TOOLS.has(row.name) ? languageForPath(path) : null;

  return (
    <li className={`tool-row phase-${row.phase}`}>
      <button
        type="button"
        className="tool-line"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen(!open)}
      >
        <Node kind={PHASE_NODE[row.phase]} />
        <span className="tool-name">{row.name}</span>
        <span className="tool-target">{target}</span>
        <span className="tool-meta">
          {decision !== null && <span className="tool-decision">{decision}</span>}
          {row.phase === "awaiting_approval" || row.phase === "denied" || row.phase === "error" ? (
            <span className="tool-phase">{PHASE_LABEL[row.phase]}</span>
          ) : (
            <span className="visually-hidden">{PHASE_LABEL[row.phase]}</span>
          )}
          {tool !== null && row.phase !== "denied" && row.phase !== "awaiting_approval" && (
            <span className="tool-duration">{formatSeconds(toolSeconds(tool, now))}</span>
          )}
        </span>
        <Icon name="chevronRight" size={14} className="chevron" />
      </button>
      {errorLine !== "" && (
        <p className="tool-error-line" hidden={open}>
          {errorLine}
        </p>
      )}
      <Reveal open={open} id={detailsId}>
        <div className="tool-well">
          <ToolArguments args={row.args} />
          {output !== "" ? (
            <CollapsibleText
              className={row.phase === "error" ? "tool-output is-error" : "tool-output"}
              text={output}
              lines={16}
              language={outputLanguage}
            />
          ) : (
            <p className="tool-empty">
              {row.phase === "running" ? "Waiting for output…" : "No output."}
            </p>
          )}
        </div>
      </Reveal>
    </li>
  );
}

function ToolArguments({ args }: { args: Record<string, unknown> }): React.JSX.Element | null {
  const entries = Object.entries(args);
  if (entries.length === 0) {
    return null;
  }
  const path = typeof args.path === "string" ? args.path : null;
  return (
    <dl className="tool-args">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            <CollapsibleText
              text={typeof value === "string" ? value : JSON.stringify(value, null, 2)}
              lines={8}
              language={
                typeof value !== "string"
                  ? "json"
                  : key === "content" || key.endsWith("_string")
                    ? languageForPath(path)
                    : null
              }
            />
          </dd>
        </div>
      ))}
    </dl>
  );
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
