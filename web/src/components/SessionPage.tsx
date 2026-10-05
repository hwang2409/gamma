/** The session page: transcript, approvals, composer, and status. */

import { useEffect, useRef } from "react";

import { api } from "../lib/api";
import type { SessionView } from "../lib/protocol";
import { useSessionSocket } from "../lib/useSessionSocket";
import { Composer } from "./Composer";
import { StatusBar } from "./StatusBar";
import { Transcript } from "./Transcript";

interface Props {
  sessionId: string;
  initial: SessionView | null;
  onLeave: () => void;
}

export function SessionPage({ sessionId, initial, onLeave }: Props): React.JSX.Element {
  const socket = useSessionSocket(sessionId);
  const session = socket.session ?? initial;
  const bottom = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [socket.transcript.items.length]);

  const supportsAlways = (session?.protocol_version ?? "1.0") !== "1.0";

  const close = async () => {
    try {
      await api.closeSession(sessionId);
    } finally {
      onLeave();
    }
  };

  return (
    <main className="session-page">
      <StatusBar
        session={session}
        state={socket.transcript.state}
        connection={socket.connection}
        usage={socket.transcript.usage}
        onBack={onLeave}
        onClose={() => void close()}
      />
      {socket.error !== null && (
        <p className="notice error" role="alert">
          {socket.error}
          <button type="button" className="link" onClick={socket.dismissError}>
            dismiss
          </button>
        </p>
      )}
      <Transcript
        items={socket.transcript.items}
        supportsAlways={supportsAlways}
        onApprove={socket.approve}
        onDeny={socket.deny}
      />
      <div ref={bottom} />
      <Composer
        state={socket.transcript.state}
        disabled={socket.connection !== "open" || socket.transcript.closed}
        onSend={socket.send}
        onSteer={socket.steer}
        onAbort={socket.abort}
      />
    </main>
  );
}
