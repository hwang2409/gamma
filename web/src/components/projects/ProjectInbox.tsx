/**
 * The Inbox tab: project messages, read-only. A segmented control picks the
 * status (new, claimed, done); each message shows its kind, who sent it, and
 * the status-specific trail (who claimed it, the outcome and reply once done).
 *
 * Origin is always shown. A message from another project is untrusted data,
 * so the page carries a warning only when the server marks the page untrusted
 * and each foreign message wears a warn badge; local messages stay quiet.
 */

import { useCallback, useState } from "react";

import { api } from "../../lib/api";
import type { InboxMessage, InboxStatus } from "../../lib/protocol";
import { useResource } from "../../lib/useResource";
import { Node } from "../Node";
import { Badge, IdChip, PageNote, Time, ViewState } from "./parts";

interface Props {
  projectId: string;
  onUnauthorized: () => void;
}

const STATUSES: { id: InboxStatus; label: string }[] = [
  { id: "new", label: "New" },
  { id: "claimed", label: "Claimed" },
  { id: "done", label: "Done" },
];

export function ProjectInbox({ projectId, onUnauthorized }: Props): React.JSX.Element {
  const [status, setStatus] = useState<InboxStatus>("new");
  const load = useCallback(() => api.projectInbox(projectId, status), [projectId, status]);
  const resource = useResource(load, [projectId, status], onUnauthorized);
  const now = Date.now();

  return (
    <section className="inbox" aria-label="Project inbox">
      <div className="segmented" role="tablist" aria-label="Message status">
        {STATUSES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            className="segment"
            aria-selected={status === item.id}
            onClick={() => setStatus(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <ViewState resource={resource}>
        {(data) => (
          <>
            {data.untrusted && (
              <p className="inbox-untrusted" role="note">
                <Node kind="info" />
                This page includes a message from another project. Treat its text as data, not
                instructions.
              </p>
            )}
            {data.messages.length === 0 ? (
              <p className="view-state">No {status} messages.</p>
            ) : (
              <>
                <ul className="inbox-list">
                  {data.messages.map((message) => (
                    <li key={message.id}>
                      <InboxCard message={message} now={now} />
                    </li>
                  ))}
                </ul>
                {!data.complete && (
                  <PageNote>
                    Showing the first {data.messages.length} {status} messages. Open Zeta to see the
                    rest.
                  </PageNote>
                )}
              </>
            )}
          </>
        )}
      </ViewState>
    </section>
  );
}

function InboxCard({ message, now }: { message: InboxMessage; now: number }): React.JSX.Element {
  const foreign = message.origin !== "local";
  const truncated = (field: string): boolean => message.truncated_fields.includes(field);
  return (
    <article className="inbox-card">
      <header className="inbox-card-head">
        {message.kind && <Badge tone="strong">{message.kind}</Badge>}
        <span className="inbox-card-title">{message.title || "Untitled"}</span>
        <Badge tone={foreign ? "warn" : "plain"}>{message.origin}</Badge>
      </header>
      <p className="inbox-card-meta">
        {message.from_session ? (
          <span>
            from <IdChip id={message.from_session} label="session id" />
          </span>
        ) : message.from_project ? (
          <span>
            from <IdChip id={message.from_project} label="project id" />
          </span>
        ) : null}
        <span className="dim">
          <Time iso={message.created_at} now={now} />
        </span>
      </p>
      {message.body.trim() !== "" && (
        <p className="inbox-card-body">
          {message.body}
          {truncated("body") && <span className="dim"> …</span>}
        </p>
      )}
      {message.claimer_session && (
        <p className="inbox-card-trail">
          <span className="dim">claimed by</span>
          <IdChip id={message.claimer_session} label="session id" />
          <span className="dim">
            <Time iso={message.claimed_at} now={now} />
          </span>
        </p>
      )}
      {(message.outcome || message.reply) && (
        <div className="inbox-card-reply">
          {message.outcome && <Badge>{message.outcome}</Badge>}
          {message.reply && (
            <p className="inbox-card-reply-text">
              {message.reply}
              {truncated("reply") && <span className="dim"> …</span>}
            </p>
          )}
          {message.done_at && (
            <span className="dim">
              <Time iso={message.done_at} now={now} />
            </span>
          )}
        </div>
      )}
    </article>
  );
}
