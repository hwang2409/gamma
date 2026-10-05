/** The top bar of a session: back, what this session is, theme, end. */

import { baseName } from "../lib/format";
import type { SessionView } from "../lib/protocol";
import { Icon } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  session: SessionView | null;
  ended: boolean;
  onBack: () => void;
  onEnd: () => void;
}

/** What a session is called: its zeta name, else what was asked first. */
export function sessionTitle(session: SessionView | null): string {
  return session?.session_name || session?.first_prompt || "New session";
}

export function SessionHeader({ session, ended, onBack, onEnd }: Props): React.JSX.Element {
  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-button back-button"
        onClick={onBack}
        aria-label="Back to sessions"
        title="Back to sessions"
      >
        <Icon name="chevronLeft" />
      </button>
      <div className="topbar-title">
        <h1>{sessionTitle(session)}</h1>
        {session !== null && (
          <p className="topbar-meta">
            {session.cwd && (
              <span className="mono" title={session.cwd}>
                {baseName(session.cwd)}
              </span>
            )}
            <span>{session.model ?? session.provider}</span>
          </p>
        )}
      </div>
      <div className="topbar-actions">
        <ThemeToggle />
        {!ended && (
          <button type="button" className="ghost-button" onClick={onEnd}>
            End session
          </button>
        )}
      </div>
    </header>
  );
}
