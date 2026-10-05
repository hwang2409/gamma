/**
 * The transcript reducer.
 *
 * It folds the gamma event stream into the items the session page paints.
 * Two rules keep it correct across reconnects:
 *  - every event carries a cursor, and an event at or below the applied
 *    cursor is ignored, so replay after a reconnect cannot duplicate items;
 *  - assistant deltas coalesce into the open message, and the committed
 *    `assistant_message` replaces that text, so a partial stream and the
 *    final message never both appear.
 */

import type { ApprovalDisplay, RunState, SessionView, ToolCall } from "./protocol";

export interface UserItem {
  kind: "user";
  id: string;
  cursor: number;
  text: string;
  mode: "send" | "steer";
}

export interface AssistantItem {
  kind: "assistant";
  id: string;
  cursor: number;
  text: string;
  thinking: string;
  streaming: boolean;
}

export type ToolPhase = "awaiting_approval" | "running" | "done" | "error" | "denied";

export interface ToolItem {
  kind: "tool";
  id: string;
  cursor: number;
  /** The zeta tool call id; approvals refer to the tool by it. */
  callId: string;
  name: string;
  args: Record<string, unknown>;
  output: string;
  result: string | null;
  phase: ToolPhase;
  /** Publish time (epoch seconds) of `tool_start` and `tool_end`. */
  startedAt: number;
  endedAt: number | null;
}

export type ApprovalPhase = "pending" | "approved" | "denied" | "closed";

export interface ApprovalItem {
  kind: "approval";
  id: string;
  cursor: number;
  requestId: string;
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  phase: ApprovalPhase;
  scope: "once" | "always_tool" | null;
  /** What zeta resolved for this request (cwd, path, project file), if anything. */
  display: ApprovalDisplay | null;
  /** True when a sub-agent asked. */
  delegated: boolean;
}

export interface NoticeItem {
  kind: "notice";
  id: string;
  cursor: number;
  level: "info" | "error";
  text: string;
}

export type TranscriptItem = UserItem | AssistantItem | ToolItem | ApprovalItem | NoticeItem;

export interface TranscriptState {
  /** Highest applied event cursor; the reconnect point. */
  cursor: number;
  state: RunState;
  usage: Record<string, unknown>;
  items: TranscriptItem[];
  /** Id of the assistant item that deltas append to, if any. */
  openAssistantId: string | null;
  closed: boolean;
  /**
   * Publish time (epoch seconds) of the event that started the current run,
   * and of the event that ended it. A new run clears `runEndedAt`.
   */
  runStartedAt: number | null;
  runEndedAt: number | null;
}

export const emptyTranscript: TranscriptState = {
  cursor: 0,
  state: "idle",
  usage: {},
  items: [],
  openAssistantId: null,
  closed: false,
  runStartedAt: null,
  runEndedAt: null,
};

export interface GammaEvent {
  cursor: number;
  /** Publish time on the backend, epoch seconds. */
  at: number;
  event: string;
  payload: Record<string, unknown>;
}

export type TranscriptAction =
  | { type: "snapshot"; session: SessionView }
  | { type: "event"; event: GammaEvent }
  | { type: "reset" };

export function transcriptReducer(
  state: TranscriptState,
  action: TranscriptAction,
): TranscriptState {
  switch (action.type) {
    case "reset":
      return emptyTranscript;
    case "snapshot":
      return applySnapshot(state, action.session);
    case "event":
      return applyEvent(state, action.event);
  }
}

/**
 * A snapshot carries run state, usage, and unresolved approvals. It never
 * rewrites transcript items, because the replayed events do that.
 */
function applySnapshot(state: TranscriptState, session: SessionView): TranscriptState {
  let items = state.items;
  for (const approval of session.pending_approvals) {
    if (!items.some((item) => item.kind === "approval" && item.requestId === approval.request_id)) {
      items = [
        ...items,
        approvalItem(state.cursor, approval.request_id, approval.tool_call, {
          display: approvalDisplay(approval.approval_display),
          delegated: approval.delegated === true,
        }),
      ];
    }
  }
  return {
    ...state,
    state: session.state,
    usage: session.usage,
    items,
  };
}

