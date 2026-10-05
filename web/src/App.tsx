/**
 * The app shell: authenticate, then the start page or one session.
 *
 * Auth is checked once by loading the launch options. A rejected pasted
 * token is forgotten, so a fresh dev token (from `make dev`) takes over on
 * its own; with nothing left to try, the token screen asks.
 */

import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import { AuthScreen } from "./components/AuthScreen";
import { SessionPage } from "./components/SessionPage";
import { StartPage } from "./components/StartPage";
import { api, clearToken, isAuthError, readToken, writeToken } from "./lib/api";
import type { OptionsResponse, SessionView } from "./lib/protocol";

type Auth =
  | { kind: "checking" }
  | { kind: "needed"; rejected: boolean }
  | { kind: "ready"; options: OptionsResponse }
  | { kind: "offline"; message: string };

const FixturePage = import.meta.env.DEV ? lazy(() => import("./dev/FixturePage")) : null;

export function App(): React.JSX.Element {
  if (FixturePage !== null && window.location.hash.startsWith("#/fixture")) {
    return (
      <Suspense fallback={null}>
        <FixturePage />
      </Suspense>
    );
  }
  return <Shell />;
}

function Shell(): React.JSX.Element {
  const [auth, setAuth] = useState<Auth>({ kind: "checking" });
  const [open, setOpen] = useState<SessionView | null>(null);

  const check = useCallback(async () => {
    setAuth({ kind: "checking" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = readToken();
      if (token === "") {
        setAuth({ kind: "needed", rejected: false });
        return;
      }
      try {
        setAuth({ kind: "ready", options: await api.options() });
        return;
      } catch (cause) {
        if (!isAuthError(cause)) {
          setAuth({ kind: "offline", message: describe(cause) });
          return;
        }
        clearToken();
        if (readToken() === token) {
          break; // the dev token itself was rejected; nothing else to try
        }
      }
    }
    setAuth({ kind: "needed", rejected: true });
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const unauthorized = useCallback(() => {
    clearToken();
    setOpen(null);
    setAuth({ kind: "needed", rejected: true });
  }, []);

  switch (auth.kind) {
    case "checking":
      return <main className="splash" aria-busy="true" />;
    case "needed":
      return (
        <AuthScreen
          rejected={auth.rejected}
          onSubmit={(token) => {
            writeToken(token);
            void check();
          }}
        />
      );
    case "offline":
      return (
        <main className="auth">
          <div className="auth-card">
            <p className="wordmark">gamma</p>
            <h1>Backend unreachable</h1>
            <p className="auth-help">{auth.message}</p>
            <p className="auth-help">
              Start it with <code>make dev</code> or <code>make backend</code>.
            </p>
            <button type="button" className="button primary block" onClick={() => void check()}>
              Try again
            </button>
          </div>
        </main>
      );
    case "ready":
      return open === null ? (
        <StartPage options={auth.options} onOpen={setOpen} onUnauthorized={unauthorized} />
      ) : (
        <SessionPage
          key={open.session_id}
          sessionId={open.session_id}
          initial={open}
          onLeave={() => setOpen(null)}
          onUnauthorized={unauthorized}
        />
      );
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
