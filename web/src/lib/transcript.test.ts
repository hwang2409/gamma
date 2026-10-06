import { describe, expect, it } from "vitest";

import type { SessionView } from "./protocol";
import {
  emptyTranscript,
  pendingApprovals,
  transcriptReducer,
  type AssistantItem,
  type GammaEvent,
  type ToolItem,
  type TranscriptState,
} from "./transcript";

let nextCursor = 0;

function event(name: string, payload: Record<string, unknown> = {}, cursor?: number): GammaEvent {
  nextCursor = cursor ?? nextCursor + 1;
  return { cursor: nextCursor, at: 1000 + nextCursor, event: name, payload };
}

function apply(state: TranscriptState, ...events: GammaEvent[]): TranscriptState {
  return events.reduce(
    (current, next) => transcriptReducer(current, { type: "event", event: next }),
    state,
  );
}

function fresh(): TranscriptState {
  nextCursor = 0;
  return emptyTranscript;
}

function assistants(state: TranscriptState): AssistantItem[] {
  return state.items.filter((item): item is AssistantItem => item.kind === "assistant");
}

function tools(state: TranscriptState): ToolItem[] {
  return state.items.filter((item): item is ToolItem => item.kind === "tool");
}

const session: SessionView = {
  session_id: "g1",
  zeta_session_id: "z1",
  provider: "fake",
  model: "offline",
  cwd: "/tmp/work",
  protocol_version: "1.1",
  state: "running",
  usage: { input_tokens: 5 },
  pending_approvals: [],
  cursor: 0,
  oldest_cursor: 0,
  created_at: 0,
  last_activity: 0,
  session_name: null,
  first_prompt: null,
  capabilities: [],
};

describe("delta coalescing", () => {
  it("joins deltas into one streaming message", () => {
    const state = apply(
      fresh(),
      event("turn_start", { data: { turn: 1 } }),
      event("message_start"),
      event("assistant_delta", { delta: "you said", kind: "assistant" }),
      event("assistant_delta", { delta: ": hello", kind: "assistant" }),
    );

    expect(assistants(state)).toHaveLength(1);
    expect(assistants(state)[0]?.text).toBe("you said: hello");
    expect(assistants(state)[0]?.streaming).toBe(true);
    expect(state.state).toBe("running");
  });

  it("replaces the streamed text with the committed message", () => {
    const state = apply(
      fresh(),
      event("assistant_delta", { delta: "you s", kind: "assistant" }),
      event("assistant_message", {
        message: { role: "assistant", content: [{ type: "text", text: "you said: hello" }] },
      }),
      event("turn_end", { data: { turn: 1 } }),
    );

    expect(assistants(state)).toHaveLength(1);
    expect(assistants(state)[0]?.text).toBe("you said: hello");
    expect(assistants(state)[0]?.streaming).toBe(false);
    expect(state.state).toBe("idle");
  });

  it("keeps thinking text apart from the answer", () => {
    const state = apply(
      fresh(),
      event("assistant_delta", { delta: "hmm", kind: "thinking" }),
      event("assistant_delta", { delta: "answer", kind: "assistant" }),
    );

    expect(assistants(state)[0]?.thinking).toBe("hmm");
    expect(assistants(state)[0]?.text).toBe("answer");
  });

  it("drops failed retry text before the next attempt", () => {
    const state = apply(
      fresh(),
      event("assistant_delta", { delta: "failed", kind: "assistant" }),
      event("retry", { data: { retry: 1 } }),
      event("assistant_reset", { data: {} }),
      event("assistant_delta", { delta: "new", kind: "assistant" }),
    );

    expect(assistants(state)).toHaveLength(1);
    expect(assistants(state)[0]?.text).toBe("new");
    expect(state.openAssistantId).toBe(assistants(state)[0]?.id);
  });

  it("replaying a reset event log produces the same state", () => {
    const events = [
      event("assistant_delta", { delta: "failed", kind: "assistant" }),
      event("retry", { data: { retry: 1 } }),
      event("assistant_reset", { data: {} }),
      event("assistant_delta", { delta: "new", kind: "assistant" }),
    ];
    const first = apply(fresh(), ...events);
    const replay = apply(fresh(), ...events.map((item) => ({ ...item })));
    expect(replay).toEqual(first);
  });

  it("starts a second message after the first turn closes", () => {
    const state = apply(
      fresh(),
      event("assistant_delta", { delta: "one", kind: "assistant" }),
      event("turn_end"),
      event("gamma_user_message", { text: "again", mode: "send" }),
      event("assistant_delta", { delta: "two", kind: "assistant" }),
    );

    expect(assistants(state).map((item) => item.text)).toEqual(["one", "two"]);
    expect(state.items.map((item) => item.kind)).toEqual(["assistant", "user", "assistant"]);
  });

  it("records a committed message with no stream", () => {
    const state = apply(
      fresh(),
      event("assistant_message", {
        message: { role: "assistant", content: [{ type: "text", text: "direct" }] },
      }),
    );

    expect(assistants(state)).toHaveLength(1);
    expect(assistants(state)[0]?.streaming).toBe(false);
  });
});

