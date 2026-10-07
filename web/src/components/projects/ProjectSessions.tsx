/**
 * The Sessions tab: every session linked to this project, with each
 * orchestrator's workers nested under it. The name leads; a click opens the
 * session in gamma by resuming it in its own working directory.
 *
 * Resuming goes through the same launch policy as the start page, so a
 * directory the backend does not allow fails here with a clear message
 * instead of opening in the wrong tree.
 */

import { useCallback, useState } from "react";

import { api, isAuthError } from "../../lib/api";
import { shortPath } from "../../lib/format";
import type { ProjectSessionSummary, SessionView } from "../../lib/protocol";
import { useResource } from "../../lib/useResource";
import { Spinner } from "../Icon";
import { Node } from "../Node";
import { Badge, IdChip, Time, ViewState } from "./parts";

interface Props {
  projectId: string;
  onOpenSession: (session: SessionView) => void;
  onUnauthorized: () => void;
}

interface Group {
  root: ProjectSessionSummary;
  children: ProjectSessionSummary[];
}

export function ProjectSessions({
  projectId,
  onOpenSession,
  onUnauthorized,
}: Props): React.JSX.Element {
  const load = useCallback(() => api.projectSessions(projectId), [projectId]);
  const resource = useResource(load, [projectId], onUnauthorized);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  const open = async (session: ProjectSessionSummary) => {
    setBusy(session.session_id);
    setError(null);
    try {
      onOpenSession(
        await api.createSession({
          provider: session.provider,
          model: session.model,
          cwd: session.cwd,
          resume_session_id: session.session_id,
        }),
      );
    } catch (cause) {
      if (isAuthError(cause)) {
        onUnauthorized();
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="sessions" aria-label="Project sessions">
      {error !== null && (
        <p className="view-state view-state-error" role="alert">
          <Node kind="error" />
          {error}
        </p>
      )}
      <ViewState resource={resource}>
        {(data) =>
          data.sessions.length === 0 ? (
            <p className="view-state">No sessions in this project yet.</p>
          ) : (
            <ul className="session-tree">
              {group(data.sessions).map(({ root, children }) => (
                <li key={root.session_id}>
                  <SessionNode
                    session={root}
                    now={now}
                    busy={busy}
                    onOpen={() => void open(root)}
                  />
                  {children.length > 0 && (
                    <ul className="session-children">
                      {children.map((child) => (
                        <li key={child.session_id}>
                          <SessionNode
                            session={child}
                            now={now}
                            busy={busy}
                            onOpen={() => void open(child)}
                            child
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </ViewState>
    </section>
  );
}

function SessionNode({
  session,
  now,
  busy,
  onOpen,
  child = false,
}: {
  session: ProjectSessionSummary;
  now: number;
  busy: string | null;
  onOpen: () => void;
  child?: boolean;
}): React.JSX.Element {
  const title = session.name || session.first_message_preview || "Untitled session";
  const working = busy === session.session_id;
  return (
    <div className={child ? "session-node session-node-child" : "session-node"}>
      <button
        type="button"
        className="session-node-main"
        disabled={busy !== null}
        onClick={onOpen}
        title="Resume this session in gamma"
      >
        <span className="session-node-node">
          {working ? <Spinner size={12} /> : <Node kind={child ? "steer" : "task"} />}
        </span>
        <span className="session-node-title">{title}</span>
        <span className="session-node-meta">
          {session.project_role && <Badge>{session.project_role}</Badge>}
          {session.cwd && (
            <span className="mono" title={session.cwd}>
              {shortPath(session.cwd, 2)}
            </span>
          )}
          <span>{session.model ?? session.provider}</span>
          <span className="dim">
            <Time iso={session.updated_at} now={now} />
          </span>
        </span>
      </button>
      <IdChip id={session.session_id} label="session id" />
    </div>
  );
}

/** Nest each worker under its orchestrator; keep the server's order. */
function group(sessions: ProjectSessionSummary[]): Group[] {
  const byId = new Map(sessions.map((session) => [session.session_id, session]));
  const groups: Group[] = [];
  const index = new Map<string, Group>();
  for (const session of sessions) {
    const parent = session.parent_session_id;
    if (parent === null || !byId.has(parent)) {
      const entry = { root: session, children: [] as ProjectSessionSummary[] };
      groups.push(entry);
      index.set(session.session_id, entry);
    }
  }
  for (const session of sessions) {
    const parent = session.parent_session_id;
    if (parent !== null && index.has(parent)) {
      index.get(parent)!.children.push(session);
    }
  }
  return groups;
}
