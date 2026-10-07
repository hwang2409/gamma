/**
 * The History tab: memory versions newest first, each with its time, kind,
 * the files it changed, and provenance (which session and seq range wrote it,
 * the model, who accepted it, or the remote peer it synced from). Click a
 * changed file to read that version's diff against its parent.
 */

import { useCallback, useState } from "react";

import { api } from "../../lib/api";
import type { MemoryProvenance, MemoryVersion, MemoryVersionDetail } from "../../lib/protocol";
import { useResource } from "../../lib/useResource";
import { Spinner } from "../Icon";
import { Badge, PageNote, Time, ViewState } from "./parts";

interface Props {
  projectId: string;
  onUnauthorized: () => void;
}

interface Selection {
  versionId: string;
  file: string;
}

export function ProjectHistory({ projectId, onUnauthorized }: Props): React.JSX.Element {
  const load = useCallback(() => api.projectMemoryLog(projectId), [projectId]);
  const resource = useResource(load, [projectId], onUnauthorized);
  const [selection, setSelection] = useState<Selection | null>(null);
  const now = Date.now();

  return (
    <section className="history" aria-label="Memory history">
      <ViewState resource={resource}>
        {(data) =>
          data.versions.length === 0 ? (
            <p className="view-state">No memory versions yet.</p>
          ) : (
            <>
              {!data.complete && (
                <PageNote>
                  This history is very long. Showing {data.versions.length} versions; some may be
                  missing. Open the project in Zeta to read the rest.
                </PageNote>
              )}
              <ol className="history-list">
                {[...data.versions].reverse().map((version) => (
                  <li key={version.version_id}>
                    <HistoryEntry
                      version={version}
                      now={now}
                      selected={selection}
                      onSelect={(file) => setSelection({ versionId: version.version_id, file })}
                      onClose={() => setSelection(null)}
                      projectId={projectId}
                      onUnauthorized={onUnauthorized}
                    />
                  </li>
                ))}
              </ol>
            </>
          )
        }
      </ViewState>
    </section>
  );
}

function HistoryEntry({
  version,
  now,
  selected,
  onSelect,
  onClose,
  projectId,
  onUnauthorized,
}: {
  version: MemoryVersion;
  now: number;
  selected: Selection | null;
  onSelect: (file: string) => void;
  onClose: () => void;
  projectId: string;
  onUnauthorized: () => void;
}): React.JSX.Element {
  const openFile = selected?.versionId === version.version_id ? selected.file : null;
  return (
    <div className="history-entry">
      <div className="history-entry-head">
        <Badge tone="strong">{version.kind ?? "update"}</Badge>
        <span className="dim">
          <Time iso={version.timestamp} now={now} />
        </span>
        <span className="history-prov">
          {provenanceParts(version.provenance).map((part) => (
            <span key={part}>{part}</span>
          ))}
        </span>
      </div>
      <div className="history-files">
        {version.files_changed.length === 0 ? (
          <span className="dim">no files changed</span>
        ) : (
          version.files_changed.map((file) => (
            <button
              key={file}
              type="button"
              className="chip"
              aria-pressed={openFile === file}
              onClick={() => (openFile === file ? onClose() : onSelect(file))}
            >
              <span className="mono">{file}</span>
            </button>
          ))
        )}
      </div>
      {openFile && (
        <DiffPanel
          projectId={projectId}
          versionId={version.version_id}
          file={openFile}
          onUnauthorized={onUnauthorized}
        />
      )}
    </div>
  );
}

function DiffPanel({
  projectId,
  versionId,
  file,
  onUnauthorized,
}: {
  projectId: string;
  versionId: string;
  file: string;
  onUnauthorized: () => void;
}): React.JSX.Element {
  const load = useCallback(
    () => api.projectMemoryVersion(projectId, versionId, file),
    [projectId, versionId, file],
  );
  const resource = useResource(load, [projectId, versionId, file], onUnauthorized);
  return (
    <div className="diff-panel">
      {resource.status === "loading" && (
        <p className="view-state">
          <Spinner size={13} /> Loading diff…
        </p>
      )}
      {resource.status === "error" && (
        <p className="view-state view-state-error" role="alert">
          {resource.message}
        </p>
      )}
      {resource.status === "ready" && <Diff detail={resource.data} />}
    </div>
  );
}

function Diff({ detail }: { detail: MemoryVersionDetail }): React.JSX.Element {
  if (detail.diff.trim() === "") {
    return <p className="view-state dim">No textual change in this file.</p>;
  }
  return (
    <>
      <pre className="diff" tabIndex={0}>
        <code>
          {detail.diff.split("\n").map((line, index) => (
            <span key={index} className={diffLineClass(line)}>
              {line + "\n"}
            </span>
          ))}
        </code>
      </pre>
      {detail.diff_truncated && (
        <p className="memory-note dim">Diff shortened to fit; read the full diff in Zeta.</p>
      )}
    </>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
    return "diff-meta";
  }
  if (line.startsWith("+")) {
    return "diff-add";
  }
  if (line.startsWith("-")) {
    return "diff-del";
  }
  return "diff-ctx";
}

function provenanceParts(provenance: MemoryProvenance): string[] {
  const parts: string[] = [];
  if (typeof provenance.session_id === "string") {
    const range =
      typeof provenance.seq_start === "number" && typeof provenance.seq_end === "number"
        ? ` #${provenance.seq_start}–${provenance.seq_end}`
        : "";
    parts.push(`session ${provenance.session_id}${range}`);
  }
  if (typeof provenance.model === "string") {
    parts.push(provenance.model);
  }
  if (typeof provenance.accepted_by === "string") {
    parts.push(`accepted by ${provenance.accepted_by}`);
  }
  if (typeof provenance.peer === "string") {
    parts.push(`synced from ${provenance.peer}`);
  } else if (typeof provenance.source === "string") {
    parts.push(provenance.source);
  }
  return parts;
}