describe("user messages", () => {
  it("shows send and steer turns", () => {
    const state = apply(
      fresh(),
      event("gamma_user_message", { text: "hello", mode: "send" }),
      event("gamma_user_message", { text: "also tests", mode: "steer" }),
    );

    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "hello", mode: "send" });
    expect(state.items[1]).toMatchObject({ kind: "user", mode: "steer" });
  });
});

describe("tool card lifecycle", () => {
  const call = { id: "tool-call-1", name: "bash", arguments: { command: "ls" } };

  it("runs from start to result", () => {
    const state = apply(
      fresh(),
      event("tool_start", { tool_call: call, data: {} }),
      event("tool_output", { tool_call: call, output: "a\n", data: {} }),
      event("tool_output", { tool_call: call, output: "b\n", data: {} }),
      event("tool_end", {
        tool_call: call,
        tool_result: { tool_call_id: call.id, content: "a\nb\n", is_error: false },
        data: {},
      }),
    );

    expect(tools(state)).toHaveLength(1);
    expect(tools(state)[0]).toMatchObject({
      name: "bash",
      output: "a\nb\n",
      result: "a\nb\n",
      phase: "done",
    });
  });

  it("marks a failed tool", () => {
    const state = apply(
      fresh(),
      event("tool_start", { tool_call: call, data: {} }),
      event("tool_end", {
        tool_call: call,
        tool_result: { tool_call_id: call.id, content: "boom", is_error: true },
        data: {},
      }),
    );

    expect(tools(state)[0]?.phase).toBe("error");
  });

  it("marks a canceled tool", () => {
    const state = apply(
      fresh(),
      event("tool_start", { tool_call: call, data: {} }),
      event("tool_end", {
        tool_call: call,
        tool_result: { tool_call_id: call.id, content: "", is_error: false, is_canceled: true },
        data: {},
      }),
    );

    expect(tools(state)[0]?.phase).toBe("denied");
  });

  it("ignores output for a tool it never saw start", () => {
    const state = apply(fresh(), event("tool_output", { tool_call: call, output: "x" }));
    expect(tools(state)).toHaveLength(0);
  });

  it("closes the open message before the tool card", () => {
    const state = apply(
      fresh(),
      event("assistant_delta", { delta: "let me look", kind: "assistant" }),
      event("tool_start", { tool_call: call, data: {} }),
    );

    expect(assistants(state)[0]?.streaming).toBe(false);
    expect(state.openAssistantId).toBeNull();
  });
});

