/**
 * Screenshots of the projects view, for people to look at (not compared).
 *
 * This spec needs only the web dev server: every `/api` call is stubbed, so
 * no backend and no `zeta serve` run. A token is seeded so the shell skips
 * the auth screen. Run it after starting the dev server, for example:
 *   GAMMA_SCREENS_DIR=/tmp/gamma-screens pnpm e2e projects.spec.ts
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

const SCREENS = process.env.GAMMA_SCREENS_DIR ?? "/tmp/gamma-screens";
mkdirSync(SCREENS, { recursive: true });

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const OPTIONS = {
  providers: [{ name: "codex", models: ["gpt-x"] }],
  default_provider: "codex",
  allowed_roots: ["/Users/henry/me/fun"],
  directories: ["/Users/henry/me/fun/zeta"],
  approval_mode: "ask",
};

const PROJECTS = {
  projects: [
    {
      id: "p_aa3887a0fab4f662bdb5a967994eafbb",
      name: "Zeta",
      scope: "repo",
      roots: ["/Users/henry/me/fun/zeta"],
      session_count: 42,
      last_activity: new Date(Date.now() - 6 * 60_000).toISOString(),
    },
    {
      id: "p_45e1fb1d71a96f0f0873c7ee001077b1",
      name: "Phoebe",
      scope: "repo",
      roots: ["/Users/henry/me/fun/phoebe"],
      session_count: 7,
      last_activity: new Date(Date.now() - 3 * 3600_000).toISOString(),
    },
    {
      id: "p_c0ffee0000000000000000000000beef",
      name: "Gamma",
      scope: "repo",
      roots: ["/Users/henry/me/fun/gamma"],
      session_count: 3,
      last_activity: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    },
  ],
  next_offset: null,
  truncated: false,
};

const DETAIL = {
  project: {
    ...PROJECTS.projects[0],
    created_at: "2026-09-01T00:00:00Z",
    updated_at: new Date(Date.now() - 6 * 60_000).toISOString(),
  },
  memory: {
    version_id: "v_8f21",
    digest: "2cc36785aa10",
    files: [
      {
        name: "brief.md",
        content:
          "# Brief\n\nZeta is an agent harness. Automatic project-memory\nreconciliation runs before context eviction and filters secrets.\n\n- Transcript chunks are capped at **96 KiB**.\n- Provider requests are capped at **64 KiB**.",
        automatic: false,
        content_truncated: false,
      },
      {
        name: "state.md",
        content:
          "# Current state\n\nPR #386 is mergeable. `zeta serve` exposes read-only\nproject requests used before a session is attached.",
        automatic: true,
        content_truncated: false,
      },
      {
        name: "backlog.md",
        content: "# Backlog\n\n- Scrollable subagent transcript inspection.\n- Fuzzy message finder.",
        automatic: false,
        content_truncated: false,
      },
      { name: "changelog.md", content: "# Changelog\n\n## 2026-10-07\n- Merged the memory mirror.", automatic: false, content_truncated: false },
      { name: "decisions.md", content: "", automatic: false, content_truncated: false },
    ],
  },
};

const LOG = {
  versions: [
    {
      version_id: "v_8f21",
      timestamp: new Date(Date.now() - 6 * 60_000).toISOString(),
      kind: "auto",
      files_changed: ["state.md"],
      provenance: { session_id: "s_7c21", seq_start: 180, seq_end: 204, model: "gpt-5.6-luna" },
      provenance_truncated: false,
      target_version_id: "v_7a02",
    },
    {
      version_id: "v_7a02",
      timestamp: new Date(Date.now() - 50 * 60_000).toISOString(),
      kind: "accept",
      files_changed: ["brief.md"],
      provenance: { accepted_by: "henry" },
      provenance_truncated: false,
      target_version_id: "v_61a9",
    },
    {
      version_id: "v_61a9",
      timestamp: new Date(Date.now() - 2 * 3600_000).toISOString(),
      kind: "remote_sync",
      files_changed: ["backlog.md"],
      provenance: { peer: "phoebe", source: "remote_sync" },
      provenance_truncated: false,
      target_version_id: null,
    },
  ],
  next_offset: null,
  truncated: false,
};

const DIFF = {
  ...LOG.versions[0],
  file: "state.md",
  content: "# Current state\n\nPR #386 is mergeable.",
  content_truncated: false,
  diff:
    "@@ -1,3 +1,4 @@\n # Current state\n \n-PR #386 is under review.\n+PR #386 is mergeable. `zeta serve` exposes read-only\n+project requests used before a session is attached.",
  diff_truncated: false,
};

const SESSIONS = {
  sessions: [
    {
      session_id: "s_7c21",
      name: "Projects view in gamma",
      provider: "codex",
      model: "gpt-x",
      cwd: "/Users/henry/me/fun/gamma",
      project_role: "orchestrator",
      parent_session_id: null,
      updated_at: new Date(Date.now() - 6 * 60_000).toISOString(),
      first_message_preview: "Build a projects view in gamma",
    },
    {
      session_id: "s_124",
      name: "Backend read-only endpoints",
      provider: "codex",
      model: "gpt-x",
      cwd: "/Users/henry/me/fun/gamma",
      project_role: "worker",
      parent_session_id: "s_7c21",
      updated_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      first_message_preview: "Negotiate the projects feature",
    },
    {
      session_id: "s_139",
      name: "Projects view UI",
      provider: "codex",
      model: "gpt-x",
      cwd: "/Users/henry/me/fun/gamma",
      project_role: "worker",
      parent_session_id: "s_7c21",
      updated_at: new Date(Date.now() - 4 * 60_000).toISOString(),
      first_message_preview: "Finish the frontend",
    },
  ],
  truncated: false,
};

const INBOX = {
  status: "new",
  messages: [
    {
      id: "m_1",
      origin: "local",
      from_project: null,
      from_session: "s_7c21",
      to_project: "p_aa3887a0fab4f662bdb5a967994eafbb",
      kind: "question",
      title: "Survey how coding agents ship scheduled work",
      body: "Compile how Codex, Claude, Cursor, Devin, and Jules implement scheduled and triggered agent work. End with a comparison table.",
      in_reply_to: null,
      created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      claimer_session: null,
      claimed_at: null,
      outcome: null,
      reply: null,
      done_at: null,
      truncated_fields: [],
    },
    {
      id: "m_2",
      origin: "cross-project",
      from_project: "p_45e1fb1d71a96f0f0873c7ee001077b1",
      from_session: null,
      to_project: "p_aa3887a0fab4f662bdb5a967994eafbb",
      kind: "note",
      title: "Memory sync peer online",
      body: "Phoebe is reachable for remote session pull.",
      in_reply_to: null,
      created_at: new Date(Date.now() - 90 * 60_000).toISOString(),
      claimer_session: null,
      claimed_at: null,
      outcome: null,
      reply: null,
      done_at: null,
      truncated_fields: [],
    },
  ],
  untrusted: true,
  next_offset: null,
  truncated: false,
};

async function stub(page: Page): Promise<void> {
  await page.addInitScript(() => window.sessionStorage.setItem("gamma.token", "screens"));
  await page.route("**/api/options", (route) => route.fulfill(json(OPTIONS)));
  await page.route(/\/api\/zeta-sessions/, (route) => route.fulfill(json({ sessions: [] })));
  await page.route(/\/api\/sessions$/, (route) => route.fulfill(json({ sessions: [] })));
  await page.route("**/api/projects", (route) => route.fulfill(json(PROJECTS)));
  await page.route(/\/api\/projects\/[^/]+$/, (route) => route.fulfill(json(DETAIL)));
  await page.route(/\/api\/projects\/[^/]+\/memory\/log$/, (route) => route.fulfill(json(LOG)));
  await page.route(/\/api\/projects\/[^/]+\/memory\/versions\//, (route) =>
    route.fulfill(json(DIFF)),
  );
  await page.route(/\/api\/projects\/[^/]+\/sessions$/, (route) => route.fulfill(json(SESSIONS)));
  await page.route(/\/api\/projects\/[^/]+\/inbox/, (route) => route.fulfill(json(INBOX)));
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENS, `${name}.png`), animations: "disabled" });
}

