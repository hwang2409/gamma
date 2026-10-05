/** The status bar: run state, connection, usage counters, session facts. */

import type { RunState, SessionView } from "../lib/protocol";
import type { Connection } from "../lib/useSessionSocket";

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: "connecting",
  open: "connected",
  closed: "reconnecting",
  unauthorized: "token rejected",
  gone: "session gone",
};

function tokenCount(usage: Record<string, unknown>, key: string): number | null {
  const value = usage[key];
  return typeof value === "number" ? value : null;
}

interface Props {
  session: SessionView | null;
  state: RunState;
  connection: Connection;
  usage: Record<string, unknown>;
  onClose: () => void;
  onBack: () => void;
}

export function StatusBar({
  session,
  state,
  connection,
  usage,
  onClose,
  onBack,
}: Props): React.JSX.Element {
  const input = tokenCount(usage, "input_tokens");
  const output = tokenCount(usage, "output_tokens");
  return (
    <header className="status-bar">
      <button type="button" className="link" onClick={onBack}>
        &larr; Sessions
      </button>
      <span className={`pill state-${state}`} role="status">
        {state}
      </span>
      <span className={`pill connection-${connection}`}>{CONNECTION_LABEL[connection]}</span>
      {session && (
        <>
          <span className="fact">
            {session.provider} / {session.model ?? "default model"}
          </span>
          <span className="fact mono" title={session.cwd ?? ""}>
            {session.cwd}
          </span>
          <span className="fact mono">zeta {session.protocol_version}</span>
        </>
      )}
      <span className="fact">
        tokens in {input ?? "-"} / out {output ?? "-"}
      </span>
      <button type="button" className="danger" onClick={onClose}>
        Close session
      </button>
    </header>
  );
}