function applyEvent(state: TranscriptState, event: GammaEvent): TranscriptState {
  if (event.cursor <= state.cursor) {
    return state; // already applied: replay after a reconnect
  }
  const next = { ...state, cursor: event.cursor };
  const { payload } = event;
  switch (event.event) {
    case "gamma_user_message":
      return addItem(closeStream(payload.mode === "steer" ? next : startRun(next, event.at)), {
        kind: "user",
        id: `user-${event.cursor}`,
        cursor: event.cursor,
        text: text(payload.text),
        mode: payload.mode === "steer" ? "steer" : "send",
      });

    case "gamma_session_closed":
      return { ...endRun(closeStream(next), event.at), state: "idle", closed: true };

    case "gamma_approval_decision":
      return decideApproval(
        next,
        text(payload.request_id),
        payload.decision === "approve" ? "approved" : "denied",
        payload.scope === "always_tool" ? "always_tool" : "once",
      );

    case "turn_start":
    case "agent_start":
      return { ...startRun(closeStream(next), event.at), state: "running" };

    case "message_start":
      return { ...closeStream(next), state: "running" };

    case "assistant_delta":
      return appendDelta(next, event.cursor, text(payload.delta), text(payload.kind));

    case "assistant_message":
      return commitMessage(next, event.cursor, payload.message);

    case "usage":
      return { ...next, usage: asRecord(payload.usage) };

    case "tool_start":
      return startTool(next, event.cursor, event.at, toolCall(payload.tool_call));

    case "tool_output":
      return appendToolOutput(next, toolCall(payload.tool_call).id, text(payload.output));

    case "tool_end":
      return endTool(next, event.at, toolCall(payload.tool_call), payload.tool_result);

    case "approval_request":
      return requestApproval(next, event.cursor, text(payload.request_id), toolCall(payload.tool_call), {
        display: approvalDisplay(payload.approval_display),
        delegated: payload.delegated === true,
      });

    case "approval_end":
      return closeApprovalFor(next, toolCall(payload.tool_call).id);

    case "turn_end":
      // zeta ends every model turn; the run itself ends at `agent_end`, so
      // the agent is still working here (the backend derives it the same way).
      return closeStream(next);

    case "agent_end":
      return { ...endRun(closeStream(next), event.at), state: "idle" };

    case "turn_aborted":
      return addItem(
        { ...endRun(closeStream(next), event.at), state: "idle" },
        notice(event.cursor, "info", "Turn aborted."),
      );

    case "error": {
      const error = asRecord(payload.error);
      return addItem(
        { ...endRun(closeStream(next), event.at), state: "idle" },
        notice(
          event.cursor,
          "error",
          `${text(error.code) || "error"}: ${text(error.message) || "the harness reported a failure"}`,
        ),
      );
    }

    case "compaction_end": {
      const data = asRecord(payload.data);
      const tokens = typeof data.token_count === "number" ? ` (${data.token_count} tokens)` : "";
      return addItem(next, notice(event.cursor, "info", `History compacted${tokens}.`));
    }

    case "retry": {
      const data = asRecord(payload.data);
      const attempt = typeof data.retry === "number" ? ` ${data.retry}` : "";
      return addItem(next, notice(event.cursor, "info", `Provider retry${attempt}.`));
    }

    default:
      return next; // unknown events advance the cursor and nothing else
  }
}

// --- item helpers ----------------------------------------------------------

function addItem(state: TranscriptState, item: TranscriptItem): TranscriptState {
  return { ...state, items: [...state.items, item] };
}

function notice(cursor: number, level: "info" | "error", body: string): NoticeItem {
  return { kind: "notice", id: `notice-${cursor}`, cursor, level, text: body };
}

