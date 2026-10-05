# gamma

A web front end for the [zeta](../zeta) agent harness. Gamma is only a client:
it starts `zeta serve` processes and speaks its JSON-RPC protocol. It never
edits zeta itself.

v0 gives you a browser UI with a streaming transcript, tool cards, approval
prompts, steering, abort, usage counters, and reconnect that continues where
the tab left off.

## Why a backend at all

`zeta serve` accepts **one client** and holds **one active session**. A browser
cannot hold that socket across reloads, and several tabs cannot share it. So
gamma's backend owns the harness:

```
browser tab ─┐                           ┌─ zeta serve (session A)  ── Unix socket
browser tab ─┼─ WebSocket ─ gamma backend ┤
browser tab ─┘   (cursored events)        └─ zeta serve (session B)  ── Unix socket
                        │
                        └─ REST: options, sessions, status
```

One gamma session = one `zeta serve` child = one zeta session. Any number of
tabs attach to a gamma session; the backend fans events out to all of them and
keeps a ring buffer so a late or reconnecting tab replays what it missed.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the scaling path and the protocol
gaps gamma had to work around.

## Layout

```
backend/            FastAPI app, managed with uv
  src/gamma/
    zeta_protocol.py  the zeta wire protocol, isolated (typed models + client)
    runtime.py        ZetaRuntime seam: where a harness runs
    local_runtime.py  one zeta serve child per session, supervised
    events.py         cursored ring buffer and fan-out
    session.py        gamma sessions and the registry
    policy.py         what the browser may launch (provider, model, cwd)
    security.py       access token and Origin checks
    api_models.py     every HTTP and WebSocket message
    app.py            REST and the session WebSocket
  tests/              pytest, including tests against a real zeta serve
web/                Vite + React + TypeScript (pnpm)
  src/lib/transcript.ts   the event reducer (unit tested)
  src/lib/view.ts         derived view: tool groups, run phase, durations
  src/styles/tokens.css   every color, size, and timing
  src/dev/                the scripted fixture route (dev server only)
  e2e/                    Playwright screenshots and axe checks
  src/lib/useSessionSocket.ts  socket, auth, reconnect-by-cursor
  src/components/         start page, session page, cards, composer
scripts/smoke_e2e.py  end-to-end check with --provider fake
```

## Run it

Needs: `zeta` on `PATH`, `uv`, `pnpm`.

```sh
make dev           # backend and web dev server together
```

or separately:

```sh
make backend       # http://127.0.0.1:8777, prints an access token once
make web           # http://localhost:5173, proxies /api to the backend
```

`make dev` makes a new random token for each run and gives it to the backend
(`GAMMA_ACCESS_TOKEN`) and to the web dev server (`VITE_GAMMA_TOKEN`), so the
page opens already authenticated. The token is not written to disk.

When you run the parts separately, the backend prints its access token once
at start-up. Paste it into the token screen (it is kept in that tab's
`sessionStorage` only). A pasted token that the backend rejects is forgotten.

### Using the UI

| key | action |
| --- | --- |
| Enter / Shift+Enter | send / new line |
| Cmd/Ctrl+K or `/` | focus the composer |
| Cmd/Ctrl+Enter | approve the pending tool call |
| Cmd/Ctrl+Shift+Enter | always allow that tool (protocol 1.1) |
| Esc | deny the pending approval, else stop the running turn (not while the composer holds text) |

While a turn runs, a message steers that turn. The theme follows the system;
the button in the top bar forces light or dark.

In the dev server, `#/fixture`, `#/fixture/streaming`, and `#/fixture/empty`
show the session screen over a scripted transcript with tool calls, failures,
denials, and a pending approval. The fake provider cannot call tools, so this
is the way to see those states. Production builds do not include it.

## Configuration

All settings come from `GAMMA_*` environment variables (or `backend/.env`).

| variable | default | meaning |
| --- | --- | --- |
| `GAMMA_HOST`, `GAMMA_PORT` | `127.0.0.1`, `8777` | bind address; keep it local |
| `GAMMA_ACCESS_TOKEN` | random each start | token for REST and WebSocket |
| `GAMMA_ALLOWED_ORIGINS` | `http://localhost:5173` | comma-separated WebSocket origins |
| `GAMMA_ZETA_BIN` | `zeta` | harness binary |
| `GAMMA_ALLOWED_PROVIDERS` | `fake,claude,codex` | providers the browser may pick |
| `GAMMA_ALLOWED_MODELS` | built-in map (JSON) | models per provider |
| `GAMMA_ALLOWED_ROOTS` | `~/me/fun` | `:`-separated roots a session cwd must be inside |
| `GAMMA_ZETA_ENV` | `{}` | extra environment for each child (JSON), for example `ZETA_HOME` |
| `GAMMA_ANTHROPIC_OAUTH_COMPAT` | `true` | sets `ZETA_ANTHROPIC_OAUTH_COMPAT=1` for each child so Claude subscription logins work (an explicit value in `GAMMA_ZETA_ENV` wins) |
| `GAMMA_TOOLS`, `GAMMA_DISALLOWED_TOOLS`, `GAMMA_REQUIRE_TOOLS` | unset | tool policy passed to `zeta serve` |
| `GAMMA_MAX_SESSIONS` | `8` | open sessions per backend |
| `GAMMA_SESSION_IDLE_TIMEOUT_SECONDS` | `3600` | idle sessions are closed and reaped |
| `GAMMA_EVENT_BUFFER_CAPACITY` | `1000` | replayable events per session |

### Security in v0

- The backend binds `127.0.0.1` only.
- Every REST call needs the token in `X-Gamma-Token` (or the `gamma_token`
  cookie plus an allowed `Origin`). Missing credentials give 401, wrong ones
  403. Tokens are never logged.
- The WebSocket checks `Origin` against the allowlist before the handshake,
  then takes the token from the first message (preferred) or a query parameter.
- The browser chooses only a provider, a model from the server allowlist, and a
  directory that must exist inside an allowed root (resolved first, so symlinks
  and `..` cannot escape). Tool policy and approval mode are server-side.
- Approval mode is `ask`: every approval request reaches the UI.
- Model and tool text render through `react-markdown` with raw HTML off, and an
  ESLint rule bans `dangerouslySetInnerHTML`.

## Tests

```sh
make test          # backend pytest, web vitest, build, lint, typecheck
make smoke         # end-to-end: real backend + real zeta serve --provider fake
```

Browser checks (screenshots in light and dark at 1440x900 and 390x844, and
axe accessibility checks) run against a running dev setup whose backend allows
the `fake` provider:

```sh
cd web && GAMMA_WEB_URL=http://localhost:5173 pnpm e2e   # screenshots go to /tmp/gamma-screens
```

Backend tests drive a real `zeta serve --provider fake` (no API keys) for the
runtime, session, and resume paths, and a test double for the API surface.
