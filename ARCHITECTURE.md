# gamma architecture

## v0 shape

```
                    ┌──────────────────────── gamma backend (FastAPI, 127.0.0.1) ────────────────────────┐
  browser           │                                                                                   │
  ┌──────────┐      │  REST   /api/options  /api/zeta-sessions  /api/sessions  /api/sessions/{id}        │
  │ start    │─────▶│                                                                                    │
  │ page     │      │  WS     /api/sessions/{id}/ws   (events out, commands in)                          │
  └──────────┘      │                                                                                    │
  ┌──────────┐      │  ┌───────────────┐    ┌──────────────┐    ┌──────────────────┐                     │
  │ session  │◀────▶│  │ SessionManager│───▶│ GammaSession │───▶│ LocalProcessRuntime │──┐               │
  │ page     │      │  │ registry      │    │ bus + state  │    │ (ZetaRuntime seam) │  │               │
  └──────────┘      │  └───────────────┘    └──────┬───────┘    └──────────────────┘  │               │
  ┌──────────┐      │                              │ EventBus (cursors + ring buffer)  │               │
  │ 2nd tab  │◀────▶│──────────────────────────────┘                                   │               │
  └──────────┘      └──────────────────────────────────────────────────────────────────│───────────────┘
                                                                                       ▼
                                                        zeta serve --socket <tmp>/serve.sock --provider ...
                                                        (one child process per gamma session)
```

Data flow for one turn:

1. The tab sends `{"type":"send","text":...}` on its WebSocket.
2. `GammaSession.send` calls the zeta `send` request, then publishes
   `gamma_user_message` on the bus (zeta does not echo the user's text).
3. The zeta read loop is the event pump: each notification updates derived
   state (run state, usage, pending approvals) and is published with the next
   cursor.
4. Every attached socket streams from its own cursor. A reconnecting socket
   passes `?cursor=N` and the bus replays the buffered tail first.

### Deliberate seams

- **`zeta_protocol.py`** is the only module that knows the wire format: frame
  size, the `hello` handshake, request names, event shapes. A zeta protocol
  change touches one file.
- **`ZetaRuntime`** (`runtime.py`) is the only module that knows *where* a
  harness runs. `LocalProcessRuntime` spawns a child here; a `RemoteRuntime`
  (Modal sandbox, remote host, container) implements `launch` and
  `RuntimeConnection` and nothing else moves.
- **`EventBus`** is the only module that knows about fan-out and replay. Its
  interface is `publish` / `subscribe(after_cursor)`, which a Redis or NATS
  implementation can satisfy unchanged.
- **`LaunchPolicy`** owns every rule about what the browser may ask for. The
  API layer never builds a process argument itself.

## Scaling path

| step | what changes | what does not |
| --- | --- | --- |
| more tabs per session | nothing; the bus already fans out | — |
| more sessions per host | raise `GAMMA_MAX_SESSIONS`; add a process pool and queueing in `LocalProcessRuntime` | the API, the UI |
| several backend replicas | replace `EventBus` with Redis Streams or NATS (`publish`/`subscribe(after_cursor)` maps directly onto both), and move `SessionManager`'s registry into shared storage | `GammaSession`, the UI reducer |
| transcript that survives a restart | append every event to a durable log (SQLite, then Postgres) behind the same cursor interface, and replay from the log instead of the ring buffer | the cursor contract the UI already uses |
| remote harnesses | add `RemoteRuntime` (sandbox API or SSH + socket forwarding) behind `ZetaRuntime` | sessions, events, API, UI |
| real auth | replace the single token with OIDC or an identity header, and scope sessions to a user; keep the token path for local dev | the WebSocket protocol |

The cursor on every event is the load-bearing decision: it lets the UI
reconnect, and it is also what makes a durable log or an external broker a drop-in
later.

## Protocol gaps in `zeta serve`

These are things gamma had to design around. Line numbers refer to
`zeta/docs/serve-protocol.md`.

1. **One client, one active session per server** (line 7, line 119). Gamma must
   run a `zeta serve` process per session, which costs a process start-up per
   session and makes "list sessions" need a throw-away process. A multiplexed
   server (session-addressed requests, several concurrent sessions, several
   clients) would let one harness serve a whole gamma backend.
2. **No `cwd` in `new_session`** (line 78). The working directory is only a
   process argument (`zeta serve --cwd`). Because the browser picks a directory
   per session, gamma cannot reuse a server even when the provider matches.
3. **`resume` ignores the stored session `cwd`** (line 95). The server composes
   every session with its own launch `cwd`
   (`src/zeta/server/runtime.py`, `_compose(cwd=self.cwd, ...)`), so a resumed
   session runs tools in the server's directory, not the one in its metadata.
   Gamma works around this by reading the session's `cwd` from `list_sessions`
   and relaunching the harness there; a client that does not know this silently
   runs tools in the wrong tree. Either `resume` should re-root the session, or
   the document should say the client must do it.
4. **No way to read the session list without taking the socket** (line 53).
   Gamma starts a short-lived harness just to call `list_sessions`, then closes
   it. A read-only or pre-handshake listing request would remove that.
5. **No event for the user's own message** (line 362 event table). Nothing on
   the wire reports the text a client sent, so a second tab or a reconnect
   cannot rebuild the conversation from events alone. Gamma publishes its own
   `gamma_user_message`. `session_history` (line 456) can backfill, but it is
   paginated at eight messages per page and is not part of the stream.
6. **1.1 extensions report a missing `session_id` as "no active session"**
   (line 433). `model_catalog` with `params: {}` returns `-32003 session is not
   active` even when a session *is* active; a missing required parameter should
   be `-32602`. The error sent us looking for a session bug that did not exist.
7. **Documented `SessionMetadata` does not match the wire** (line 56, line 309).
   A real response also contains `compaction`, `compaction_pinned`,
   `agent_catalog`, `skill_catalog`, `project_id`, `project_role`,
   `project_memory_*`, `parent_session_id`, `tool_allow`, and `tool_deny`.
   Gamma keeps unknown keys on purpose, but a client that validates strictly
   against the document would reject every response.
8. **A disconnect cancels the turn and aborts pending approvals** (lines 396 to
   398). The gamma backend therefore has to stay up for the whole run; a
   backend restart kills in-flight turns. Durable, session-addressed turns that
   survive a client reconnect would make gamma restartable.
9. **No spectator mode.** Gamma implements "many watchers" above zeta. A
   read-only attach (events without the right to send) would let gamma hand out
   view-only links without proxying everything.
10. **`list_sessions` truncation cannot be paged** (line 416). The response
    carries `truncated` and `next_offset`, but no request takes an offset, so a
    large session set is simply unreachable. Gamma logs a warning and shows the
    first page.
11. **No heartbeat.** Neither side can detect a half-dead peer. Gamma watches
    the child process instead, which does not catch a hung-but-alive harness.
12. **`abort` emits no `turn_aborted` event** in our runs, although the event
    exists (line 362); the state returns to `idle` and the stream simply stops.
    A client that waits for `turn_aborted` would wait forever.
13. **`--provider fake` cannot produce tool calls or approvals**
    (`src/zeta/server/fake_backend.py` streams one text message). There is no
    key-free way to test the tool-card and approval paths against a real server,
    so gamma covers them with a test double. A scripted fake backend
    (tool call, output, approval request) would make offline conformance tests
    possible for every client.