type ApprovalContext = Pick<ApprovalItem, "display" | "delegated">;

function approvalItem(
  cursor: number,
  requestId: string,
  call: ToolCall,
  context: ApprovalContext,
): ApprovalItem {
  return {
    ...context,
    kind: "approval",
    id: `approval-${requestId}`,
    cursor,
    requestId,
    toolCallId: call.id,
    name: call.name,
    args: call.arguments,
    phase: "pending",
    scope: null,
  };
}

/** A run starts once: the first of the user's send, `agent_start`, or `turn_start`. */
function startRun(state: TranscriptState, at: number): TranscriptState {
  if (state.runStartedAt !== null && state.runEndedAt === null) {
    return state;
  }
  return { ...state, runStartedAt: at, runEndedAt: null };
}

function endRun(state: TranscriptState, at: number): TranscriptState {
  if (state.runStartedAt === null || state.runEndedAt !== null) {
    return state;
  }
  return { ...state, runEndedAt: at };
}

function closeStream(state: TranscriptState): TranscriptState {
  if (state.openAssistantId === null) {
    return state;
  }
  return {
    ...state,
    openAssistantId: null,
    items: state.items.map((item) =>
      item.kind === "assistant" && item.id === state.openAssistantId
        ? { ...item, streaming: false }
        : item,
    ),
  };
}

function appendDelta(
  state: TranscriptState,
  cursor: number,
  delta: string,
  kind: string,
): TranscriptState {
  const field = kind === "thinking" ? "thinking" : "text";
  if (state.openAssistantId !== null) {
    return {
      ...state,
      items: state.items.map((item) =>
        item.kind === "assistant" && item.id === state.openAssistantId
          ? { ...item, [field]: item[field] + delta }
          : item,
      ),
    };
  }
  const id = `assistant-${cursor}`;
  const item: AssistantItem = {
    kind: "assistant",
    id,
    cursor,
    text: field === "text" ? delta : "",
    thinking: field === "thinking" ? delta : "",
    streaming: true,
  };
  return { ...addItem(state, item), openAssistantId: id };
}

function commitMessage(
  state: TranscriptState,
  cursor: number,
  message: unknown,
): TranscriptState {
  const committed = messageText(message);
  if (state.openAssistantId !== null) {
    const openId = state.openAssistantId;
    return {
      ...state,
      openAssistantId: null,
      items: state.items.map((item) =>
        item.kind === "assistant" && item.id === openId
          ? { ...item, text: committed.text || item.text, thinking: committed.thinking || item.thinking, streaming: false }
          : item,
      ),
    };
  }
  if (committed.text === "" && committed.thinking === "") {
    return state;
  }
  return addItem(state, {
    kind: "assistant",
    id: `assistant-${cursor}`,
    cursor,
    text: committed.text,
    thinking: committed.thinking,
    streaming: false,
  });
}

function startTool(
  state: TranscriptState,
  cursor: number,
  at: number,
  call: ToolCall,
): TranscriptState {
  const existing = state.items.find((item) => item.kind === "tool" && item.id === toolId(call.id));
  const base = closeStream(state);
  if (existing) {
    return updateTool(base, call.id, (item) => ({ ...item, phase: "running" }));
  }
  return addItem(base, {
    kind: "tool",
    id: toolId(call.id),
    cursor,
    callId: call.id,
    name: call.name,
    args: call.arguments,
    output: "",
    result: null,
    phase: "running",
    startedAt: at,
    endedAt: null,
  });
}

function appendToolOutput(
  state: TranscriptState,
  callId: string,
  output: string,
): TranscriptState {
  return updateTool(state, callId, (item) => ({ ...item, output: item.output + output }));
}

