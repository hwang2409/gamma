/**
 * The start page: start a session, return to a running one, or resume a
 * past zeta session.
 *
 * Providers, models, and directories all come from the server; the browser
 * cannot name a provider or a directory the backend has not allowed.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { api, isAuthError } from "../lib/api";
import { baseName, relativeTime, shortPath } from "../lib/format";
import type { OptionsResponse, SessionView, ZetaSessionSummary } from "../lib/protocol";
import { Icon, Spinner } from "./Icon";
import { Node } from "./Node";
import { sessionTitle } from "./SessionHeader";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  options: OptionsResponse;
  onOpen: (session: SessionView) => void;
  onUnauthorized: () => void;
}

const RECENT_DIRECTORIES = 5;

export function StartPage({ options, onOpen, onUnauthorized }: Props): React.JSX.Element {
  const [provider, setProvider] = useState(
    options.default_provider ?? options.providers[0]?.name ?? "",
  );
  const models = options.providers.find((item) => item.name === provider)?.models ?? [];
  const [model, setModel] = useState(models[0] ?? "");
  const [cwd, setCwd] = useState("");
  const [running, setRunning] = useState<SessionView[]>([]);
  const [recent, setRecent] = useState<ZetaSessionSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  const fail = useCallback(
    (cause: unknown) => {
      if (isAuthError(cause)) {
        onUnauthorized();
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [onUnauthorized],
  );

  useEffect(() => {
    api
      .listSessions()
      .then((body) => setRunning(body.sessions))
      .catch(fail);
  }, [fail]);

  useEffect(() => {
    if (provider === "") {
      return;
    }
    let current = true;
    setRecent(null);
    api
      .zetaSessions(provider)
      .then((body) => {
        if (current) {
          setRecent(body.sessions);
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setRecent([]);
          fail(cause);
        }
      });
    return () => {
      current = false;
    };
  }, [provider, fail]);

  // Directories used by recent sessions come first in the picker.
  const recentDirectories = useMemo(() => {
    const allowed = new Set(options.directories);
    const seen: string[] = [];
    for (const session of recent ?? []) {
      if (allowed.has(session.cwd) && !seen.includes(session.cwd)) {
        seen.push(session.cwd);
      }
    }
    return seen.slice(0, RECENT_DIRECTORIES);
  }, [recent, options.directories]);
  const chosenCwd = cwd || recentDirectories[0] || options.directories[0] || "";

  const create = async (key: string, body: { cwd: string; resume?: string }) => {
    setBusy(key);
    setError(null);
    try {
      onOpen(
        await api.createSession({
          provider,
          model: model || null,
          cwd: body.cwd,
          resume_session_id: body.resume ?? null,
        }),
      );
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="start">
      <header className="start-head">
        <p className="wordmark">
          <Node kind="task" />
          gamma
        </p>
        <ThemeToggle />
      </header>

      <main className="start-main">
        <form
          className="new-session"
          aria-labelledby="new-session-title"
          onSubmit={(event) => {
            event.preventDefault();
            void create("new", { cwd: chosenCwd });
          }}
        >
          <h1 id="new-session-title">New session</h1>
          <p className="sentence">
            <span>Run</span>
            <label className="inline-field">
              <span className="visually-hidden">Provider</span>
              <select
                value={provider}
                onChange={(event) => {
                  const next = event.target.value;
                  setProvider(next);
                  setModel(options.providers.find((item) => item.name === next)?.models[0] ?? "");
                }}
              >
                {options.providers.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <span>with</span>
            <label className="inline-field">
              <span className="visually-hidden">Model</span>
              <select
                value={model}
                disabled={models.length === 0}
                onChange={(event) => setModel(event.target.value)}
              >
                {models.length === 0 && <option value="">the default model</option>}
                {models.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <span>in</span>
            <label className="inline-field is-path">
              <span className="visually-hidden">Directory</span>
              <select value={chosenCwd} onChange={(event) => setCwd(event.target.value)}>
                {recentDirectories.length > 0 && (
                  <optgroup label="Recent">
                    {recentDirectories.map((path) => (
                      <option key={`recent-${path}`} value={path}>
                        {shortPath(path, 2)}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="All allowed directories">
                  {options.directories
                    .filter((path) => !recentDirectories.includes(path))
                    .map((path) => (
                      <option key={path} value={path}>
                        {shortPath(path, 2)}
                      </option>
                    ))}
                </optgroup>
              </select>
            </label>
          </p>
          <div className="new-session-foot">
            <button
              type="submit"
              className="button primary"
              disabled={busy !== null || provider === "" || chosenCwd === ""}
            >
              {busy === "new" ? <Spinner size={12} /> : <Icon name="plus" size={14} />}
              Start session
            </button>
            <p className="hint">Tool calls that need approval wait for you.</p>
          </div>
          {error !== null && (
            <p className="field-error" role="alert">
              <Node kind="error" />
              {error}
            </p>
          )}
        </form>

        {running.length > 0 && (
          <section className="session-list" aria-labelledby="running-title">
            <h2 id="running-title">Running</h2>
            <ul>
              {running.map((session) => {
                const waiting = session.pending_approvals.length > 0;
                return (
                  <li key={session.session_id}>
                    <button type="button" className="session-item" onClick={() => onOpen(session)}>
                      <Node kind={waiting ? "waiting" : session.state === "idle" ? "idle" : "live"} />
                      <span className="session-item-title">{sessionTitle(session)}</span>
                      <span className="session-item-state">
                        {waiting ? "needs approval" : session.state === "idle" ? "idle" : "working"}
                      </span>
                      <span className="session-item-meta">
                        <span className="mono" title={session.cwd ?? undefined}>
                          {baseName(session.cwd)}
                        </span>
                        <span>{session.model ?? session.provider}</span>
                        <span>{relativeTime(session.last_activity * 1000, now)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="session-list" aria-labelledby="recent-title">
          <h2 id="recent-title">Recent</h2>
          {recent === null ? (
            <p className="list-empty">
              <Spinner size={12} /> Loading sessions…
            </p>
          ) : recent.length === 0 ? (
            <p className="list-empty">
              No past {provider} sessions in the allowed directories yet. Sessions you start are
              listed here to resume later.
            </p>
          ) : (
            <ul>
              {recent.map((session) => (
                <li key={session.session_id}>
                  <button
                    type="button"
                    className="session-item"
                    disabled={busy !== null}
                    onClick={() =>
                      void create(session.session_id, {
                        cwd: session.cwd,
                        resume: session.session_id,
                      })
                    }
                  >
                    <Node kind="done" />
                    <span className="session-item-title">
                      {session.name || session.first_message_preview || "Untitled session"}
                    </span>
                    <span className="session-item-state">
                      {busy === session.session_id ? <Spinner size={12} /> : "Resume"}
                    </span>
                    <span className="session-item-meta">
                      <span className="mono" title={session.cwd}>
                        {baseName(session.cwd)}
                      </span>
                      <span>{session.model}</span>
                      {session.updated_at !== null && (
                        <span>{relativeTime(Date.parse(session.updated_at), now)}</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
