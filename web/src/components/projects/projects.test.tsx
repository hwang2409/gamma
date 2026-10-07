/**
 * Rendering tests for the projects view.
 *
 * The REST client is mocked so each view runs against canned protocol data;
 * `ApiError`, `isAuthError`, and `isUnsupported` stay real so the shared
 * loading / error / "update Zeta" states behave as they do in the app.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  MemoryLogResponse,
  MemoryVersionDetail,
  ProjectDetailResponse,
  ProjectInboxResponse,
  ProjectListResponse,
  ProjectSessionsResponse,
  SessionView,
} from "../../lib/protocol";
import { ProjectHistory } from "./ProjectHistory";
import { ProjectInbox } from "./ProjectInbox";
import { ProjectMemory } from "./ProjectMemory";
import { ProjectSessions } from "./ProjectSessions";
import { ProjectsPage } from "./ProjectsPage";

const { api, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      projects: vi.fn(),
      project: vi.fn(),
      projectMemoryLog: vi.fn(),
      projectMemoryVersion: vi.fn(),
      projectSessions: vi.fn(),
      projectInbox: vi.fn(),
      createSession: vi.fn(),
    },
  };
});

vi.mock("../../lib/api", () => ({
  api,
  ApiError,
  isAuthError: (cause: unknown) =>
    cause instanceof ApiError && (cause.status === 401 || cause.status === 403),
  isUnsupported: (cause: unknown) => cause instanceof ApiError && cause.status === 501,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const noop = () => {};

const projectList: ProjectListResponse = {
  projects: [
    {
      id: "p_alpha",
      name: "Zeta",
      scope: "repo",
      roots: ["/Users/henry/me/fun/zeta"],
      session_count: 3,
      last_activity: "2026-10-07T12:00:00Z",
    },
    {
      id: "p_beta",
      name: "Gamma",
      scope: "repo",
      roots: ["/Users/henry/me/fun/gamma"],
      session_count: 1,
      last_activity: null,
    },
  ],
  next_offset: null,
  truncated: false,
};

describe("ProjectsPage", () => {
  it("lists projects by name with their ids and session counts", async () => {
    api.projects.mockResolvedValue(projectList);
    render(<ProjectsPage onOpenProject={noop} onBack={noop} onUnauthorized={noop} />);

    expect(await screen.findByText("Zeta")).toBeTruthy();
    expect(screen.getByText("Gamma")).toBeTruthy();
    expect(screen.getByText("3 sessions")).toBeTruthy();
    expect(screen.getByText("1 session")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Copy project id" })).toHaveLength(2);
  });

  it("opens a project when its row is clicked", async () => {
    api.projects.mockResolvedValue(projectList);
    const onOpenProject = vi.fn();
    render(<ProjectsPage onOpenProject={onOpenProject} onBack={noop} onUnauthorized={noop} />);

    fireEvent.click(await screen.findByText("Zeta"));
    expect(onOpenProject).toHaveBeenCalledWith("p_alpha");
  });

  it("shows an empty state when there are no projects", async () => {
    api.projects.mockResolvedValue({ projects: [], next_offset: null, truncated: false });
    render(<ProjectsPage onOpenProject={noop} onBack={noop} onUnauthorized={noop} />);
    expect(await screen.findByText(/No projects yet/)).toBeTruthy();
  });

  it("asks the user to update Zeta when the feature is absent", async () => {
    api.projects.mockRejectedValue(new ApiError(501, "projects feature not offered"));
    render(<ProjectsPage onOpenProject={noop} onBack={noop} onUnauthorized={noop} />);
    expect(await screen.findByText(/does not serve projects yet/)).toBeTruthy();
  });

  it("hands an expired token back to the shell", async () => {
    api.projects.mockRejectedValue(new ApiError(401, "token expired"));
    const onUnauthorized = vi.fn();
    render(<ProjectsPage onOpenProject={noop} onBack={noop} onUnauthorized={onUnauthorized} />);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });

  it("shows the message on a server error", async () => {
    api.projects.mockRejectedValue(new ApiError(502, "project storage is invalid or unavailable"));
    render(<ProjectsPage onOpenProject={noop} onBack={noop} onUnauthorized={noop} />);
    expect(await screen.findByText(/project storage is invalid/)).toBeTruthy();
  });
});

const detail: ProjectDetailResponse = {
  project: {
    id: "p_alpha",
    name: "Zeta",
    scope: "repo",
    roots: ["/Users/henry/me/fun/zeta"],
    session_count: 3,
    last_activity: "2026-10-07T12:00:00Z",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-10-07T12:00:00Z",
  },
  memory: {
    version_id: "v_42",
    digest: "abcdef0123456789",
    files: [
      { name: "brief.md", content: "# Brief\n\nThe project.", automatic: false, content_truncated: false },
      { name: "state.md", content: "# State\n\nIn flight.", automatic: true, content_truncated: true },
      { name: "backlog.md", content: "", automatic: false, content_truncated: false },
    ],
  },
};

describe("ProjectMemory", () => {
  it("renders files as markdown with the automatic badge and the version", () => {
    render(<ProjectMemory memory={detail.memory} />);
    expect(screen.getByText("brief.md")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Brief" })).toBeTruthy();
    expect(screen.getByText("automatic")).toBeTruthy();
    expect(screen.getByText(/written automatically/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy version id" })).toBeTruthy();
    expect(screen.getByText("empty")).toBeTruthy();
  });
});

const log: MemoryLogResponse = {
  versions: [
    {
      version_id: "v_1",
      timestamp: "2026-10-01T00:00:00Z",
      kind: "auto",
      files_changed: ["state.md"],
      provenance: { session_id: "s_1", seq_start: 10, seq_end: 20, model: "gpt-x" },
      provenance_truncated: false,
      target_version_id: null,
    },
    {
      version_id: "v_2",
      timestamp: "2026-10-02T00:00:00Z",
      kind: "accept",
      files_changed: ["brief.md"],
      provenance: { accepted_by: "henry", peer: "phoebe" },
      provenance_truncated: false,
      target_version_id: "v_1",
    },
  ],
  next_offset: null,
  truncated: false,
};

describe("ProjectHistory", () => {
  it("shows versions newest first with provenance and loads a diff on click", async () => {
    api.projectMemoryLog.mockResolvedValue(log);
    const diff: MemoryVersionDetail = {
      ...(log.versions[0] as (typeof log.versions)[number]),
      file: "state.md",
      content: "new",
      content_truncated: false,
      diff: "@@ -1 +1 @@\n-old\n+new",
      diff_truncated: false,
    };
    api.projectMemoryVersion.mockResolvedValue(diff);

    render(<ProjectHistory projectId="p_alpha" onUnauthorized={noop} />);

    const entries = await screen.findAllByText(/session s_1|accepted by henry/);
    expect(entries.length).toBeGreaterThan(0);
    expect(screen.getByText("session s_1 #10–20")).toBeTruthy();
    expect(screen.getByText("accepted by henry")).toBeTruthy();
    expect(screen.getByText("synced from phoebe")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "state.md" }));
    expect(await screen.findByText("+new")).toBeTruthy();
    expect(api.projectMemoryVersion).toHaveBeenCalledWith("p_alpha", "v_1", "state.md");
  });
});

const sessions: ProjectSessionsResponse = {
  sessions: [
    {
      session_id: "s_root",
      name: "Orchestrator",
      provider: "codex",
      model: "gpt-x",
      cwd: "/Users/henry/me/fun/zeta",
      project_role: "orchestrator",
      parent_session_id: null,
      updated_at: "2026-10-07T12:00:00Z",
      first_message_preview: "Do the thing",
    },
    {
      session_id: "s_child",
      name: "Worker",
      provider: "codex",
      model: "gpt-x",
      cwd: "/Users/henry/me/fun/zeta",
      project_role: "worker",
      parent_session_id: "s_root",
      updated_at: "2026-10-07T12:05:00Z",
      first_message_preview: "A bounded contract",
    },
  ],
  truncated: false,
};

describe("ProjectSessions", () => {
  it("nests a worker under its orchestrator and resumes on click", async () => {
    api.projectSessions.mockResolvedValue(sessions);
    const resumed = { session_id: "g_new" } as SessionView;
    api.createSession.mockResolvedValue(resumed);
    const onOpenSession = vi.fn();

    render(
      <ProjectSessions projectId="p_alpha" onOpenSession={onOpenSession} onUnauthorized={noop} />,
    );

    const tree = (await screen.findByText("Orchestrator")).closest("ul");
    expect(tree?.querySelector(".session-children")).toBeTruthy();
    expect(screen.getByText("Worker")).toBeTruthy();

    fireEvent.click(screen.getByText("Worker"));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith(resumed));
    expect(api.createSession).toHaveBeenCalledWith({
      provider: "codex",
      model: "gpt-x",
      cwd: "/Users/henry/me/fun/zeta",
      resume_session_id: "s_child",
    });
  });
});

function inbox(overrides: Partial<ProjectInboxResponse> = {}): ProjectInboxResponse {
  return {
    status: "new",
    messages: [
      {
        id: "m_1",
        origin: "local",
        from_project: null,
        from_session: "s_1",
        to_project: "p_alpha",
        kind: "question",
        title: "Find prior work",
        body: "Please survey the field.",
        in_reply_to: null,
        created_at: "2026-10-07T00:00:00Z",
        claimer_session: null,
        claimed_at: null,
        outcome: null,
        reply: null,
        done_at: null,
        truncated_fields: [],
      },
    ],
    untrusted: false,
    next_offset: null,
    truncated: false,
    ...overrides,
  };
}

describe("ProjectInbox", () => {
  it("shows messages and reloads when the status segment changes", async () => {
    api.projectInbox.mockResolvedValue(inbox());
    render(<ProjectInbox projectId="p_alpha" onUnauthorized={noop} />);

    expect(await screen.findByText("Find prior work")).toBeTruthy();
    expect(screen.getByText("question")).toBeTruthy();
    expect(api.projectInbox).toHaveBeenCalledWith("p_alpha", "new");

    fireEvent.click(screen.getByRole("tab", { name: "Done" }));
    await waitFor(() => expect(api.projectInbox).toHaveBeenCalledWith("p_alpha", "done"));
  });

  it("warns only when the page carries a message from another project", async () => {
    api.projectInbox.mockResolvedValue(
      inbox({
        untrusted: true,
        messages: [
          {
            ...(inbox().messages[0] as ProjectInboxResponse["messages"][number]),
            id: "m_foreign",
            origin: "cross-project",
            from_project: "p_other",
            from_session: null,
          },
        ],
      }),
    );
    render(<ProjectInbox projectId="p_alpha" onUnauthorized={noop} />);

    expect(await screen.findByText(/message from another project/)).toBeTruthy();
    const card = screen.getByText("Find prior work").closest(".inbox-card") as HTMLElement;
    expect(within(card).getByText("cross-project")).toBeTruthy();
  });
});
