/** Types for the gamma API. They mirror the backend Pydantic models. */

export type RunState = "idle" | "running" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface PendingApproval {
  request_id: string;
  tool_call: ToolCall;
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
  | { type: "event"; cursor: number; event: string; payload: Record<string, unknown> }
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
