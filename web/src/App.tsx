/**
 * The app shell: authenticate, then the start page or one session.
 *
 * Auth is checked once by loading the launch options. A rejected pasted
 * token is forgotten, so a fresh dev token (from `make dev`) takes over on
 * its own; with nothing left to try, the token screen asks.
 */

import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import { AuthScreen } from "./components/AuthScreen";
import { Node } from "./components/Node";
import { ProjectPage } from "./components/projects/ProjectPage";
import { ProjectsPage } from "./components/projects/ProjectsPage";
import { SessionPage } from "./components/SessionPage";
import { StartPage } from "./components/StartPage";
import { api, clearToken, isAuthError, readToken, writeToken } from "./lib/api";
import type { OptionsResponse, SessionView } from "./lib/protocol";

type Auth =
  | { kind: "checking" }
  | { kind: "needed"; rejected: boolean }
  | { kind: "ready"; options: OptionsResponse }
  | { kind: "offline"; message: string };

// Where in the app we are, under any session that is open on top.
type Nav = { kind: "start" } | { kind: "projects" } | { kind: "project"; id: string };

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
  const [nav, setNav] = useState<Nav>({ kind: "start" });

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
    setNav({ kind: "start" });
    setAuth({ kind: "needed", rejected: true });
  }, []);

  switch (auth.kind) {
    case "checking":
      return (
        <main className="splash" aria-busy="true">
          <p className="splash-note">
            <Node kind="live" />
            Connecting to the backend…
          </p>
        </main>
      );
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
        <main className="gate">
          <div className="gate-body">
            <p className="wordmark">
              <Node kind="task" />
              gamma
            </p>
            <h1>The backend is not running</h1>
            <p className="gate-help">
              Start it with <code>make dev</code> or <code>make backend</code>, then try again.
            </p>
            <p className="field-error">
              <Node kind="error" />
              {auth.message}
            </p>
            <button type="button" className="button primary block" onClick={() => void check()}>
              Try again
            </button>
          </div>
        </main>
      );
    case "ready":
      // A session opens on top of whatever navigation is underneath, so
      // leaving it returns to the page that opened it (start or a project).
      if (open !== null) {
        return (
          <SessionPage
            key={open.session_id}
            sessionId={open.session_id}
            initial={open}
            onLeave={() => setOpen(null)}
            onUnauthorized={unauthorized}
          />
        );
      }
      switch (nav.kind) {
        case "start":
          return (
            <StartPage
              options={auth.options}
              onOpen={setOpen}
              onProjects={() => setNav({ kind: "projects" })}
              onUnauthorized={unauthorized}
            />
          );
        case "projects":
          return (
            <ProjectsPage
              onOpenProject={(id) => setNav({ kind: "project", id })}
              onBack={() => setNav({ kind: "start" })}
              onUnauthorized={unauthorized}
            />
          );
        case "project":
          return (
            <ProjectPage
              key={nav.id}
              projectId={nav.id}
              onBack={() => setNav({ kind: "projects" })}
              onOpenSession={setOpen}
              onUnauthorized={unauthorized}
            />
          );
      }
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
