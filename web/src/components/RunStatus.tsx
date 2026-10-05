/** The quiet line under the composer: what the agent is doing, and for how long. */

import { formatCount, formatSeconds } from "../lib/format";
import type { Connection } from "../lib/useSessionSocket";
import type { RunPhase, Usage } from "../lib/view";
import { Spinner } from "./Icon";

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
      return `Waiting for approval: ${phase.name}`;
  }
}

const CONNECTION_LABEL: Partial<Record<Connection, string>> = {
  connecting: "Connecting…",
  closed: "Reconnecting…",
  unauthorized: "Token rejected",
  gone: "Disconnected",
};

export function RunStatus({ phase, seconds, usage, connection }: Props): React.JSX.Element {
  const active = phase.kind !== "idle" && phase.kind !== "closed";
  const connectionLabel = CONNECTION_LABEL[connection];
  return (
    <div className="run-status">
      <span className={`run-phase phase-${phase.kind}`} role="status">
        {active && phase.kind !== "approval" ? (
          <Spinner size={10} />
        ) : (
          <span className="status-dot" aria-hidden="true" />
        )}
        <span>{phaseLabel(phase)}</span>
        {seconds !== null && (active || phase.kind === "idle") && (
          <span className="run-time">
            {active ? formatSeconds(seconds) : `last run ${formatSeconds(seconds)}`}
          </span>
        )}
      </span>
      <span className="run-facts">
        {(usage.input !== null || usage.output !== null) && (
          <span title="tokens in / out">
            {formatCount(usage.input ?? 0)} in · {formatCount(usage.output ?? 0)} out
          </span>
        )}
        {connectionLabel !== undefined && (
          <span className={`connection connection-${connection}`} role="status">
            {(connection === "closed" || connection === "connecting") && <Spinner size={10} />}
            {connectionLabel}
          </span>
        )}
      </span>
    </div>
  );
}
