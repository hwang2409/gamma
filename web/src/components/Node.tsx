/**
 * A mark on the transcript spine. Its shape says the state, without color:
 * a filled disc starts a task, a ring is live, a filled square failed, a
 * diamond waits for you, a small dot is done.
 */

export type NodeKind =
  | "task"
  | "steer"
  | "done"
  | "live"
  | "error"
  | "denied"
  | "waiting"
  | "info"
  | "idle";

export function Node({ kind, className }: { kind: NodeKind; className?: string }): React.JSX.Element {
  return (
    <span
      className={className ? `node node-${kind} ${className}` : `node node-${kind}`}
      aria-hidden="true"
    />
  );
}
