/** The composer: send when idle, steer while a turn runs, and abort. */

import { useState } from "react";

import type { RunState } from "../lib/protocol";

interface Props {
  state: RunState;
  disabled: boolean;
  onSend: (text: string) => void;
  onSteer: (text: string) => void;
  onAbort: () => void;
}

export function Composer({
  state,
  disabled,
  onSend,
  onSteer,
  onAbort,
}: Props): React.JSX.Element {
  const [text, setText] = useState("");
  const running = state !== "idle";

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (value === "" || disabled) {
      return;
    }
    if (running) {
      onSteer(value);
    } else {
      onSend(value);
    }
    setText("");
  };

  return (
    <form className="composer" onSubmit={submit}>
      <label className="visually-hidden" htmlFor="composer-input">
        {running ? "Steer the running turn" : "Message"}
      </label>
      <textarea
        id="composer-input"
        rows={3}
        value={text}
        disabled={disabled}
        placeholder={running ? "Steer the running turn..." : "Send a message..."}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            submit(event);
          }
        }}
      />
      <div className="composer-actions">
        <button type="submit" disabled={disabled || text.trim() === ""}>
          {running ? "Steer" : "Send"}
        </button>
        <button type="button" className="danger" disabled={!running} onClick={onAbort}>
          Abort
        </button>
        <span className="hint">Cmd/Ctrl + Enter sends</span>
      </div>
    </form>
  );
}
