/**
 * The projects list: every project Zeta knows, newest activity first as the
 * server orders them. The name leads; the id is secondary and copyable.
 *
 * This is the one place a person comes to answer "which ids belong to which
 * project, and how is its memory doing" without leaving the browser.
 */

import { useCallback } from "react";

import { api } from "../../lib/api";
import { shortPath } from "../../lib/format";
import type { ProjectSummary } from "../../lib/protocol";
import { useResource } from "../../lib/useResource";
import { Icon } from "../Icon";
import { Node } from "../Node";
import { ThemeToggle } from "../ThemeToggle";
import { Badge, IdChip, Time, ViewState } from "./parts";

interface Props {
  onOpenProject: (id: string) => void;
  onBack: () => void;
  onUnauthorized: () => void;
}

export function ProjectsPage({ onOpenProject, onBack, onUnauthorized }: Props): React.JSX.Element {
  const load = useCallback(() => api.projects(), []);
  const resource = useResource(load, [], onUnauthorized);
  const now = Date.now();

  return (
    <div className="projects">
      <header className="projects-head">
        <button
          type="button"
          className="icon-button back-button"
          onClick={onBack}
          aria-label="Back to sessions"
          title="Back to sessions"
        >
          <Icon name="chevronLeft" />
        </button>
        <p className="wordmark">
          <Node kind="task" />
          gamma
        </p>
        <ThemeToggle />
      </header>

      <main className="projects-main">
        <h1>Projects</h1>
        <ViewState resource={resource}>
          {(data) =>
            data.projects.length === 0 ? (
              <p className="view-state">
                No projects yet. Zeta records a project the first time a session runs in a tracked
                repository.
              </p>
            ) : (
              <ul className="project-list">
                {data.projects.map((project) => (
                  <li key={project.id}>
                    <ProjectRow project={project} now={now} onOpen={() => onOpenProject(project.id)} />
                  </li>
                ))}
              </ul>
            )
          }
        </ViewState>
      </main>
    </div>
  );
}

function ProjectRow({
  project,
  now,
  onOpen,
}: {
  project: ProjectSummary;
  now: number;
  onOpen: () => void;
}): React.JSX.Element {
  const root = project.roots[0];
  return (
    <div className="project-row">
      <button type="button" className="project-row-main" onClick={onOpen}>
        <span className="project-row-name">{project.name}</span>
        <span className="project-row-meta">
          {project.scope && <Badge>{project.scope}</Badge>}
          {root && (
            <span className="mono" title={project.roots.join("\n")}>
              {shortPath(root, 2)}
            </span>
          )}
          <span>
            {project.session_count} {project.session_count === 1 ? "session" : "sessions"}
          </span>
          <span className="dim">
            <Time iso={project.last_activity} now={now} />
          </span>
        </span>
      </button>
      <IdChip id={project.id} label="project id" />
    </div>
  );
}
