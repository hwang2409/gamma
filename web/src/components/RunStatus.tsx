/**
 * The line under the composer: what the agent is doing now and for how
 * long, and the session's token counts. A lost connection takes over the
 * left side, so it is never hidden in a corner.
 */

import { formatSeconds } from "../lib/format";
import type { Connection } from "../lib/useSessionSocket";
import type { RunPhase, Usage } from "../lib/view";
import { Node, type NodeKind } from "./Node";

interface Props {
  phase: RunPhase;
  seconds: number | null;
  usage: Usage;
  connection: Connection;
}

function phaseLabel(phase: RunPhase): string {
  switch (phase.kind) {
    case "idle":
      return "Ready";
    case "closed":
      return "Session ended";
    case "thinking":
      return "Thinking";
    case "responding":
      return "Writing";
    case "tool":
      return `Running ${phase.name}`;
    case "approval":
      return `Waiting for your approval: ${phase.name}`;
  }
}

const PHASE_NODE: Record<RunPhase["kind"], NodeKind> = {
  idle: "idle",
  closed: "idle",
  thinking: "live",
  responding: "live",
  tool: "live",
  approval: "waiting",
};

const CONNECTION: Partial<Record<Connection, { label: string; node: NodeKind }>> = {
  connecting: { label: "Connecting…", node: "live" },
  closed: { label: "Connection lost. Reconnecting…", node: "live" },
  unauthorized: { label: "Token rejected", node: "error" },
  gone: { label: "Disconnected. The session is no longer available.", node: "error" },
};

const counter = new Intl.NumberFormat();

export function RunStatus({ phase, seconds, usage, connection }: Props): React.JSX.Element {
  const active = phase.kind !== "idle" && phase.kind !== "closed";
  const lost = CONNECTION[connection];
  return (
    <div className="run-status">
      {lost !== undefined ? (
        <span className="run-phase is-connection" role="status">
          <Node kind={lost.node} />
          <span>{lost.label}</span>
        </span>
      ) : (
        <span className={`run-phase phase-${phase.kind}`} role="status">
          <Node kind={PHASE_NODE[phase.kind]} />
          <span className="run-label">{phaseLabel(phase)}</span>
          {seconds !== null && (active || phase.kind === "idle") && (
            <span className="run-time">
              {active ? formatSeconds(seconds) : `last run ${formatSeconds(seconds)}`}
            </span>
          )}
        </span>
      )}
      {(usage.input !== null || usage.output !== null) && (
        <span className="run-usage" aria-label="tokens used">
          <span>{counter.format(usage.input ?? 0)} in</span>
          <span>{counter.format(usage.output ?? 0)} out</span>
        </span>
      )}
    </div>
  );
}
