/** One field: the access token the backend printed when it started. */

import { useState } from "react";

import { Node } from "./Node";

interface Props {
  rejected: boolean;
  onSubmit: (token: string) => void;
}

export function AuthScreen({ rejected, onSubmit }: Props): React.JSX.Element {
  const [token, setToken] = useState("");
  return (
    <main className="gate">
      <form
        className="gate-body"
        onSubmit={(event) => {
          event.preventDefault();
          if (token.trim() !== "") {
            onSubmit(token.trim());
          }
        }}
      >
        <p className="wordmark">
          <Node kind="task" />
          gamma
        </p>
        <h1>Access token</h1>
        <p className="gate-help">
          Paste the token the backend printed when it started. It stays in this tab only.
        </p>
        <label className="visually-hidden" htmlFor="token">
          Access token
        </label>
        <input
          id="token"
          className="input mono"
          type="password"
          value={token}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          aria-invalid={rejected}
          aria-describedby={rejected ? "token-error" : undefined}
          placeholder="Paste the token"
          onChange={(event) => setToken(event.target.value)}
        />
        {rejected && (
          <p className="field-error" id="token-error" role="alert">
            <Node kind="error" />
            The backend rejected that token. Copy it again from the backend output.
          </p>
        )}
        <button
          type="submit"
          className="button primary block"
          disabled={token.trim() === ""}
        >
          Continue
        </button>
        <p className="gate-foot">
          Running <code>make dev</code>? The token is passed to this page for you.
        </p>
      </form>
    </main>
  );
}
