import { describe, expect, it } from "vitest";

import {
  emptyTranscript,
  transcriptReducer,
  type GammaEvent,
  type TranscriptState,
} from "./transcript";
import { isBusy, runPhase, runSeconds, toolSeconds, transcriptBlocks, usageTotals } from "./view";

let cursor = 0;

function play(...events: [string, Record<string, unknown>?][]): TranscriptState {
  cursor = 0;
  return events.reduce<TranscriptState>((state, [name, payload]) => {
    cursor += 1;
    const event: GammaEvent = { cursor, at: 100 + cursor, event: name, payload: payload ?? {} };
    return transcriptReducer(state, { type: "event", event });
  }, emptyTranscript);
}

const call = (id: string, name = "bash", args: Record<string, unknown> = { command: "ls" }) => ({
  id,
  name,
  arguments: args,
});

describe("transcriptBlocks", () => {
  it("groups consecutive tool calls and splits groups at text", () => {
    const state = play(
      ["gamma_user_message", { text: "go", mode: "send" }],
      ["tool_start", { tool_call: call("a") }],
      ["tool_end", { tool_call: call("a"), tool_result: { content: "" } }],
      ["tool_start", { tool_call: call("b", "read", { path: "x" }) }],
      ["assistant_delta", { delta: "done", kind: "assistant" }],
      ["tool_start", { tool_call: call("c") }],
    );
    const blocks = transcriptBlocks(state);
    expect(blocks.map((block) => block.kind)).toEqual(["user", "tools", "assistant", "tools"]);
    const first = blocks[1];
    expect(first?.kind === "tools" && first.rows.map((row) => row.name)).toEqual(["bash", "read"]);
  });

  it("folds an approval into its tool row instead of a separate block", () => {
    const state = play(
      ["tool_start", { tool_call: call("a") }],
      ["approval_request", { request_id: "r1", tool_call: call("a") }],
      ["gamma_approval_decision", { request_id: "r1", decision: "approve", scope: "always_tool" }],
    );
    const blocks = transcriptBlocks(state);
    expect(blocks).toHaveLength(1);
    const group = blocks[0];
    expect(group?.kind).toBe("tools");
    if (group?.kind !== "tools") return;
    expect(group.rows).toHaveLength(1);
    expect(group.rows[0]?.approval?.scope).toBe("always_tool");
    expect(group.rows[0]?.phase).toBe("running");
  });

  it("shows an approval for a tool that has not started as its own row", () => {
    const state = play(["approval_request", { request_id: "r1", tool_call: call("a", "write") }]);
    const group = transcriptBlocks(state)[0];
    expect(group?.kind === "tools" && group.rows[0]).toMatchObject({
      name: "write",
      phase: "awaiting_approval",
      tool: null,
    });
  });

  it("marks a tool whose approval was denied as denied", () => {
    const state = play(
      ["tool_start", { tool_call: call("a") }],
      ["approval_request", { request_id: "r1", tool_call: call("a") }],
      ["gamma_approval_decision", { request_id: "r1", decision: "deny" }],
    );
    const group = transcriptBlocks(state)[0];
    expect(group?.kind === "tools" && group.rows[0]?.phase).toBe("denied");
  });
});

describe("runPhase", () => {
  it("is idle before anything happens", () => {
    expect(runPhase(emptyTranscript)).toEqual({ kind: "idle" });
    expect(isBusy(emptyTranscript)).toBe(false);
  });

  it("thinks, responds, runs a tool, and waits for approval", () => {
    const thinking = play(["gamma_user_message", { text: "go", mode: "send" }], ["agent_start"]);
    expect(runPhase(thinking)).toEqual({ kind: "thinking" });

    const responding = play(["agent_start"], ["assistant_delta", { delta: "x", kind: "assistant" }]);
    expect(runPhase(responding)).toEqual({ kind: "responding" });

    const tool = play(["agent_start"], ["tool_start", { tool_call: call("a", "read") }]);
    expect(runPhase(tool)).toEqual({ kind: "tool", name: "read" });

    const asking = play(
      ["agent_start"],
      ["tool_start", { tool_call: call("a") }],
      ["approval_request", { request_id: "r1", tool_call: call("a") }],
    );
    expect(runPhase(asking)).toEqual({ kind: "approval", name: "bash" });
  });

  it("stays busy between model turns until agent_end", () => {
    const between = play(["agent_start"], ["turn_start"], ["turn_end"]);
    expect(between.state).toBe("idle");
    expect(isBusy(between)).toBe(true);
    expect(runPhase(between)).toEqual({ kind: "thinking" });

    const done = play(["agent_start"], ["turn_start"], ["turn_end"], ["agent_end"]);
    expect(isBusy(done)).toBe(false);
  });

  it("reports a closed session", () => {
    expect(runPhase(play(["agent_start"], ["gamma_session_closed"]))).toEqual({ kind: "closed" });
  });
});

describe("durations", () => {
  it("counts a live run against now and a finished run against its end", () => {
    const live = play(["agent_start"]);
    expect(runSeconds(live, 110)).toBe(9);
    const done = play(["agent_start"], ["agent_end"]);
    expect(runSeconds(done, 500)).toBe(1);
    expect(runSeconds(emptyTranscript, 500)).toBeNull();
  });

  it("never goes negative under clock skew", () => {
    expect(runSeconds(play(["agent_start"]), 0)).toBe(0);
  });

  it("measures a tool from start to end", () => {
    const state = play(
      ["tool_start", { tool_call: call("a") }],
      ["tool_output", { tool_call: call("a"), output: "x" }],
      ["tool_end", { tool_call: call("a"), tool_result: { content: "" } }],
    );
    const tool = state.items[0];
    expect(tool?.kind === "tool" && toolSeconds(tool, 999)).toBe(2);
  });
});

describe("usageTotals", () => {
  it("reads token counts and ignores anything else", () => {
    expect(usageTotals({ input_tokens: 12, output_tokens: "x" })).toEqual({
      input: 12,
      output: null,
    });
  });
});
