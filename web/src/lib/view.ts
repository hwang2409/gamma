/**
 * Derived view of a transcript: what the session page paints.
 *
 * The reducer keeps one flat list of items in event order. The page wants a
 * little more structure:
 *  - consecutive tool calls form one group, and each tool call carries the
 *    approval that gated it, so a decided approval reads as part of its row;
 *  - pending approvals leave the flow and pin above the composer;
 *  - one run phase says what the agent is doing now.
 * Everything here is a pure function of `TranscriptState`.
 */

import {
  pendingApprovals,
  type ApprovalItem,
  type AssistantItem,
  type NoticeItem,
  type ToolItem,
  type ToolPhase,
  type TranscriptState,
  type UserItem,
} from "./transcript";

/** One tool call row: the tool, the approval that gated it, or both. */
export interface ToolRow {
  id: string;
  name: string;
  args: Record<string, unknown>;
  phase: ToolPhase;
  tool: ToolItem | null;
  approval: ApprovalItem | null;
}

export interface ToolGroup {
  kind: "tools";
  id: string;
  rows: ToolRow[];
}

export type Block =
  | { kind: "user"; id: string; item: UserItem }
  | { kind: "assistant"; id: string; item: AssistantItem }
  | { kind: "notice"; id: string; item: NoticeItem }
  | ToolGroup;

export function transcriptBlocks(state: TranscriptState): Block[] {
  const toolByCall = new Map<string, ToolItem>();
  const approvalByCall = new Map<string, ApprovalItem>();
  for (const item of state.items) {
    if (item.kind === "tool") {
      toolByCall.set(item.callId, item);
    } else if (item.kind === "approval") {
      approvalByCall.set(item.toolCallId, item);
    }
  }

  const blocks: Block[] = [];
  let group: ToolGroup | null = null;
  const pushRow = (row: ToolRow) => {
    if (group === null) {
      group = { kind: "tools", id: `group-${row.id}`, rows: [] };
      blocks.push(group);
    }
    group.rows.push(row);
  };

  for (const item of state.items) {
    switch (item.kind) {
      case "tool":
        pushRow(toolRow(item, approvalByCall.get(item.callId) ?? null));
        break;
      case "approval":
        // An approval with a tool call renders inside that tool's row. One
        // without (the tool has not started) is a row of its own until then.
        if (!toolByCall.has(item.toolCallId)) {
          pushRow(approvalRow(item));
        }
        break;
      case "user":
        group = null;
        blocks.push({ kind: "user", id: item.id, item });
        break;
      case "assistant":
        group = null;
        blocks.push({ kind: "assistant", id: item.id, item });
        break;
      case "notice":
        group = null;
        blocks.push({ kind: "notice", id: item.id, item });
        break;
    }
  }
  return blocks;
}

function toolRow(tool: ToolItem, approval: ApprovalItem | null): ToolRow {
  // A tool whose approval was denied or dropped never ends with a result.
  const phase =
    tool.phase === "awaiting_approval" && approval !== null && approval.phase !== "pending"
      ? approval.phase === "approved"
        ? "running"
        : "denied"
      : tool.phase;
  return { id: tool.id, name: tool.name, args: tool.args, phase, tool, approval };
}

function approvalRow(approval: ApprovalItem): ToolRow {
  const phase: ToolPhase =
    approval.phase === "pending"
      ? "awaiting_approval"
      : approval.phase === "approved"
        ? "running"
        : "denied";
  return {
    id: approval.id,
    name: approval.name,
    args: approval.args,
    phase,
    tool: null,
    approval,
  };
}

export type RunPhase =
  | { kind: "idle" }
  | { kind: "closed" }
  | { kind: "thinking" }
  | { kind: "responding" }
  | { kind: "tool"; name: string }
  | { kind: "approval"; name: string };

/**
 * What the agent is doing now.
 *
 * zeta emits `turn_end` after every model turn and `agent_end` once the run
 * finishes, so between two model turns `state` is briefly idle while the run
 * is still open. A run that is open counts as busy.
 */
export function runPhase(state: TranscriptState): RunPhase {
  if (state.closed) {
    return { kind: "closed" };
  }
  const approval = pendingApprovals(state)[0];
  if (approval !== undefined) {
    return { kind: "approval", name: approval.name };
  }
  if (!isBusy(state)) {
    return { kind: "idle" };
  }
  const running = [...state.items]
    .reverse()
    .find((item): item is ToolItem => item.kind === "tool" && item.phase === "running");
  if (running !== undefined) {
    return { kind: "tool", name: running.name };
  }
  return state.openAssistantId !== null ? { kind: "responding" } : { kind: "thinking" };
}

export function isBusy(state: TranscriptState): boolean {
  if (state.closed) {
    return false;
  }
  const runOpen = state.runStartedAt !== null && state.runEndedAt === null;
  return runOpen || state.state !== "idle";
}

/**
 * Seconds the current run has taken, or the last run took. `now` is epoch
 * seconds; the result never goes below zero, whatever the clock skew.
 */
export function runSeconds(state: TranscriptState, now: number): number | null {
  if (state.runStartedAt === null) {
    return null;
  }
  const end = state.runEndedAt ?? now;
  return Math.max(0, end - state.runStartedAt);
}

/** Seconds a tool ran, or has run so far. */
export function toolSeconds(tool: ToolItem, now: number): number {
  return Math.max(0, (tool.endedAt ?? now) - tool.startedAt);
}

export interface Usage {
  input: number | null;
  output: number | null;
}

export function usageTotals(usage: Record<string, unknown>): Usage {
  const read = (key: string) => {
    const value = usage[key];
    return typeof value === "number" ? value : null;
  };
  return { input: read("input_tokens"), output: read("output_tokens") };
}
