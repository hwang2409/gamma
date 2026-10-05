/**
 * The pending approval, pinned above the composer.
 *
 * It shows exactly what will run: the command, the file and its diff, or
 * the raw arguments. Approve, always allow this tool, or deny, by button or
 * by shortcut (the session page owns the keys; the hints live here).
 */

import { modKey } from "../lib/format";
import type { ApprovalItem } from "../lib/transcript";
import { CollapsibleText } from "./Collapsible";
import { Icon } from "./Icon";

interface Props {
  item: ApprovalItem;
  /** Approvals still waiting behind this one. */
  queued: number;
  /** True when the harness negotiated protocol 1.1, which has `scope`. */
  supportsAlways: boolean;
  onApprove: (requestId: string, scope: "once" | "always_tool") => void;
  onDeny: (requestId: string) => void;
}

export function ApprovalCard({
  item,
  queued,
  supportsAlways,
  onApprove,
  onDeny,
}: Props): React.JSX.Element {
  const mod = modKey();
  const headingId = `${item.id}-heading`;
  return (
    <section className="approval-card" aria-labelledby={headingId}>
      <header className="approval-head">
        <Icon name="shield" />
        <h2 id={headingId}>
          Allow <code>{item.name}</code>?
        </h2>
        {queued > 0 && <span className="approval-queue">+{queued} waiting</span>}
      </header>
      <ApprovalPreview name={item.name} args={item.args} />
      <div className="approval-actions">
        <button
          type="button"
          className="button primary"
          onClick={() => onApprove(item.requestId, "once")}
        >
          Approve <kbd>{mod}⏎</kbd>
        </button>
        {supportsAlways && (
          <button
            type="button"
            className="button"
            onClick={() => onApprove(item.requestId, "always_tool")}
          >
            Always allow {item.name} <kbd>{mod}⇧⏎</kbd>
          </button>
        )}
        <button type="button" className="button" onClick={() => onDeny(item.requestId)}>
          Deny <kbd>Esc</kbd>
        </button>
      </div>
    </section>
  );
}

function ApprovalPreview({
  name,
  args,
}: {
  name: string;
  args: Record<string, unknown>;
}): React.JSX.Element {
  const path = typeof args.path === "string" ? args.path : null;
  if (typeof args.command === "string") {
    return (
      <div className="approval-preview">
        <CollapsibleText className="approval-command" text={`$ ${args.command}`} lines={10} />
        {typeof args.cwd === "string" && <p className="approval-meta">in {args.cwd}</p>}
      </div>
    );
  }
  const edits = editPairs(args);
  if (path !== null && edits.length > 0) {
    return (
      <div className="approval-preview">
        <p className="approval-path">{path}</p>
        {edits.map((edit, index) => (
          <Diff key={index} before={edit.before} after={edit.after} />
        ))}
      </div>
    );
  }
  if (path !== null && typeof args.content === "string") {
    return (
      <div className="approval-preview">
        <p className="approval-path">
          {path} <span className="approval-meta">· {name === "write" ? "write file" : name}</span>
        </p>
        <CollapsibleText className="approval-content" text={args.content} lines={10} />
      </div>
    );
  }
  return (
    <div className="approval-preview">
      <CollapsibleText
        className="approval-content"
        text={JSON.stringify(args, null, 2)}
        lines={10}
      />
    </div>
  );
}

function editPairs(args: Record<string, unknown>): { before: string; after: string }[] {
  if (typeof args.old_string === "string" && typeof args.new_string === "string") {
    return [{ before: args.old_string, after: args.new_string }];
  }
  if (!Array.isArray(args.edits)) {
    return [];
  }
  return args.edits.flatMap((edit: unknown) => {
    const record = edit as { old_string?: unknown; new_string?: unknown } | null;
    return record !== null &&
      typeof record.old_string === "string" &&
      typeof record.new_string === "string"
      ? [{ before: record.old_string, after: record.new_string }]
      : [];
  });
}

function Diff({ before, after }: { before: string; after: string }): React.JSX.Element {
  const removed = before === "" ? [] : before.split("\n");
  const added = after === "" ? [] : after.split("\n");
  return (
    <pre className="diff" tabIndex={0} aria-label="proposed change">
      {removed.map((line, index) => (
        <span key={`d${index}`} className="diff-del">
          <span className="diff-sign" aria-label="removed">-</span>
          {line}
          {"\n"}
        </span>
      ))}
      {added.map((line, index) => (
        <span key={`a${index}`} className="diff-add">
          <span className="diff-sign" aria-label="added">+</span>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
