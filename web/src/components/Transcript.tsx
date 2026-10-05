/**
 * The transcript: user turns, assistant text, tool call groups, notices.
 * Pending approvals are not here; the session page pins them above the
 * composer.
 */

import type { Block } from "../lib/view";
import { CollapsibleText } from "./Collapsible";
import { Icon } from "./Icon";
import { SafeMarkdown } from "./SafeMarkdown";
import { ToolGroup } from "./ToolGroup";

interface Props {
  blocks: Block[];
  /** Epoch seconds, for live durations. */
  now: number;
}

export function Transcript({ blocks, now }: Props): React.JSX.Element {
  if (blocks.length === 0) {
    return (
      <div className="transcript-empty">
        <p className="empty-title">New session</p>
        <p className="empty-body">
          Describe a task. zeta works in this directory and asks before it runs anything that
          needs approval.
        </p>
      </div>
    );
  }
  return (
    <div className="transcript" role="log" aria-label="conversation">
      {blocks.map((block) => {
        switch (block.kind) {
          case "user":
            return (
              <article key={block.id} className={`turn-user mode-${block.item.mode}`}>
                <h2 className="visually-hidden">
                  {block.item.mode === "steer" ? "You steered" : "You"}
                </h2>
                {block.item.mode === "steer" && (
                  <span className="steer-label">
                    <Icon name="steer" size={12} /> Steer
                  </span>
                )}
                <CollapsibleText text={block.item.text} lines={14} mono={false} />
              </article>
            );
          case "assistant":
            return (
              <article
                key={block.id}
                className={block.item.streaming ? "turn-assistant is-streaming" : "turn-assistant"}
                aria-busy={block.item.streaming}
              >
                <h2 className="visually-hidden">zeta</h2>
                {block.item.thinking !== "" && (
                  <details className="thinking">
                    <summary>Thinking</summary>
                    <CollapsibleText text={block.item.thinking} lines={20} mono={false} />
                  </details>
                )}
                {block.item.text !== "" ? (
                  <SafeMarkdown text={block.item.text} />
                ) : (
                  block.item.streaming && <span className="caret" aria-hidden="true" />
                )}
              </article>
            );
          case "tools":
            return <ToolGroup key={block.id} group={block} now={now} />;
          case "notice":
            return (
              <p
                key={block.id}
                className={`notice notice-${block.item.level}`}
                role={block.item.level === "error" ? "alert" : undefined}
              >
                {block.item.level === "error" && <Icon name="alert" size={14} />}
                {block.item.text}
              </p>
            );
        }
      })}
    </div>
  );
}
