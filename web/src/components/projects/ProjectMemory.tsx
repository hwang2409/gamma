/**
 * The Memory tab: the five memory files rendered as Markdown, each with an
 * "automatic" badge when the background updater wrote it but no one has
 * accepted it, plus the snapshot's version id and digest.
 *
 * This component is the only place that reads the memory wire shape. The
 * planned Zeta memory rewrite (entry-shaped content under a new negotiated
 * version) changes this file and the `MemorySnapshot` type, nothing else.
 */

import { useState } from "react";

import type { MemorySnapshot } from "../../lib/protocol";
import { SafeMarkdown } from "../SafeMarkdown";
import { Badge, IdChip } from "./parts";

export function ProjectMemory({ memory }: { memory: MemorySnapshot }): React.JSX.Element {
  const automatic = memory.files.filter((file) => file.automatic).length;
  return (
    <section className="memory" aria-label="Project memory">
      <div className="memory-head">
        <div className="memory-version">
          {memory.version_id ? (
            <IdChip id={memory.version_id} label="version id" />
          ) : (
            <span className="dim">legacy memory (no version)</span>
          )}
          {memory.digest && (
            <span className="mono dim" title={memory.digest}>
              {memory.digest.slice(0, 12)}
            </span>
          )}
        </div>
        {automatic > 0 && (
          <p className="memory-note">
            {automatic} {automatic === 1 ? "file was" : "files were"} written automatically and
            not yet accepted.
          </p>
        )}
      </div>
      {memory.files.map((file) => (
        <MemoryFileCard
          key={file.name}
          name={file.name}
          content={file.content}
          automatic={file.automatic}
          truncated={file.content_truncated}
        />
      ))}
    </section>
  );
}

function MemoryFileCard({
  name,
  content,
  automatic,
  truncated,
}: {
  name: string;
  content: string;
  automatic: boolean;
  truncated: boolean;
}): React.JSX.Element {
  const empty = content.trim() === "";
  const [open, setOpen] = useState(!empty);
  return (
    <article className="memory-file">
      <button
        type="button"
        className="memory-file-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="memory-file-name mono">{name}</span>
        {automatic && <Badge tone="strong">automatic</Badge>}
        {empty && <span className="dim">empty</span>}
      </button>
      {open && !empty && (
        <div className="memory-file-body">
          <SafeMarkdown text={content} />
          {truncated && <p className="memory-note dim">Shortened to fit; read the full file in Zeta.</p>}
        </div>
      )}
    </article>
  );
}
