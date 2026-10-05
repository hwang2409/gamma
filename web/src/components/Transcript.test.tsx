import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionView } from "../lib/protocol";
import {
  emptyTranscript,
  transcriptReducer,
  type GammaEvent,
  type TranscriptState,
} from "../lib/transcript";
import { transcriptBlocks } from "../lib/view";
import { Composer } from "./Composer";
import { SessionLayout, type SessionActions } from "./SessionLayout";
import { Transcript } from "./Transcript";

afterEach(cleanup);

function play(...events: [string, Record<string, unknown>?][]): TranscriptState {
  return events.reduce<TranscriptState>((state, [event, payload], index) => {
    const frame: GammaEvent = { cursor: index + 1, at: 100 + index, event, payload: payload ?? {} };
    return transcriptReducer(state, { type: "event", event: frame });
  }, emptyTranscript);
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  tool_call: { id, name, arguments: args },
});

const session: SessionView = {
  session_id: "g1",
  zeta_session_id: "z1",
  provider: "fake",
  model: "offline",
  cwd: "/tmp/work",
  protocol_version: "1.1",
  state: "running",
  usage: {},
  pending_approvals: [],
  cursor: 0,
  oldest_cursor: 0,
  created_at: 0,
  last_activity: 0,
  session_name: null,
  capabilities: [],
};

function actions(): SessionActions & Record<string, ReturnType<typeof vi.fn>> {
  return {
    send: vi.fn(),
    steer: vi.fn(),
    abort: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    dismissError: vi.fn(),
  };
}

describe("Transcript", () => {
  it("renders user turns, assistant text, tool rows, and notices", () => {
    const state = play(
      ["gamma_user_message", { text: "list the files", mode: "send" }],
      ["assistant_delta", { delta: "I will run `ls`.", kind: "assistant" }],
      ["tool_start", call("t1", "bash", { command: "ls -la" })],
      ["tool_end", { ...call("t1", "bash", { command: "ls -la" }), tool_result: { content: "README.md" } }],
      ["error", { error: { code: "backend_error", message: "nope" } }],
    );
    render(<Transcript blocks={transcriptBlocks(state)} now={200} />);

    expect(screen.getByRole("log", { name: "conversation" })).toBeDefined();
    expect(screen.getByText("list the files")).toBeDefined();
    const row = screen.getByRole("button", { name: /bash/ });
    expect(within(row).getByText("ls -la")).toBeDefined();
    expect(screen.getByText("backend_error: nope")).toBeDefined();
  });

  it("renders model markdown as text, never as markup", () => {
    const state = play([
      "assistant_delta",
      { delta: "<img src=x onerror=alert(1)> and **bold**", kind: "assistant" },
    ]);
    const { container } = render(<Transcript blocks={transcriptBlocks(state)} now={0} />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  });

  it("labels fenced code with its language and offers a copy button", () => {
    const state = play([
      "assistant_message",
      { message: { content: [{ type: "text", text: "```python\nprint(1)\n```" }] } },
    ]);
    render(<Transcript blocks={transcriptBlocks(state)} now={0} />);
    expect(screen.getByText("python")).toBeDefined();
    expect(screen.getByRole("button", { name: "Copy" })).toBeDefined();
  });

  it("shows a failed tool's error without expanding, and the output on expand", () => {
    const state = play(
      ["tool_start", call("t1", "bash", { command: "pytest -q" })],
      [
        "tool_end",
        {
          ...call("t1", "bash", { command: "pytest -q" }),
          tool_result: { content: "1 failed\ndetails", is_error: true },
        },
      ],
    );
    render(<Transcript blocks={transcriptBlocks(state)} now={0} />);
    expect(screen.getByText("1 failed")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /pytest -q/ }));
    expect(screen.getByText(/1 failed\s+details/)).toBeDefined();
  });

  it("folds a finished group of tool calls but keeps failures visible", () => {
    const steps: [string, Record<string, unknown>][] = [];
    for (const id of ["a", "b", "c", "d"]) {
      const failed = id === "c";
      steps.push(["tool_start", call(id, "read", { path: `${id}.txt` })]);
      steps.push([
        "tool_end",
        { ...call(id, "read", { path: `${id}.txt` }), tool_result: { content: "x", is_error: failed } },
      ]);
    }
    render(<Transcript blocks={transcriptBlocks(play(...steps))} now={0} />);

    const head = screen.getByRole("button", { name: /4 tool calls/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("c.txt")).toBeDefined();
    expect(screen.queryByText("a.txt")).toBeNull();

    fireEvent.click(head);
    expect(screen.getByText("a.txt")).toBeDefined();
  });

  it("guides an empty session", () => {
    render(<Transcript blocks={[]} now={0} />);
    expect(screen.getByText(/Describe a task/)).toBeDefined();
  });
});

