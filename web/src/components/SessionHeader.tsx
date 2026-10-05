/** The top bar of a session: back, what this session is, theme, end. */

import { baseName, shortPath } from "../lib/format";
import type { SessionView } from "../lib/protocol";
import { Icon } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  session: SessionView | null;
  ended: boolean;
  onBack: () => void;
  onEnd: () => void;
}

export function SessionHeader({ session, ended, onBack, onEnd }: Props): React.JSX.Element {
  const title = session?.session_name || baseName(session?.cwd) || "Untitled session";
  const model = session ? `${session.provider}${session.model ? ` / ${session.model}` : ""}` : "";
  return (
    <header className="topbar">
      <button
        type="button"
        className="ghost-button back-button"
        onClick={onBack}
        aria-label="Back to sessions"
      >
        <Icon name="chevronLeft" size={14} />
        <span aria-hidden="true">Sessions</span>
      </button>
      <div className="topbar-title">
        <h1>{title}</h1>
        {session !== null && (
          <p className="topbar-meta">
            <span>{model}</span>
            {session.cwd && (
              <>
                <span className="dot-sep" aria-hidden="true">
                  ·
                </span>
                <span className="mono" title={session.cwd}>
                  {shortPath(session.cwd)}
                </span>
              </>
            )}
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