describe("approval state", () => {
  const call = { id: "tool-call-1", name: "bash", arguments: { command: "rm -rf x" } };

  it("asks, then records the decision and its scope", () => {
    let state = apply(
      fresh(),
      event("tool_start", { tool_call: call, data: {} }),
      event("approval_request", { request_id: call.id, tool_call: call }),
    );

    expect(state.state).toBe("tool");
    expect(pendingApprovals(state)).toHaveLength(1);
    expect(tools(state)[0]?.phase).toBe("awaiting_approval");

    state = apply(
      state,
      event("gamma_approval_decision", {
        request_id: call.id,
        decision: "approve",
        scope: "always_tool",
      }),
    );

    expect(pendingApprovals(state)).toHaveLength(0);
    expect(state.items.find((item) => item.kind === "approval")).toMatchObject({
      phase: "approved",
      scope: "always_tool",
    });
  });

  it("records a denial", () => {
    const state = apply(
      fresh(),
      event("approval_request", { request_id: call.id, tool_call: call }),
      event("gamma_approval_decision", { request_id: call.id, decision: "deny", scope: "once" }),
    );

    expect(state.items.find((item) => item.kind === "approval")).toMatchObject({
      phase: "denied",
    });
  });

  it("stops asking when the harness closes the approval", () => {
    const state = apply(
      fresh(),
      event("approval_request", { request_id: call.id, tool_call: call }),
      event("approval_end", { request_id: call.id, tool_call: call, data: {} }),
    );

    expect(pendingApprovals(state)).toHaveLength(0);
    expect(state.items.find((item) => item.kind === "approval")).toMatchObject({
      phase: "closed",
    });
  });

  it("closes only the approval named by delegated approval_end", () => {
    const state = apply(
      fresh(),
      event("approval_request", { request_id: "foreground", tool_call: call }),
      event("approval_request", {
        request_id: "child-request",
        tool_call: call,
        delegated: true,
        agent_instance_id: "child-1",
      }),
      event("gamma_approval_decision", {
        request_id: "child-request",
        decision: "approve",
        scope: "once",
      }),
      event("approval_end", { request_id: "child-request", tool_call: call, data: {} }),
    );

    expect(state.items.find((item) => item.kind === "approval" && item.requestId === "foreground"))
      .toMatchObject({ phase: "pending" });
    expect(state.items.find((item) => item.kind === "approval" && item.requestId === "child-request"))
      .toMatchObject({ phase: "closed" });
  });

  it("closes delegated approval when its child ends", () => {
    const state = apply(
      fresh(),
      event("approval_request", {
        request_id: "child-request",
        tool_call: call,
        delegated: true,
        agent_instance_id: "child-1",
      }),
      event("approval_end", { request_id: "child-request", tool_call: call, data: {} }),
      event("turn_aborted", { data: { agent_instance_id: "child-1" } }),
    );

    expect(state.items.find((item) => item.kind === "approval" && item.requestId === "child-request"))
      .toMatchObject({ phase: "closed" });
  });

  it("does not duplicate a repeated request", () => {
    const state = apply(
      fresh(),
      event("approval_request", { request_id: call.id, tool_call: call }),
      event("approval_request", { request_id: call.id, tool_call: call }),
    );

    expect(state.items.filter((item) => item.kind === "approval")).toHaveLength(1);
  });

  it("records delegated approval without changing idle state", () => {
    const state = apply(
      fresh(),
      event("approval_request", {
        request_id: call.id,
        tool_call: call,
        delegated: true,
        data: {},
      }),
    );

    expect(state.state).toBe("idle");
    expect(state.items.at(-1)).toMatchObject({ kind: "approval", delegated: true });
  });

  it("leaves a running state unchanged for delegated approval", () => {
    const state = apply(
      fresh(),
      event("turn_start"),
      event("approval_request", {
        request_id: call.id,
        tool_call: call,
        delegated: true,
      }),
    );

    expect(state.state).toBe("running");
  });

  it("keeps a foreground run active for a delegated child end", () => {
    const state = apply(
      fresh(),
      event("turn_start"),
      event("agent_end", { data: { agent_instance_id: "child-1" } }),
    );

    expect(state.state).toBe("running");
    expect(state.runEndedAt).toBeNull();
  });

  it("still moves a non-delegated approval to tool", () => {
    const state = apply(
      fresh(),
      event("approval_request", { request_id: call.id, tool_call: call }),
    );

    expect(state.state).toBe("tool");
  });
});

