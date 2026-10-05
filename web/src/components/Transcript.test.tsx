import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Transcript } from "./Transcript";
import type { TranscriptItem } from "../lib/transcript";

const items: TranscriptItem[] = [
  { kind: "user", id: "u1", cursor: 1, text: "list the files", mode: "send" },
  {
    kind: "assistant",
    id: "a1",
    cursor: 2,
    text: "I will run `ls`.",
    thinking: "",
    streaming: false,
  },
  {
    kind: "tool",
    id: "tool-1",
    cursor: 3,
    name: "bash",
    args: { command: "ls" },
    output: "README.md\n",
    result: "README.md\n",
    phase: "done",
  },
  {
    kind: "approval",
    id: "approval-1",
    cursor: 4,
    requestId: "req-1",
    toolCallId: "tool-2",
    name: "write",
    args: { path: "notes.md" },
    phase: "pending",
    scope: null,
  },
  { kind: "notice", id: "n1", cursor: 5, level: "error", text: "backend_error: nope" },
];

describe("Transcript", () => {
  it("renders every item kind", () => {
    render(
      <Transcript items={items} supportsAlways={true} onApprove={() => {}} onDeny={() => {}} />,
    );

    expect(screen.getByText("list the files")).toBeDefined();
    expect(screen.getByRole("log", { name: "conversation" })).toBeDefined();
    expect(screen.getByRole("button", { name: /bash/ })).toBeDefined();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Always allow write" })).toBeDefined();
    expect(screen.getByText("backend_error: nope")).toBeDefined();
  });

  it("renders model markdown as text, never as markup", () => {
    const risky: TranscriptItem[] = [
      {
        kind: "assistant",
        id: "a2",
        cursor: 1,
        text: "<img src=x onerror=alert(1)> and **bold**",
        thinking: "",
        streaming: true,
      },
    ];
    const { container } = render(
      <Transcript items={risky} supportsAlways={false} onApprove={() => {}} onDeny={() => {}} />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  });

  it("hides the always-allow button for a 1.0 harness", () => {
    render(
      <Transcript items={items} supportsAlways={false} onApprove={() => {}} onDeny={() => {}} />,
    );

    expect(screen.queryByRole("button", { name: "Always allow write" })).toBeNull();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeDefined();
  });

  it("shows an empty state", () => {
    render(<Transcript items={[]} supportsAlways={true} onApprove={() => {}} onDeny={() => {}} />);
    expect(screen.getByText(/No messages yet/)).toBeDefined();
  });
});
