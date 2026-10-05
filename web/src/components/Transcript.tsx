/** The transcript: user turns, assistant messages, tool cards, notices. */

import type { TranscriptItem } from "../lib/transcript";
import { ApprovalCard } from "./ApprovalCard";
import { SafeMarkdown } from "./SafeMarkdown";
import { ToolCard } from "./ToolCard";

interface Props {
  items: TranscriptItem[];
  supportsAlways: boolean;
  onApprove: (requestId: string, scope: "once" | "always_tool") => void;
  onDeny: (requestId: string) => void;
}

export function Transcript({
  items,
  supportsAlways,
  onApprove,
  onDeny,
}: Props): React.JSX.Element {
  return (
    <div className="transcript" role="log" aria-live="polite" aria-label="conversation">
      {items.length === 0 && <p className="empty">No messages yet. Say something below.</p>}
      {items.map((item) => {
        switch (item.kind) {
          case "user":
            return (
              <article key={item.id} className="turn user">
                <h2>{item.mode === "steer" ? "You (steer)" : "You"}</h2>
                <p className="user-text">{item.text}</p>
              </article>
            );
          case "assistant":
            return (
              <article key={item.id} className="turn assistant">
                <h2>Assistant{item.streaming ? " (typing)" : ""}</h2>
                {item.thinking !== "" && (
                  <details className="thinking">
                    <summary>Thinking</summary>
                    <pre>{item.thinking}</pre>
                  </details>
                )}
                <SafeMarkdown text={item.text} />
              </article>
            );
          case "tool":
            return <ToolCard key={item.id} item={item} />;
          case "approval":
            return (
              <ApprovalCard
                key={item.id}
                item={item}
                supportsAlways={supportsAlways}
                onApprove={onApprove}
                onDeny={onDeny}
              />
            );
          case "notice":
            return (
              <p key={item.id} className={`notice ${item.level}`} role="status">
                {item.text}
              </p>
            );
        }
      })}
    </div>
  );
}