describe("reconnect replay", () => {
  it("ignores events at or below the applied cursor", () => {
    const first = apply(
      fresh(),
      event("gamma_user_message", { text: "hello", mode: "send" }, 1),
      event("assistant_delta", { delta: "you said", kind: "assistant" }, 2),
      event("assistant_delta", { delta: ": hello", kind: "assistant" }, 3),
    );

    // The socket drops and the replay starts one event early.
    const replayed = apply(
      first,
      event("assistant_delta", { delta: ": hello", kind: "assistant" }, 3),
      event("assistant_message", {
        message: { role: "assistant", content: [{ type: "text", text: "you said: hello" }] },
      }, 4),
      event("turn_end", {}, 5),
    );

    expect(replayed.cursor).toBe(5);
    expect(assistants(replayed)).toHaveLength(1);
    expect(assistants(replayed)[0]?.text).toBe("you said: hello");
    expect(replayed.items.filter((item) => item.kind === "user")).toHaveLength(1);
  });

  it("keeps the applied cursor when every replayed event is old", () => {
    const state = apply(fresh(), event("turn_start", {}, 7));
    const again = apply(state, event("turn_start", {}, 3));
    expect(again.cursor).toBe(7);
    expect(again.items).toHaveLength(0);
  });

  it("advances the cursor for an unknown event", () => {
    const state = apply(fresh(), event("sub_agent_receipt", { data: {} }, 9));
    expect(state.cursor).toBe(9);
    expect(state.items).toHaveLength(0);
  });

  it("takes run state, usage, and open approvals from a snapshot", () => {
    const state = transcriptReducer(fresh(), {
      type: "snapshot",
      session: {
        ...session,
        state: "tool",
        usage: { input_tokens: 10, output_tokens: 4 },
        pending_approvals: [
          {
            request_id: "tool-call-9",
            tool_call: { id: "tool-call-9", name: "write", arguments: { path: "a" } },
          },
        ],
      },
    });

    expect(state.state).toBe("tool");
    expect(state.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
    expect(pendingApprovals(state)).toHaveLength(1);
  });

  it("reconciles approvals that disappear and appear in a snapshot", () => {
    const withOld = apply(
      fresh(),
      event("approval_request", {
        request_id: "old",
        tool_call: { id: "old-tool", name: "write", arguments: {} },
      }),
    );
    const afterSnapshot = transcriptReducer(withOld, {
      type: "snapshot",
      session: {
        ...session,
        pending_approvals: [
          {
            request_id: "new",
            tool_call: { id: "new-tool", name: "bash", arguments: {} },
            delegated: true,
            agent_instance_id: "child-1",
          },
        ],
      },
    });

    expect(afterSnapshot.items.find((item) => item.kind === "approval" && item.requestId === "old"))
      .toMatchObject({ phase: "closed" });
    expect(afterSnapshot.items.find((item) => item.kind === "approval" && item.requestId === "new"))
      .toMatchObject({ phase: "pending", delegated: true, agentInstanceId: "child-1" });
  });

  it("does not add an approval a replayed event already created", () => {
    const withEvent = apply(
      fresh(),
      event("approval_request", {
        request_id: "tool-call-9",
        tool_call: { id: "tool-call-9", name: "write", arguments: {} },
      }),
    );
    const afterSnapshot = transcriptReducer(withEvent, {
      type: "snapshot",
      session: {
        ...session,
        pending_approvals: [
          {
            request_id: "tool-call-9",
            tool_call: { id: "tool-call-9", name: "write", arguments: {} },
          },
        ],
      },
    });

    expect(afterSnapshot.items.filter((item) => item.kind === "approval")).toHaveLength(1);
  });
});

describe("session end and failures", () => {
  it("reports an error event and returns to idle", () => {
    const state = apply(
      fresh(),
      event("turn_start"),
      event("error", { error: { code: "backend_error", message: "provider failed" }, data: {} }),
    );

    expect(state.state).toBe("idle");
    expect(state.items.at(-1)).toMatchObject({
      kind: "notice",
      level: "error",
      text: "backend_error: provider failed",
    });
  });

  it("notes an aborted turn", () => {
    const state = apply(fresh(), event("turn_start"), event("turn_aborted", { data: {} }));
    expect(state.state).toBe("idle");
    expect(state.items.at(-1)).toMatchObject({ kind: "notice", text: "Turn aborted." });
  });

  it("notes compaction with its token count", () => {
    const state = apply(fresh(), event("compaction_end", { data: { token_count: 1200 } }));
    expect(state.items.at(-1)).toMatchObject({ text: "History compacted (1200 tokens)." });
  });

  it("marks the session closed", () => {
    const state = apply(fresh(), event("gamma_session_closed"));
    expect(state.closed).toBe(true);
    expect(state.state).toBe("idle");
  });

  it("resets on demand", () => {
    const state = apply(fresh(), event("turn_start"));
    expect(transcriptReducer(state, { type: "reset" })).toEqual(emptyTranscript);
  });
});

describe("run and tool timing", () => {
  const call = { id: "tool-call-1", name: "bash", arguments: { command: "ls" } };

  it("times a run from the user's send to agent_end, across model turns", () => {
    let state = apply(
      fresh(),
      event("gamma_user_message", { text: "go", mode: "send" }, 1),
      event("agent_start", {}, 2),
      event("turn_start", {}, 3),
      event("turn_end", {}, 4),
      event("turn_start", {}, 5),
    );
    expect(state.runStartedAt).toBe(1001);
    expect(state.runEndedAt).toBeNull();

    state = apply(state, event("turn_end", {}, 6), event("agent_end", {}, 7));
    expect(state.runStartedAt).toBe(1001);
    expect(state.runEndedAt).toBe(1007);
  });

  it("does not restart the run on a steer", () => {
    const state = apply(
      fresh(),
      event("gamma_user_message", { text: "go", mode: "send" }, 1),
      event("gamma_user_message", { text: "faster", mode: "steer" }, 4),
    );
    expect(state.runStartedAt).toBe(1001);
  });

  it("starts a fresh run after the last one ended", () => {
    const state = apply(
      fresh(),
      event("agent_start", {}, 1),
      event("agent_end", {}, 2),
      event("gamma_user_message", { text: "again", mode: "send" }, 5),
    );
    expect(state.runStartedAt).toBe(1005);
    expect(state.runEndedAt).toBeNull();
  });

  it("ends the run on abort and on error", () => {
    const aborted = apply(fresh(), event("agent_start", {}, 1), event("turn_aborted", {}, 3));
    expect(aborted.runEndedAt).toBe(1003);
    const failed = apply(
      fresh(),
      event("agent_start", {}, 1),
      event("error", { error: { code: "x", message: "y" } }, 2),
    );
    expect(failed.runEndedAt).toBe(1002);
  });

  it("records when a tool starts and ends, keyed by its call id", () => {
    const state = apply(
      fresh(),
      event("tool_start", { tool_call: call, data: {} }, 3),
      event("tool_end", { tool_call: call, tool_result: { content: "ok" }, data: {} }, 8),
    );
    expect(tools(state)[0]).toMatchObject({ callId: "tool-call-1", startedAt: 1003, endedAt: 1008 });
  });

  it("keeps the first start time when a replay repeats tool_start", () => {
    const state = apply(
      fresh(),
      event("tool_start", { tool_call: call, data: {} }, 3),
      event("approval_request", { request_id: "r1", tool_call: call }, 4),
      event("tool_start", { tool_call: call, data: {} }, 6),
    );
    expect(tools(state)[0]?.startedAt).toBe(1003);
    expect(tools(state)[0]?.phase).toBe("running");
  });
});