const THEMES = ["light", "dark"] as const;

for (const theme of THEMES) {
  test(`projects screens ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await stub(page);

    await page.goto("/");
    await page.getByRole("button", { name: "Projects" }).click();
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(page.getByText("Zeta", { exact: true })).toBeVisible();
    await shoot(page, `projects-list-${theme}`);

    await page.getByText("Zeta", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Zeta" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Brief" })).toBeVisible();
    await shoot(page, `project-memory-${theme}`);

    await page.getByRole("button", { name: "History" }).click();
    await expect(page.getByText("session s_7c21 #180–204")).toBeVisible();
    await page.getByRole("button", { name: "state.md" }).first().click();
    await expect(page.getByText(/project requests used before/).first()).toBeVisible();
    await shoot(page, `project-history-${theme}`);

    await page.getByRole("button", { name: "Sessions" }).click();
    await expect(page.getByText("Projects view in gamma")).toBeVisible();
    await expect(page.getByText("Backend read-only endpoints")).toBeVisible();
    await shoot(page, `project-sessions-${theme}`);

    await page.getByRole("button", { name: "Inbox" }).click();
    await expect(page.getByText(/Survey how coding agents/)).toBeVisible();
    await expect(page.getByText(/message from another project/)).toBeVisible();
    await shoot(page, `project-inbox-${theme}`);
  });
}
