/** Types for the gamma API. They mirror the backend Pydantic models. */

export type RunState = "idle" | "running" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Facts zeta resolved for an approval, beyond the model's arguments: where a
 * command runs and the path it touches, or the project file a write targets.
 * Every field is optional; zeta sends only what it resolved.
 */
export interface ApprovalDisplay {
  effective_cwd?: string | null;
  resolved_path?: string | null;
  project_id?: string | null;
  project_name?: string | null;
  filename?: string | null;
  utf8_bytes?: number | null;
  preview?: string | null;
}

export interface PendingApproval {
  request_id: string;
  tool_call: ToolCall;
  approval_display?: ApprovalDisplay | null;
  delegated?: boolean;
  agent_instance_id?: string | null;
}

export interface SessionView {
  session_id: string;
  zeta_session_id: string | null;
  provider: string;
  model: string | null;
  cwd: string | null;
  protocol_version: string;
  state: RunState;
  usage: Record<string, unknown>;
  pending_approvals: PendingApproval[];
  cursor: number;
  oldest_cursor: number;
  created_at: number;
  last_activity: number;
  session_name: string | null;
  /** The first message sent in this gamma session, whitespace collapsed. */
  first_prompt: string | null;
  capabilities: string[];
}

export interface ProviderOption {
  name: string;
  models: string[];
}

export interface OptionsResponse {
  providers: ProviderOption[];
  default_provider: string | null;
  allowed_roots: string[];
  directories: string[];
  approval_mode: "ask";
}

export interface ZetaSessionSummary {
  session_id: string;
  provider: string;
  model: string;
  cwd: string;
  name: string | null;
  updated_at: string | null;
  first_message_preview: string | null;
}

export interface CreateSessionBody {
  provider: string;
  model?: string | null;
  cwd?: string | null;
  resume_session_id?: string | null;
}

/** Frames the backend sends over the session WebSocket. */
export type ServerFrame =
  | { type: "snapshot"; session: SessionView; replay_from: number }
  | { type: "event"; cursor: number; at: number; event: string; payload: Record<string, unknown> }
  | { type: "ack"; command: string; result: Record<string, unknown> }
  | { type: "error"; message: string; command: string | null }
  | { type: "pong" };

/** Commands the browser sends over the session WebSocket. */
export type ClientCommand =
  | { type: "auth"; token: string }
  | { type: "send"; text: string }
  | { type: "steer"; text: string }
  | { type: "approve"; request_id: string; scope?: "once" | "always_tool" }
  | { type: "deny"; request_id: string }
  | { type: "abort" }
  | { type: "ping" };

// --- projects (read-only) --------------------------------------------------

export interface ProjectSummary {
  id: string;
  name: string;
  scope: string | null;
  roots: string[];
  session_count: number;
  last_activity: string | null;
}

export interface ProjectDetail extends ProjectSummary {
  created_at: string | null;
  updated_at: string | null;
}

export interface ProjectListResponse {
  projects: ProjectSummary[];
  next_offset: number | null;
  truncated: boolean;
}

/**
 * One memory file. `automatic` marks content the background updater wrote but
 * the user has not accepted. A later Zeta memory rewrite will enrich this
 * shape under a new negotiated version; keep its reading in one component.
 */
export interface MemoryFile {
  name: string;
  content: string;
  automatic: boolean;
  content_truncated: boolean;
}

export interface MemorySnapshot {
  version_id: string | null;
  digest: string | null;
  files: MemoryFile[];
}

export interface ProjectDetailResponse {
  project: ProjectDetail;
  memory: MemorySnapshot;
}

export interface MemoryProvenance {
  session_id?: string;
  seq_start?: number;
  seq_end?: number;
  model?: string;
  accepted_by?: string;
  source?: string;
  peer?: string;
  [key: string]: unknown;
}

export interface MemoryVersion {
  version_id: string;
  timestamp: string | null;
  kind: string | null;
  files_changed: string[];
  provenance: MemoryProvenance;
  provenance_truncated: boolean;
  target_version_id: string | null;
}

export interface MemoryLogResponse {
  versions: MemoryVersion[];
  next_offset: number | null;
  truncated: boolean;
}

export interface MemoryVersionDetail extends MemoryVersion {
  file: string;
  content: string;
  content_truncated: boolean;
  diff: string;
  diff_truncated: boolean;
}

export interface ProjectSessionSummary {
  session_id: string;
  name: string | null;
  provider: string;
  model: string | null;
  cwd: string | null;
  project_role: string | null;
  parent_session_id: string | null;
  updated_at: string | null;
  first_message_preview: string | null;
}

export interface ProjectSessionsResponse {
  sessions: ProjectSessionSummary[];
  truncated: boolean;
}

export type InboxStatus = "new" | "claimed" | "done";

export interface InboxMessage {
  id: string;
  origin: string;
  from_project: string | null;
  from_session: string | null;
  to_project: string | null;
  kind: string | null;
  title: string;
  body: string;
  in_reply_to: string | null;
  created_at: string | null;
  claimer_session: string | null;
  claimed_at: string | null;
  outcome: string | null;
  reply: string | null;
  done_at: string | null;
  truncated_fields: string[];
}

export interface ProjectInboxResponse {
  status: InboxStatus;
  messages: InboxMessage[];
  untrusted: boolean;
  next_offset: number | null;
  truncated: boolean;
}

// --- fully-paged reads -----------------------------------------------------
//
// Zeta pages project lists, memory history, and the inbox (100 records by
// default). The REST client follows `next_offset` to the end so a view never
// shows a silent first page. `complete` is false only when a safety cap
// stopped the walk, so the view can say the list may be incomplete.

export interface PagedProjects {
  projects: ProjectSummary[];
  complete: boolean;
}

export interface PagedMemoryLog {
  versions: MemoryVersion[];
  complete: boolean;
}

export interface PagedInbox {
  status: InboxStatus;
  messages: InboxMessage[];
  untrusted: boolean;
  complete: boolean;
}