function endTool(
  state: TranscriptState,
  at: number,
  call: ToolCall,
  rawResult: unknown,
): TranscriptState {
  const result = asRecord(rawResult);
  const isError = result.is_error === true;
  const canceled = result.is_canceled === true;
  return updateTool(state, call.id, (item) => ({
    ...item,
    result: text(result.content),
    phase: isError ? "error" : canceled ? "denied" : "done",
    endedAt: at,
  }));
}

function updateTool(
  state: TranscriptState,
  callId: string,
  change: (item: ToolItem) => ToolItem,
): TranscriptState {
  const id = toolId(callId);
  if (!state.items.some((item) => item.kind === "tool" && item.id === id)) {
    return state;
  }
  return {
    ...state,
    items: state.items.map((item) =>
      item.kind === "tool" && item.id === id ? change(item) : item,
    ),
  };
}

function requestApproval(
  state: TranscriptState,
  cursor: number,
  requestId: string,
  call: ToolCall,
  context: ApprovalContext,
): TranscriptState {
  const existing = state.items.find(
    (item) => item.kind === "approval" && item.requestId === requestId,
  );
  const base: TranscriptState = { ...closeStream(state), state: "tool" };
  if (existing) {
    return base;
  }
  const withTool = state.items.some((item) => item.kind === "tool" && item.id === toolId(call.id))
    ? updateTool(base, call.id, (item) => ({ ...item, phase: "awaiting_approval" }))
    : base;
  return addItem(withTool, approvalItem(cursor, requestId, call, context));
}

function decideApproval(
  state: TranscriptState,
  requestId: string,
  phase: ApprovalPhase,
  scope: "once" | "always_tool",
): TranscriptState {
  return {
    ...state,
    items: state.items.map((item) =>
      item.kind === "approval" && item.requestId === requestId
        ? { ...item, phase, scope }
        : item,
    ),
  };
}

/** A disconnect aborts unresolved approvals, so a closed one stops asking. */
function closeApprovalFor(state: TranscriptState, toolCallId: string): TranscriptState {
  return {
    ...state,
    items: state.items.map((item) =>
      item.kind === "approval" && item.toolCallId === toolCallId && item.phase === "pending"
        ? { ...item, phase: "closed" }
        : item,
    ),
  };
}

export function pendingApprovals(state: TranscriptState): ApprovalItem[] {
  return state.items.filter(
    (item): item is ApprovalItem => item.kind === "approval" && item.phase === "pending",
  );
}

// --- payload readers -------------------------------------------------------

function toolId(callId: string): string {
  return `tool-${callId}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toolCall(value: unknown): ToolCall {
  const raw = asRecord(value);
  return {
    id: text(raw.id),
    name: text(raw.name) || "tool",
    arguments: asRecord(raw.arguments),
  };
}

const DISPLAY_TEXT = [
  "effective_cwd",
  "resolved_path",
  "project_id",
  "project_name",
  "filename",
  "preview",
] as const;

/**
 * The approval facts zeta resolved, keeping only fields of the documented
 * type. Text is rendered as text, never markup.
 */
function approvalDisplay(value: unknown): ApprovalDisplay | null {
  const raw = asRecord(value);
  const display: ApprovalDisplay = {};
  for (const key of DISPLAY_TEXT) {
    if (typeof raw[key] === "string" && raw[key] !== "") {
      display[key] = raw[key];
    }
  }
  if (typeof raw.utf8_bytes === "number" && raw.utf8_bytes >= 0) {
    display.utf8_bytes = raw.utf8_bytes;
  }
  return Object.keys(display).length > 0 ? display : null;
}

function messageText(value: unknown): { text: string; thinking: string } {
  const message = asRecord(value);
  const blocks = Array.isArray(message.content) ? message.content : [];
  let body = "";
  let thinking = "";
  for (const block of blocks) {
    const record = asRecord(block);
    if (record.type === "text") {
      body += text(record.text);
    } else if (record.type === "thinking") {
      thinking += text(record.text);
    }
  }
  return { text: body, thinking };
}
