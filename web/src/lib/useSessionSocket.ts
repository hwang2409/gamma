/**
 * The session socket.
 *
 * One WebSocket per open session page. It authenticates with the first
 * message (never a query string, which servers and proxies log), then folds
 * every frame into the transcript. On a drop it reconnects and asks for
 * everything after the last cursor it applied, so the transcript continues
 * without gaps or duplicates.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { readToken } from "./api";
import type { ClientCommand, ServerFrame, SessionView } from "./protocol";
import { emptyTranscript, transcriptReducer, type TranscriptState } from "./transcript";

export type Connection = "connecting" | "open" | "closed" | "unauthorized" | "gone";

const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000];

export interface SessionSocket {
  transcript: TranscriptState;
  session: SessionView | null;
  connection: Connection;
  error: string | null;
  send: (text: string) => void;
  steer: (text: string) => void;
  abort: () => void;
  approve: (requestId: string, scope?: "once" | "always_tool") => void;
  deny: (requestId: string) => void;
  dismissError: () => void;
}

export function useSessionSocket(sessionId: string): SessionSocket {
  const [transcript, dispatch] = useReducer(transcriptReducer, emptyTranscript);
  const [session, setSession] = useState<SessionView | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const cursorRef = useRef(0);
  const attemptRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const liveRef = useRef(true);

  cursorRef.current = transcript.cursor;

  useEffect(() => {
    liveRef.current = true;
    dispatch({ type: "reset" });

    const open = () => {
      if (!liveRef.current) {
        return;
      }
      setConnection("connecting");
      const url = new URL(
        `/api/sessions/${encodeURIComponent(sessionId)}/ws`,
        window.location.href,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("cursor", String(cursorRef.current));
      const socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "auth", token: readToken() }));
      };

      socket.onmessage = (message) => {
        const frame = JSON.parse(String(message.data)) as ServerFrame;
        switch (frame.type) {
          case "snapshot":
            attemptRef.current = 0;
            setConnection("open");
            setSession(frame.session);
            dispatch({ type: "snapshot", session: frame.session });
            break;
          case "event":
            dispatch({ type: "event", event: frame });
            break;
          case "error":
            setError(frame.message);
            break;
          case "ack":
          case "pong":
            break;
        }
      };

      socket.onclose = (event) => {
        socketRef.current = null;
        if (!liveRef.current) {
          return;
        }
        if (event.code === 4401 || event.code === 4403) {
          setConnection("unauthorized");
          setError("The access token was rejected. Paste the backend token again.");
          return;
        }
        if (event.code === 4404) {
          setConnection("gone");
          setError("That session no longer exists.");
          return;
        }
        if (event.code === 4410) {
          setConnection("gone");
          setError("The session was closed.");
          return;
        }
        setConnection("closed");
        const delay =
          RECONNECT_DELAYS_MS[Math.min(attemptRef.current, RECONNECT_DELAYS_MS.length - 1)] ??
          4000;
        attemptRef.current += 1;
        timerRef.current = window.setTimeout(open, delay);
      };
    };

    open();

    return () => {
      liveRef.current = false;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [sessionId]);

  const command = useCallback((payload: ClientCommand) => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      setError("Not connected to the session.");
      return;
    }
    socket.send(JSON.stringify(payload));
  }, []);

  return useMemo(
    () => ({
      transcript,
      session,
      connection,
      error,
      send: (text: string) => command({ type: "send", text }),
      steer: (text: string) => command({ type: "steer", text }),
      abort: () => command({ type: "abort" }),
      approve: (requestId: string, scope: "once" | "always_tool" = "once") =>
        command({ type: "approve", request_id: requestId, scope }),
      deny: (requestId: string) => command({ type: "deny", request_id: requestId }),
      dismissError: () => setError(null),
    }),
    [transcript, session, connection, error, command],
  );
}