describe("SessionLayout approvals", () => {
  const asking = () =>
    play(
      ["agent_start"],
      ["tool_start", call("t1", "write", { path: "notes.md", content: "hi" })],
      ["approval_request", { request_id: "req-1", ...call("t1", "write", { path: "notes.md", content: "hi" }) }],
    );

  it("pins the pending approval with its path and every choice", () => {
    const handlers = actions();
    render(
      <SessionLayout
        session={session}
        transcript={asking()}
        connection="open"
        error={null}
        actions={handlers}
        onBack={() => {}}
        onEnd={() => {}}
      />,
    );
    const card = screen.getByRole("region", { name: /Allow write/ });
    expect(within(card).getByText("notes.md")).toBeDefined();

    fireEvent.click(within(card).getByRole("button", { name: /Always allow write/ }));
    expect(handlers.approve).toHaveBeenCalledWith("req-1", "always_tool");
    fireEvent.click(within(card).getByRole("button", { name: /Deny/ }));
    expect(handlers.deny).toHaveBeenCalledWith("req-1");
  });

  it("hides always-allow for a 1.0 harness", () => {
    render(
      <SessionLayout
        session={{ ...session, protocol_version: "1.0" }}
        transcript={asking()}
        connection="open"
        error={null}
        actions={actions()}
        onBack={() => {}}
        onEnd={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /Always allow/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Approve/ })).toBeDefined();
  });

  it("approves with Cmd+Enter and denies with Escape", () => {
    const handlers = actions();
    render(
      <SessionLayout
        session={session}
        transcript={asking()}
        connection="open"
        error={null}
        actions={handlers}
        onBack={() => {}}
        onEnd={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(handlers.approve).toHaveBeenCalledWith("req-1", "once");
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true, shiftKey: true });
    expect(handlers.approve).toHaveBeenLastCalledWith("req-1", "always_tool");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(handlers.deny).toHaveBeenCalledWith("req-1");
    expect(handlers.abort).not.toHaveBeenCalled();
  });

  it("stops a busy run with Escape when nothing is pending", () => {
    const handlers = actions();
    render(
      <SessionLayout
        session={session}
        transcript={play(["agent_start"])}
        connection="open"
        error={null}
        actions={handlers}
        onBack={() => {}}
        onEnd={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(handlers.abort).toHaveBeenCalledOnce();
    expect(screen.getByText("Thinking")).toBeDefined();
  });
});

describe("Composer", () => {
  const setup = (busy: boolean) => {
    const handlers = { onSend: vi.fn(), onSteer: vi.fn(), onAbort: vi.fn() };
    const ref = { current: null as HTMLTextAreaElement | null };
    render(<Composer busy={busy} disabled={false} inputRef={ref} {...handlers} />);
    return { handlers, input: screen.getByRole("textbox") };
  };

  it("sends on Enter and keeps Shift+Enter for a new line", () => {
    const { handlers, input } = setup(false);
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(handlers.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(handlers.onSend).toHaveBeenCalledWith("hello");
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("steers while busy and offers Stop instead of Send", () => {
    const { handlers, input } = setup(true);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(handlers.onAbort).toHaveBeenCalledOnce();

    fireEvent.change(input, { target: { value: "use the other file" } });
    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    expect(handlers.onSteer).toHaveBeenCalledWith("use the other file");
  });
});
