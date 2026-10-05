/** A live session: the socket, wired into the session layout. */

import { useEffect } from "react";

import { api } from "../lib/api";
import type { SessionView } from "../lib/protocol";
import { useSessionSocket } from "../lib/useSessionSocket";
import { SessionLayout } from "./SessionLayout";

interface Props {
  sessionId: string;
  initial: SessionView | null;
  onLeave: () => void;
  onUnauthorized: () => void;
}

export function SessionPage({
  sessionId,
  initial,
  onLeave,
  onUnauthorized,
}: Props): React.JSX.Element {
  const socket = useSessionSocket(sessionId);

  useEffect(() => {
    if (socket.connection === "unauthorized") {
      onUnauthorized();
    }
  }, [socket.connection, onUnauthorized]);

  const end = async () => {
    try {
      await api.closeSession(sessionId);
    } finally {
      onLeave();
    }
  };

  return (
    <SessionLayout
      session={socket.session ?? initial}
      transcript={socket.transcript}
      connection={socket.connection}
      error={socket.error}
      actions={socket}
      onBack={onLeave}
      onEnd={() => void end()}
    />
  );
}
