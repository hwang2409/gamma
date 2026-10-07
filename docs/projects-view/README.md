# Projects view

A read-only view of the projects Zeta knows: which session ids belong to which
project, the project memory rendered nicely, its change history, the sessions
grouped by orchestrator, and the project inbox.

The backend answers each read through a short-lived `zeta serve` connection and
the negotiated `projects` feature; the browser never holds that socket. If the
running Zeta does not offer the feature, the view asks the user to update Zeta.

The screenshots below are produced by `web/e2e/projects.spec.ts`, which stubs
`/api` so it needs only the web dev server (no backend and no `zeta serve`):

```sh
cd web && pnpm exec vite --port 5219 --strictPort &
GAMMA_WEB_URL=http://localhost:5219 GAMMA_SCREENS_DIR=/tmp/gamma-projects-screens \
  pnpm exec playwright test projects.spec.ts
```

| view | light | dark |
| --- | --- | --- |
| Projects list | `projects-list-light.png` | `projects-list-dark.png` |
| Memory | `project-memory-light.png` | `project-memory-dark.png` |
| History (diff) | `project-history-light.png` | `project-history-dark.png` |
| Sessions | `project-sessions-light.png` | `project-sessions-dark.png` |
| Inbox | `project-inbox-light.png` | `project-inbox-dark.png` |
