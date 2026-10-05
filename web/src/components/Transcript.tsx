/**
 * The transcript as a run ledger: one vertical spine, the task that starts
 * each run set large on it, and every action hanging from it as a node whose
 * shape says its state. Pending approvals are not here; the session page
 * pins them above the composer.
 */

import { shortPath } from "../lib/format";
import type { Block } from "../lib/view";
import { CollapsibleText } from "./Collapsible";
import { Node } from "./Node";
import { SafeMarkdown } from "./SafeMarkdown";
import { Thinking } from "./Thinking";
import { ToolGroup } from "./ToolGroup";

/** A prompt longer than this reads as a brief, not a headline. */
const LONG_TASK_CHARS = 240;

interface Props {
  blocks: Block[];
  /** Epoch seconds, for live durations. */
  now: number;
  /** True while the agent works and nothing shows it yet (no text, no tool). */
  waiting?: boolean;
  /** The session directory, named in the empty state. */
  cwd?: string | null;
}

export function Transcript({ blocks, now, waiting = false, cwd }: Props): React.JSX.Element {
  if (blocks.length === 0) {
    return (
      <div className="transcript-empty">
        <Node kind="task" className="is-hollow" />
        <h2>Describe a task</h2>
        <p>
          zeta works in {cwd ? <code title={cwd}>{shortPath(cwd)}</code> : "this directory"} and
          asks before it runs anything that needs approval.
        </p>
      </div>
    );
  }
  return (
    <div className="transcript" role="log" aria-label="conversation">
      {blocks.map((block) => {
        switch (block.kind) {
          case "user":
            return block.item.mode === "steer" ? (
              <article key={block.id} className="entry entry-steer">
                <Node kind="steer" />
                <h2 className="steer-label">You steered</h2>
                <CollapsibleText text={block.item.text} lines={10} mono={false} />
              </article>
            ) : (
              <article
                key={block.id}
                className={
                  block.item.text.length > LONG_TASK_CHARS ? "entry entry-task is-long" : "entry entry-task"
                }
              >
                <Node kind="task" />
                <h2 className="visually-hidden">You</h2>
                <CollapsibleText text={block.item.text} lines={8} mono={false} />
              </article>
            );
          case "assistant":
            return (
              <article
                key={block.id}
                className={block.item.streaming ? "entry entry-reply is-streaming" : "entry entry-reply"}
                aria-busy={block.item.streaming}
              >
                <h2 className="visually-hidden">zeta</h2>
                {block.item.thinking !== "" && (
                  <Thinking
                    id={`${block.id}-thinking`}
                    text={block.item.thinking}
                    live={block.item.streaming && block.item.text === ""}
                  />
                )}
                {block.item.text !== "" && <SafeMarkdown text={block.item.text} />}
                {block.item.streaming && <span className="caret" aria-hidden="true" />}
              </article>
            );
          case "tools":
            return <ToolGroup key={block.id} group={block} now={now} />;
          case "notice":
            return (
              <p
                key={block.id}
                className={`entry entry-notice notice-${block.item.level}`}
                role={block.item.level === "error" ? "alert" : undefined}
              >
                <Node kind={block.item.level === "error" ? "error" : "info"} />
                {block.item.text}
              </p>
            );
        }
      })}
      {waiting && (
        <p className="entry entry-waiting" aria-hidden="true">
          <Node kind="live" />
          Thinking
        </p>
      )}
    </div>
  );
}
