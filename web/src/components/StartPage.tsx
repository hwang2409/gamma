/**
 * The start page: resume a zeta session, or start a new one.
 *
 * Providers, models, and directories all come from the server; the browser
 * cannot name a provider or a directory the backend has not allowed.
 */

import { useCallback, useEffect, useState } from "react";

import { ApiError, api, readToken, writeToken } from "../lib/api";
import type { OptionsResponse, SessionView, ZetaSessionSummary } from "../lib/protocol";

interface Props {
  onOpen: (session: SessionView) => void;
}

export function StartPage({ onOpen }: Props): React.JSX.Element {
  const [token, setToken] = useState(readToken());
  const [options, setOptions] = useState<OptionsResponse | null>(null);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [cwd, setCwd] = useState("");
  const [resumable, setResumable] = useState<ZetaSessionSummary[]>([]);
  const [open, setOpen] = useState<SessionView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOptions = useCallback(async () => {
    setError(null);
    try {
      const loaded = await api.options();
      setOptions(loaded);
      const first = loaded.default_provider ?? loaded.providers[0]?.name ?? "";
      setProvider((current) => current || first);
      setCwd((current) => current || loaded.allowed_roots[0] || "");
      setOpen((await api.listSessions()).sessions);
    } catch (cause) {
      setError(describe(cause));
    }
  }, []);

  useEffect(() => {
    if (token !== "") {
      void loadOptions();
    }
  }, [token, loadOptions]);

  useEffect(() => {
    const models = options?.providers.find((item) => item.name === provider)?.models ?? [];
    setModel(models[0] ?? "");
  }, [provider, options]);

  useEffect(() => {
    if (provider === "" || token === "") {
      return;
    }
    let current = true;
    api
      .zetaSessions(provider)
      .then((body) => {
        if (current) {
          setResumable(body.sessions);
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setError(describe(cause));
        }
      });
    return () => {
      current = false;
    };
  }, [provider, token]);

  const create = async (resumeId?: string, resumeCwd?: string) => {
    setBusy(true);
    setError(null);
    try {
      const session = await api.createSession({
        provider,
        model: model || null,
        cwd: resumeCwd ?? cwd,
        resume_session_id: resumeId ?? null,
      });
      onOpen(session);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveToken = (event: React.FormEvent) => {
    event.preventDefault();
    writeToken(token);
    void loadOptions();
  };

  const models = options?.providers.find((item) => item.name === provider)?.models ?? [];

  return (
    <main className="start-page">
      <h1>gamma</h1>
      <p className="subtitle">A web front end for the zeta agent harness.</p>

      <section className="panel">
        <h2>Access token</h2>
        <p className="hint">
          The backend prints a token once when it starts. Paste it here; it stays in this tab
          only.
        </p>
        <form className="row" onSubmit={saveToken}>
          <label className="visually-hidden" htmlFor="token">
            Access token
          </label>
          <input
            id="token"
            type="password"
            value={token}
            autoComplete="off"
            onChange={(event) => setToken(event.target.value)}
          />
          <button type="submit">Use token</button>
        </form>
      </section>

      {error !== null && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {options !== null && (
        <>
          <section className="panel">
            <h2>New session</h2>
            <div className="grid">
              <label htmlFor="provider">
                Provider
                <select
                  id="provider"
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                >
                  {options.providers.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="model">
                Model
                <select
                  id="model"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                >
                  {models.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="cwd">
                Directory
                <select id="cwd" value={cwd} onChange={(event) => setCwd(event.target.value)}>
                  {options.directories.map((path) => (
                    <option key={path} value={path}>
                      {path}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="hint">
              Approval mode: {options.approval_mode}. Tool policy is set on the server.
            </p>
            <button type="button" disabled={busy || provider === ""} onClick={() => void create()}>
              Start session
            </button>
          </section>

          {open.length > 0 && (
            <section className="panel">
              <h2>Open gamma sessions</h2>
              <ul className="list">
                {open.map((session) => (
                  <li key={session.session_id}>
                    <button type="button" className="link" onClick={() => onOpen(session)}>
                      {session.provider} / {session.model} &mdash; {session.cwd}
                    </button>
                    <span className={`pill state-${session.state}`}>{session.state}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel">
            <h2>Resume a zeta session</h2>
            {resumable.length === 0 ? (
              <p className="hint">No sessions for {provider} inside the allowed roots.</p>
            ) : (
              <ul className="list">
                {resumable.map((session) => (
                  <li key={session.session_id}>
                    <button
                      type="button"
                      className="link"
                      disabled={busy}
                      onClick={() => void create(session.session_id, session.cwd)}
                    >
                      {session.name || session.first_message_preview || session.session_id}
                    </button>
                    <span className="fact mono">{session.cwd}</span>
                    <span className="fact">{session.updated_at ?? ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.status === 401 || cause.status === 403
      ? `${cause.message} (check the access token)`
      : cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
