/**
 * The session screen, without the socket: header, transcript, the pinned
 * approval, composer, and run status. SessionPage feeds it from a live
 * socket; the dev fixture feeds it a scripted transcript.
 *
 * Keys: Cmd/Ctrl+K or / focuses the composer. With an approval pending,
 * Cmd/Ctrl+Enter approves, Cmd/Ctrl+Shift+Enter always allows the tool, and
 * Esc denies. Otherwise Esc stops a busy run. Esc never fires while the
 * composer holds text, so it cannot throw away a draft's context.
 */

import { useEffect, useMemo, useRef } from "react";

import type { SessionView } from "../lib/protocol";
import { pendingApprovals, type TranscriptState } from "../lib/transcript";
import type { Connection } from "../lib/useSessionSocket";
import { useNow } from "../lib/useNow";
import { useStickToBottom } from "../lib/useStickToBottom";
import { isBusy, runPhase, runSeconds, transcriptBlocks, usageTotals } from "../lib/view";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { Icon } from "./Icon";
import { RunStatus } from "./RunStatus";
import { SessionHeader } from "./SessionHeader";
import { Transcript } from "./Transcript";

export interface SessionActions {
  send: (text: string) => void;
  steer: (text: string) => void;
  abort: () => void;
  approve: (requestId: string, scope: "once" | "always_tool") => void;
  deny: (requestId: string) => void;
  dismissError: () => void;
}

interface Props {
  session: SessionView | null;
  transcript: TranscriptState;
  connection: Connection;
  error: string | null;
  actions: SessionActions;
  onBack: () => void;
  onEnd: () => void;
}

export function SessionLayout({
  session,
  transcript,
  connection,
  error,
  actions,
  onBack,
  onEnd,
}: Props): React.JSX.Element {
  const blocks = useMemo(() => transcriptBlocks(transcript), [transcript]);
  const pending = pendingApprovals(transcript);
  const approval = pending[0];
  const busy = isBusy(transcript);
  const phase = runPhase(transcript);
  const now = useNow(busy);
  const scroll = useStickToBottom();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const supportsAlways = (session?.protocol_version ?? "1.0") !== "1.0";
  const disabled = connection !== "open" || transcript.closed;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement | null;
      const editing =
        target !== null &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      const draft = (inputRef.current?.value ?? "").trim() !== "";

      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        return;
      }
      if (event.key === "/" && !editing && !mod) {
        event.preventDefault();
        inputRef.current?.focus();
        return;
      }
      if (approval !== undefined && !disabled && mod && event.key === "Enter") {
        event.preventDefault();
        const always = event.shiftKey && supportsAlways;
        actions.approve(approval.requestId, always ? "always_tool" : "once");
        return;
      }
      if (event.key === "Escape" && !draft && !disabled) {
        if (approval !== undefined) {
          event.preventDefault();
          actions.deny(approval.requestId);
        } else if (busy) {
          event.preventDefault();
          actions.abort();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, approval, busy, disabled, supportsAlways]);

  return (
    <div className="session">
      <SessionHeader session={session} ended={transcript.closed} onBack={onBack} onEnd={onEnd} />
      <main className="session-scroll" ref={scroll.scrollRef} tabIndex={-1}>
        <div className="session-column" ref={scroll.contentRef}>
          <Transcript blocks={blocks} now={now} />
        </div>
      </main>
      <footer className="dock">
        <div className="dock-column">
          {!scroll.atBottom && (
            <button type="button" className="jump-pill" onClick={scroll.jumpToLatest}>
              <Icon name="arrowDown" size={14} />
              Jump to latest
            </button>
          )}
          {error !== null && (
            <p className="dock-error" role="alert">
              <Icon name="alert" size={14} />
              <span>{error}</span>
              <button type="button" className="ghost-button small" onClick={actions.dismissError}>
                Dismiss
              </button>
            </p>
          )}
          {approval !== undefined && (
            <ApprovalCard
              item={approval}
              queued={pending.length - 1}
              supportsAlways={supportsAlways}
              onApprove={actions.approve}
              onDeny={actions.deny}
            />
          )}
          <Composer
            busy={busy}
            disabled={disabled}
            disabledReason={
              transcript.closed
                ? "This session has ended"
                : connection === "open"
                  ? undefined
                  : "Waiting for the connection…"
            }
            inputRef={inputRef}
            onSend={actions.send}
            onSteer={actions.steer}
            onAbort={actions.abort}
          />
          <RunStatus
            phase={phase}
            seconds={runSeconds(transcript, now)}
            usage={usageTotals(transcript.usage)}
            connection={connection}
          />
        </div>
      </footer>
    </div>
  );
}
