/**
 * One project: a top bar that names it, then the Memory, History, Sessions,
 * and Inbox tabs. Each tab loads its own data when first shown, so opening a
 * project is one request and the heavier reads happen on demand.
 */

import { useCallback, useState } from "react";

import { api } from "../../lib/api";
import { shortPath } from "../../lib/format";
import type { ProjectDetailResponse, SessionView } from "../../lib/protocol";
import { useResource, type Resource } from "../../lib/useResource";
import { Icon } from "../Icon";
import { ThemeToggle } from "../ThemeToggle";
import { ProjectHistory } from "./ProjectHistory";
import { ProjectInbox } from "./ProjectInbox";
import { ProjectMemory } from "./ProjectMemory";
import { ProjectSessions } from "./ProjectSessions";
import { Badge, IdChip, ViewState } from "./parts";

type Tab = "memory" | "history" | "sessions" | "inbox";

const TABS: { id: Tab; label: string }[] = [
  { id: "memory", label: "Memory" },
  { id: "history", label: "History" },
  { id: "sessions", label: "Sessions" },
  { id: "inbox", label: "Inbox" },
];

interface Props {
  projectId: string;
  onBack: () => void;
  onOpenSession: (session: SessionView) => void;
  onUnauthorized: () => void;
}

export function ProjectPage({
  projectId,
  onBack,
  onOpenSession,
  onUnauthorized,
}: Props): React.JSX.Element {
  const load = useCallback(() => api.project(projectId), [projectId]);
  const detail = useResource(load, [projectId], onUnauthorized);
  const [tab, setTab] = useState<Tab>("memory");

  return (
    <div className="project">
      <ProjectBar detail={detail} onBack={onBack} />
      <nav className="tabbar" aria-label="Project sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="tab"
            aria-current={tab === item.id ? "page" : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="project-scroll">
        <div className="project-column">
          {tab === "memory" && (
            <ViewState resource={detail}>
              {(data) => <ProjectMemory memory={data.memory} />}
            </ViewState>
          )}
          {tab === "history" && (
            <ProjectHistory projectId={projectId} onUnauthorized={onUnauthorized} />
          )}
          {tab === "sessions" && (
            <ProjectSessions
              projectId={projectId}
              onOpenSession={onOpenSession}
              onUnauthorized={onUnauthorized}
            />
          )}
          {tab === "inbox" && (
            <ProjectInbox projectId={projectId} onUnauthorized={onUnauthorized} />
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectBar({
  detail,
  onBack,
}: {
  detail: Resource<ProjectDetailResponse>;
  onBack: () => void;
}): React.JSX.Element {
  const project = detail.status === "ready" ? detail.data.project : null;
  const root = project?.roots[0];
  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-button back-button"
        onClick={onBack}
        aria-label="Back to projects"
        title="Back to projects"
      >
        <Icon name="chevronLeft" />
      </button>
      <div className="topbar-title">
        <h1>{project?.name ?? "Project"}</h1>
        {project && (
          <p className="topbar-meta">
            {project.scope && <Badge>{project.scope}</Badge>}
            {root && (
              <span className="mono" title={project.roots.join("\n")}>
                {shortPath(root, 2)}
              </span>
            )}
          </p>
        )}
      </div>
      <div className="topbar-actions">
        {project && <IdChip id={project.id} label="project id" />}
        <ThemeToggle />
      </div>
    </header>
  );
}
