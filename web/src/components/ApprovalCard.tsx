/**
 * The pending approval, pinned above the composer: the one inverted surface
 * in the product, because it is the one moment the agent waits for you.
 *
 * It shows exactly what will run (the command, the file and its diff, or the
 * raw arguments), then the facts zeta itself resolved: the directory a
 * command runs in, the real path it touches, the project file a write
 * targets. The model cannot forge those, so they are set apart from its
 * arguments. Approve, always allow this tool, or deny, by button or by
 * shortcut (the session page owns the keys; the hints live here).
 */

import { modKey } from "../lib/format";
import { languageForPath } from "../lib/highlight";
import type { ApprovalDisplay } from "../lib/protocol";
import type { ApprovalItem } from "../lib/transcript";
import { CollapsibleText } from "./Collapsible";

interface Props {
  item: ApprovalItem;
  /** Approvals still waiting behind this one. */
  queued: number;
  /** True when the harness negotiated protocol 1.1, which has `scope`. */
  supportsAlways: boolean;
  /** True while the card leaves after a decision; its buttons stop working. */
  leaving?: boolean;
  onApprove: (requestId: string, scope: "once" | "always_tool") => void;
  onDeny: (requestId: string) => void;
}

export function ApprovalCard({
  item,
  queued,
  supportsAlways,
  leaving = false,
  onApprove,
  onDeny,
}: Props): React.JSX.Element {
  const mod = modKey();
  const headingId = `${item.id}-heading`;
  return (
    <section
      className={leaving ? "approval is-leaving" : "approval"}
      aria-labelledby={headingId}
      inert={leaving}
    >
      <header className="approval-head">
        <h2 id={headingId}>
          Allow <span className="approval-tool">{item.name}</span>?
        </h2>
        <p className="approval-why">
          {describe(item)}
          {item.delegated && " A sub-agent is asking."}
        </p>
        {queued > 0 && <span className="approval-queue">{queued} more waiting</span>}
      </header>
      <ApprovalPreview name={item.name} args={item.args} />
      <ResolvedFacts display={item.display} args={item.args} />
      <div className="approval-actions">
        <button
          type="button"
          className="button on-ink primary"
          onClick={() => onApprove(item.requestId, "once")}
        >
          Approve <kbd>{mod}⏎</kbd>
        </button>
        {supportsAlways && (
          <button
            type="button"
            className="button on-ink"
            onClick={() => onApprove(item.requestId, "always_tool")}
          >
            Always allow {item.name} <kbd>{mod}⇧⏎</kbd>
          </button>
        )}
        <button type="button" className="button on-ink" onClick={() => onDeny(item.requestId)}>
          Deny <kbd>Esc</kbd>
        </button>
      </div>
    </section>
  );
}

function describe(item: ApprovalItem): string {
  const args = item.args;
  if (typeof args.command === "string") {
    return "zeta wants to run this command.";
  }
  if (typeof args.path === "string" && editPairs(args).length > 0) {
    return "zeta wants to change this file.";
  }
  if (typeof args.path === "string" && typeof args.content === "string") {
    return "zeta wants to write this file.";
  }
  return "zeta wants to use this tool.";
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
        <CollapsibleText
          className="approval-command"
          text={args.command}
          lines={10}
          language="bash"
        />
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
          {path}
          {name !== "write" && <span className="approval-path-note"> ({name})</span>}
        </p>
        <CollapsibleText
          className="approval-content"
          text={args.content}
          lines={10}
          language={languageForPath(path)}
        />
      </div>
    );
  }
  return (
    <div className="approval-preview">
      <CollapsibleText
        className="approval-content"
        text={JSON.stringify(args, null, 2)}
        lines={10}
        language="json"
      />
    </div>
  );
}

/**
 * What zeta resolved for this request. Every value is shown as text. The
 * command's own `cwd` argument is listed too, since it decides where a
 * command runs, but labelled as the model's request.
 */
function ResolvedFacts({
  display,
  args,
}: {
  display: ApprovalDisplay | null;
  args: Record<string, unknown>;
}): React.JSX.Element | null {
  const facts: [label: string, value: string][] = [];
  if (display?.effective_cwd) {
    facts.push(["Runs in", display.effective_cwd]);
  } else if (typeof args.cwd === "string") {
    facts.push(["Asks to run in", args.cwd]);
  }
  if (display?.resolved_path) {
    facts.push(["Resolved path", display.resolved_path]);
  }
  if (display?.project_name || display?.project_id) {
    facts.push(["Project", display.project_name ?? display.project_id ?? ""]);
  }
  if (display?.filename) {
    const size = typeof display.utf8_bytes === "number" ? `, ${formatBytes(display.utf8_bytes)}` : "";
    facts.push(["File", `${display.filename}${size}`]);
  }
  if (facts.length === 0 && !display?.preview) {
    return null;
  }
  return (
    <div className="approval-facts">
      {facts.length > 0 && (
        <dl>
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {display?.preview && (
        <CollapsibleText
          className="approval-content"
          text={display.preview}
          lines={8}
          language={languageForPath(display.filename)}
        />
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`;
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
        <span key={`d${index}`} className="diff-line diff-del">
          <span className="diff-sign" aria-hidden="true">
            −
          </span>
          <span className="visually-hidden">removed: </span>
          {line}
          {"\n"}
        </span>
      ))}
      {added.map((line, index) => (
        <span key={`a${index}`} className="diff-line diff-add">
          <span className="diff-sign" aria-hidden="true">
            +
          </span>
          <span className="visually-hidden">added: </span>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
