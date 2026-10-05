/** The approval prompt: approve once, approve for the whole session, or deny. */

import type { ApprovalItem } from "../lib/transcript";
import { argumentSummary } from "./ToolCard";

interface Props {
  item: ApprovalItem;
  /** True when the harness negotiated protocol 1.1, which has `scope`. */
  supportsAlways: boolean;
  onApprove: (requestId: string, scope: "once" | "always_tool") => void;
  onDeny: (requestId: string) => void;
}

export function ApprovalCard({
  item,
  supportsAlways,
  onApprove,
  onDeny,
}: Props): React.JSX.Element {
  const resolved = item.phase !== "pending";
  return (
    <section className={`card approval approval-${item.phase}`} aria-label="approval request">
      <h3>
        Run <code>{item.name}</code>?
      </h3>
      <pre>{argumentSummary(item.args) || JSON.stringify(item.args, null, 2)}</pre>
      {resolved ? (
        <p className="approval-state">
          {item.phase === "approved"
            ? `Approved${item.scope === "always_tool" ? " for every later call to this tool" : ""}.`
            : item.phase === "denied"
              ? "Denied."
              : "No longer waiting for an answer."}
        </p>
      ) : (
        <div className="approval-actions">
          <button type="button" onClick={() => onApprove(item.requestId, "once")}>
            Approve once
          </button>
          {supportsAlways && (
            <button type="button" onClick={() => onApprove(item.requestId, "always_tool")}>
              Always allow {item.name}
            </button>
          )}
          <button type="button" className="danger" onClick={() => onDeny(item.requestId)}>
            Deny
          </button>
        </div>
      )}
    </section>
  );
}
