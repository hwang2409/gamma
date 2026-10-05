/**
 * Dev-only: the session screen over a scripted transcript, for visual checks
 * and screenshots. Reached at #/fixture, #/fixture/streaming,
 * #/fixture/empty, or #/fixture/reconnecting (a dropped socket and a dock
 * error) while the Vite dev server runs; production builds leave it
 * out. Commands are folded back in as events, so approving, denying,
 * sending, and stopping all behave.
 */

import { useCallback, useMemo, useReducer, useRef } from "react";

import { SessionLayout, type SessionActions } from "../components/SessionLayout";
import { transcriptReducer, emptyTranscript, type TranscriptState } from "../lib/transcript";
import { fixtureEvents, fixtureSession, type FixtureVariant } from "./fixture";

function variantFromHash(): FixtureVariant {
  const name = window.location.hash.replace(/^#\/fixture\/?/, "");
  return name === "streaming" || name === "empty" || name === "reconnecting" ? name : "approval";
}

function initial(variant: FixtureVariant): TranscriptState {
  return fixtureEvents(variant, Date.now() / 1000).reduce(
    (state, event) => transcriptReducer(state, { type: "event", event }),
    emptyTranscript,
  );
}

export default function FixturePage(): React.JSX.Element {
  const variant = variantFromHash();
  const [transcript, dispatch] = useReducer(transcriptReducer, variant, initial);
  const cursor = useRef(1_000_000);

  const emit = useCallback(
    (event: string, payload: Record<string, unknown>) =>
      dispatch({
        type: "event",
        event: { cursor: (cursor.current += 1), at: Date.now() / 1000, event, payload },
      }),
    [],
  );

  const actions = useMemo<SessionActions>(
    () => ({
      send: (text) => emit("gamma_user_message", { text, mode: "send" }),
      steer: (text) => emit("gamma_user_message", { text, mode: "steer" }),
      abort: () => emit("turn_aborted", {}),
      approve: (requestId, scope) =>
        emit("gamma_approval_decision", { request_id: requestId, decision: "approve", scope }),
      deny: (requestId) =>
        emit("gamma_approval_decision", { request_id: requestId, decision: "deny", scope: "once" }),
      dismissError: () => {},
    }),
    [emit],
  );

  return (
    <SessionLayout
      session={fixtureSession}
      transcript={transcript}
      connection={variant === "reconnecting" ? "closed" : "open"}
      error={
        variant === "reconnecting"
          ? "Your last message was not sent. Send it again when the connection is back."
          : null
      }
      actions={actions}
      onBack={() => {
        window.location.hash = "";
        window.location.reload();
      }}
      onEnd={() => emit("gamma_session_closed", {})}
    />
  );
}
