/**
 * A scripted session for the dev-only fixture route (#/fixture).
 *
 * The fake provider cannot call tools, so this script stands in for a real
 * agent run: user turns, streamed markdown, tool calls that pass, fail, and
 * get denied, and a pending approval. It is a list of gamma events, played
 * through the real transcript reducer, so the fixture shows exactly what a
 * live session with the same events would show.
 */

import type { SessionView } from "../lib/protocol";
import type { GammaEvent } from "../lib/transcript";

/** `reconnecting` is the streaming run seen through a dropped socket. */
export type FixtureVariant = "approval" | "streaming" | "empty" | "reconnecting";

export const fixtureSession: SessionView = {
  session_id: "fixture",
  zeta_session_id: "fixture-zeta",
  provider: "claude",
  model: "claude-sonnet-4-5",
  cwd: "/Users/ada/code/acme-api",
  protocol_version: "1.1",
  state: "tool",
  usage: {},
  pending_approvals: [],
  cursor: 0,
  oldest_cursor: 0,
  created_at: 0,
  last_activity: 0,
  session_name: "Fix the failing health check",
  first_prompt: "The health check test fails on main. Find out why and fix it, then summarize the change.",
  capabilities: [],
};

type Step = [name: string, payload?: Record<string, unknown>, secondsLater?: number];

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  tool_call: { id, name, arguments: args },
});

const done = (id: string, name: string, args: Record<string, unknown>, content: string) => [
  ["tool_start", call(id, name, args), 0.2],
  ["tool_end", { ...call(id, name, args), tool_result: { content, is_error: false } }, 0.6],
] as Step[];

const say = (text: string): Step[] => {
  const words = text.match(/\S+\s*/g) ?? [];
  const chunks: Step[] = [];
  for (let index = 0; index < words.length; index += 6) {
    chunks.push(["assistant_delta", { delta: words.slice(index, index + 6).join(""), kind: "assistant" }, 0.05]);
  }
  return chunks;
};

const commit = (text: string): Step => [
  "assistant_message",
  { message: { role: "assistant", content: [{ type: "text", text }] } },
  0.05,
];

const INTRO =
  "I'll look at the layout first, then run the suite to see what fails.";

const DIAGNOSIS = `The failure is a missing route: \`/health\` returns **404** because the router is never mounted.

Here is the fix I want to make in \`src/app.py\`:

\`\`\`python
from fastapi import FastAPI

from .routes import health

app = FastAPI()
app.include_router(health.router)
\`\`\`

| check | before | after |
| --- | --- | --- |
| \`GET /health\` | 404 | 200 |
| test suite | 1 failed | passing |

Next steps:

1. Mount the router.
2. Re-run \`pytest -q\`.
3. Add a regression test for the 404 case.`;

const STREAMING = `Both tests pass now. Summary of the change:

- **src/app.py**: mounts the \`health\` router, so \`GET /health\` answers \`200\`.
- **tests/test_health.py**: a new regression test that`;

const RERUN = "The regression test is in place. Running the whole suite once more.";

const README = `# acme-api

A small FastAPI service.

## Run

    uv run uvicorn acme.app:app --reload
`;

const PYTEST_FAIL = `F.....                                                    [100%]
=================================== FAILURES ===================================
______________________________ test_health ______________________________

    def test_health(client):
        response = client.get("/health")
>       assert response.status_code == 200
E       assert 404 == 200

tests/test_api.py:12: AssertionError
=========================== short test summary info ============================
FAILED tests/test_api.py::test_health - assert 404 == 200
1 failed, 5 passed in 0.41s`;

