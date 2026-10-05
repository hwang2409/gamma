/**
 * The composer. Enter sends, Shift+Enter starts a new line. While a run is
 * busy, text steers that run instead of starting a new one, and Stop
 * replaces Send.
 */

import { useLayoutEffect, useState } from "react";

import { Icon } from "./Icon";

interface Props {
  busy: boolean;
  disabled: boolean;
  /** Why the composer is disabled, shown as its placeholder. */
  disabledReason?: string;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onSend: (text: string) => void;
  onSteer: (text: string) => void;
  onAbort: () => void;
}

export function Composer({
  busy,
  disabled,
  disabledReason,
  inputRef,
  onSend,
  onSteer,
  onAbort,
}: Props): React.JSX.Element {
  const [text, setText] = useState("");
  const empty = text.trim() === "";

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input === null) {
      return;
    }
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [text, inputRef]);

  const submit = () => {
    const value = text.trim();
    if (value === "" || disabled) {
      return;
    }
    if (busy) {
      onSteer(value);
    } else {
      onSend(value);
    }
    setText("");
  };

  const placeholder = disabled
    ? (disabledReason ?? "Not connected")
    : busy
      ? "Steer the current run…"
      : "Ask zeta to do something…";

  return (
    <form
      className={`composer${busy ? " is-busy" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="visually-hidden" htmlFor="composer-input">
        {busy ? "Steer the current run" : "Message"}
      </label>
      <textarea
        id="composer-input"
        ref={inputRef}
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          const plainEnter =
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.nativeEvent.isComposing;
          if (plainEnter) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-bar">
        <span className="composer-hint">
          {busy ? "Enter steers the running turn" : "Enter sends, Shift+Enter adds a line"}
        </span>
        <span className="composer-actions">
          {busy && (
            <button type="button" className="button quiet" onClick={onAbort} disabled={disabled}>
              <span className="stop-square" aria-hidden="true" />
              Stop <kbd>Esc</kbd>
            </button>
          )}
          {(!busy || !empty) && (
            <button
              type="submit"
              className="send-button"
              disabled={disabled || empty}
              aria-label={busy ? "Steer" : "Send"}
              title={busy ? "Steer" : "Send"}
            >
              <Icon name={busy ? "steer" : "arrowUp"} size={16} />
            </button>
          )}
        </span>
      </div>
    </form>
  );
}