function script(variant: FixtureVariant): Step[] {
  if (variant === "empty") {
    return [["gamma_session_ready", {}, 0]];
  }
  const editArgs = {
    path: "src/app.py",
    old_string: "app = FastAPI()",
    new_string: "app = FastAPI()\napp.include_router(health.router)",
  };
  const rmArgs = { command: "rm -rf build/ .pytest_cache" };
  const steps: Step[] = [
    ["gamma_user_message", { text: "The health check test fails on main. Find out why and fix it, then summarize the change.", mode: "send" }, 0],
    ["agent_start", {}, 0.1],
    ["turn_start", {}, 0.05],
    ["assistant_delta", { delta: "The user wants the failing test fixed. Start with the layout and a test run.", kind: "thinking" }, 0.4],
    ...say(INTRO),
    commit(INTRO),
    ...done("t1", "read", { path: "README.md" }, README),
    ...done("t2", "bash", { command: "ls src tests" }, "src:\nacme\napp.py\nroutes\n\ntests:\ntest_api.py\n"),
    ["tool_start", call("t3", "bash", { command: "pytest -q" }), 0.2],
    ["tool_output", { ...call("t3", "bash", { command: "pytest -q" }), output: PYTEST_FAIL }, 1.4],
    ["tool_end", { ...call("t3", "bash", { command: "pytest -q" }), tool_result: { content: PYTEST_FAIL, is_error: true } }, 0.1],
    ...done("t4", "read", { path: "src/app.py" }, "from fastapi import FastAPI\n\nfrom .routes import health\n\napp = FastAPI()\n"),
    ["usage", { usage: { input_tokens: 18240, output_tokens: 912 } }, 0.1],
    ...say(DIAGNOSIS),
    commit(DIAGNOSIS),
    ["tool_start", call("t5", "edit", editArgs), 0.2],
    ["approval_request", { request_id: "r5", ...call("t5", "edit", editArgs), approval_display: { effective_cwd: "/Users/ada/code/acme-api", resolved_path: "/Users/ada/code/acme-api/src/app.py" } }, 0.1],
    ["gamma_approval_decision", { request_id: "r5", decision: "approve", scope: "once" }, 3],
    ["tool_start", call("t5", "edit", editArgs), 0.05],
    ["tool_end", { ...call("t5", "edit", editArgs), tool_result: { content: "Edited src/app.py (1 replacement).", is_error: false } }, 0.2],
    ["tool_start", call("t6", "bash", rmArgs), 0.2],
    ["approval_request", { request_id: "r6", ...call("t6", "bash", rmArgs) }, 0.1],
    ["gamma_approval_decision", { request_id: "r6", decision: "deny", scope: "once" }, 2],
    ["tool_end", { ...call("t6", "bash", rmArgs), tool_result: { content: "Denied by the user.", is_error: false, is_canceled: true } }, 0.1],
    ["gamma_user_message", { text: "Also add a regression test for the 404 case.", mode: "steer" }, 1],
    ...done("t7", "bash", { command: "rg -n \"include_router\" src" }, "src/app.py:6:app.include_router(health.router)\n"),
    ...done("t8", "read", { path: "tests/test_api.py" }, "def test_health(client):\n    ...\n"),
    ...done("t9", "read", { path: "tests/conftest.py" }, "import pytest\n"),
    ["tool_start", call("t10", "bash", { command: "pytest -q tests/test_api.py::test_missing" }), 0.2],
    ["tool_end", { ...call("t10", "bash", { command: "pytest -q tests/test_api.py::test_missing" }), tool_result: { content: "ERROR: not found: tests/test_api.py::test_missing\n(no match in any of [<Module test_api.py>])", is_error: true } }, 0.8],
    ...done("t11", "write", { path: "tests/test_health.py", content: "def test_unknown_route(client):\n    assert client.get(\"/nope\").status_code == 404\n" }, "Wrote tests/test_health.py (2 lines)."),
    ["usage", { usage: { input_tokens: 48231, output_tokens: 2210 } }, 0.1],
    ...say(RERUN),
    commit(RERUN),
  ];
  if (variant === "streaming" || variant === "reconnecting") {
    return [
      ...steps,
      ...done("t12", "bash", { command: "pytest -q" }, "......\n7 passed in 0.38s\n"),
      ...say(STREAMING),
    ];
  }
  const commitArgs = { command: "git add -A && git commit -m \"Mount the health router and add a 404 test\"" };
  return [
    ...steps,
    ["tool_start", call("t12", "bash", { command: "pytest -q" }), 0.2],
    ["tool_output", { ...call("t12", "bash", { command: "pytest -q" }), output: "......" }, 0.3],
    ["tool_start", call("t13", "bash", commitArgs), 0.1],
    ["approval_request", { request_id: "r13", ...call("t13", "bash", commitArgs), approval_display: { effective_cwd: "/Users/ada/code/acme-api" } }, 0.1],
  ];
}

/** The script as cursored events, timed so the last one happened just now. */
export function fixtureEvents(variant: FixtureVariant, now: number): GammaEvent[] {
  const steps = script(variant);
  const total = steps.reduce((sum, [, , later]) => sum + (later ?? 0), 0);
  let at = now - total;
  return steps.map(([event, payload, later], index) => {
    at += later ?? 0;
    return { cursor: index + 1, at, event, payload: payload ?? {} };
  });
}
