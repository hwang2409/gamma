import { describe, expect, test } from "bun:test";
import { createCommandController, type CommandCapabilities, type CommandRequest } from "../src/commands";

type Frame = { method: string; params: Record<string, unknown> };

const modern: CommandCapabilities = {
  // Zeta docs/serve-protocol.md:1341-1347: model input IDs are opaque and single-use.
  features: new Set(["model_input_ids"]),
  requests: new Set(["slash_list", "slash_run"]),
};

function fake(replies: Record<string, unknown>, capabilities = modern) {
  const frames: Frame[] = [];
  const request: CommandRequest = async (method, params) => {
    frames.push({ method, params });
    return replies[method];
  };
  return { controller: createCommandController("session-1", request, capabilities), frames };
}

// Fixtures below mirror Zeta docs/serve-protocol.md:1304-1328 and
// src/zeta/server/slash_commands.py:343-346,385-445 at origin/main a61de24e.
const slashList = {
  commands: [
    { name: "status", description: "show session status", kind: "builtin", source: "builtin", client_only: false, unavailable: null },
    { name: "story", description: "write a story", kind: "macro-prompt", source: "project", client_only: false, unavailable: null },
    { name: "review", description: "review this change", kind: "skill", source: "home", client_only: false, unavailable: null },
    { name: "release", description: "prepare a release", kind: "skill", source: "project", client_only: false, unavailable: null },
  ],
  notices: [],
};

describe("slash results", () => {
  const cases = [
    ["output", { kind: "output", text: "model: luna" }, { kind: "receipt", text: "model: luna", tone: "quiet" }],
    // Legacy /mcp status frame from Zeta 5feea2fc src/zeta/server/slash_commands.py:413-425.
    ["text", { kind: "text", text: "server: connected" }, { kind: "receipt", text: "server: connected", tone: "quiet" }],
    ["error", { kind: "error", text: "status unavailable" }, { kind: "receipt", text: "status unavailable", tone: "error" }],
    ["unknown", { kind: "unknown", name: "wat" }, { kind: "receipt", text: "unknown command: /wat", tone: "error" }],
    ["model_input", { kind: "model_input", input_id: "opaque-1", display_text: "/review this" }, { kind: "send-input", inputId: "opaque-1", displayText: "/review this" }],
  ] as const;

  for (const [name, result, expected] of cases) test(name, async () => {
    const { controller, frames } = fake({ slash_run: result });
    expect(await controller.prepareComposerInput(name === "unknown" ? "/wat" : "/review this")).toEqual(expected);
    expect(frames).toEqual([{ method: "slash_run", params: { session_id: "session-1", text: name === "unknown" ? "/wat" : "/review this" } }]);
  });

  test("unknown slash input is never returned as model text", async () => {
    const { controller } = fake({ slash_run: { kind: "unknown", name: "missing" } });
    expect((await controller.prepareComposerInput("/missing args")).kind).toBe("receipt");
  });

  test("an opaque model input id is returned once without expansion text", async () => {
    const { controller, frames } = fake({ slash_run: { kind: "model_input", input_id: "one-use", display_text: "/review secret", text: "hidden expansion" } });
    expect(await controller.prepareComposerInput("/review secret")).toEqual({ kind: "send-input", inputId: "one-use", displayText: "/review secret" });
    expect(frames).toHaveLength(1);
  });

  test.each([
    ["malformed", { kind: "output" }],
    ["unknown", { kind: "future_result", text: "surprise" }],
  ])("%s slash frames become error receipts", async (_name, result) => {
    const { controller } = fake({ slash_run: result });
    expect(await controller.prepareComposerInput("/status")).toEqual({
      kind: "receipt",
      text: "invalid response from server",
      tone: "error",
    });
  });
});

test("client-only commands use only the explicit gamma mapping and keep arguments", async () => {
  const mappings = {
    new: "new_session", name: "rename_session", approve: "approve", always: "always", deny: "deny",
    theme: "theme", tree: "branch_view", model: "model", vim: "vim", paste: "paste", accounts: "accounts",
  } as const;
  for (const [command, action] of Object.entries(mappings)) {
    const { controller } = fake({ slash_run: { kind: "client_only", name: command } });
    expect(await controller.prepareComposerInput(`/${command} alpha beta`)).toEqual({ kind: "client-action", name: action, args: "alpha beta" });
  }
  const { controller } = fake({ slash_run: { kind: "client_only", name: "restart" } });
  expect(await controller.prepareComposerInput("/restart")).toEqual({ kind: "receipt", text: "not available in this server version", tone: "error" });
});

test("leading whitespace still dispatches the first nonempty slash token", async () => {
  const { controller, frames } = fake({ slash_run: { kind: "output", text: "ok" } });
  await controller.prepareComposerInput(" \n /status");
  expect(frames[0]).toEqual({ method: "slash_run", params: { session_id: "session-1", text: "/status" } });
});

test("double slash escapes to one literal slash without calling slash_run", async () => {
  const { controller, frames } = fake({});
  expect(await controller.prepareComposerInput("//status")).toEqual({ kind: "send", text: "/status" });
  expect(frames).toEqual([]);
});

describe("inline dollar skills", () => {
  const inputPrepareCapabilities: CommandCapabilities = {
    features: new Set(["model_input_ids", "input_prepare"]),
    requests: new Set(["slash_list", "slash_run", "input_prepare"]),
  };

  test("without input_prepare, dollar text stays plain text", async () => {
    const { controller, frames } = fake({});
    expect(await controller.prepareComposerInput("please use $review now")).toEqual({ kind: "send", text: "please use $review now" });
    expect(frames).toEqual([]);
  });

  // Provisional fixtures from design-serve-capability-registry.md section 4 "z1"; zeta z1 has not shipped.
  const cases = [
    [{ kind: "direct" }, { kind: "send", text: "please use $review now" }],
    [{ kind: "model_input", input_id: "skill-1", display_text: "please use $review now" }, { kind: "send-input", inputId: "skill-1", displayText: "please use $review now" }],
    [{ kind: "error", text: "skill load failed" }, { kind: "receipt", text: "skill load failed", tone: "error" }],
  ] as const;

  for (const [result, expected] of cases) test(result.kind, async () => {
    const { controller, frames } = fake({ input_prepare: result }, inputPrepareCapabilities);
    expect(await controller.prepareComposerInput("please use $review now")).toEqual(expected);
    expect(frames).toEqual([{ method: "input_prepare", params: { session_id: "session-1", text: "please use $review now" } }]);
  });

  test.each([
    ["null", null],
    ["missing kind", {}],
    ["unknown kind", { kind: "future" }],
    ["model_input without required fields", { kind: "model_input" }],
    ["error without text", { kind: "error" }],
  ])("%s input_prepare frames become error receipts", async (_name, result) => {
    const { controller } = fake({ input_prepare: result }, inputPrepareCapabilities);
    expect(await controller.prepareComposerInput("please use $review now")).toEqual({
      kind: "receipt",
      text: "invalid response from server",
      tone: "error",
    });
  });
});

test("an old server hides completion and blocks slash text", async () => {
  const { controller, frames } = fake({}, { features: new Set(), requests: new Set() });
  expect(await controller.completions("/st")).toEqual([]);
  expect(await controller.prepareComposerInput("/status")).toEqual({ kind: "receipt", text: "not available in this server version", tone: "error" });
  expect(frames).toEqual([]);
});

test("autocomplete filters and ranks slash and skill rows and exposes source badges", async () => {
  const { controller, frames } = fake({ slash_list: slashList });
  expect(await controller.completions("/st")).toEqual([
    { trigger: "/", name: "status", description: "show session status", sourceBadge: "builtin" },
    { trigger: "/", name: "story", description: "write a story", sourceBadge: "project" },
  ]);
  expect(await controller.completions("please use $re")).toEqual([
    { trigger: "$", name: "release", description: "prepare a release", sourceBadge: "project" },
    { trigger: "$", name: "review", description: "review this change", sourceBadge: "home" },
  ]);
  expect(await controller.completions("/review")).toEqual([
    { trigger: "/", name: "review", description: "review this change", sourceBadge: "home" },
  ]);
  expect(frames).toEqual([{ method: "slash_list", params: { session_id: "session-1" } }]);
});

test("slash autocomplete only applies at the start of the composer", async () => {
  const { controller } = fake({ slash_list: slashList });
  // Zeta src/zeta/tui/completion.py:42-48 requires text_before_cursor to start with "/".
  expect(await controller.completions("explain /st")).toEqual([]);
  expect(await controller.completions("first line\n/st")).toEqual([]);
  expect(await controller.completions(" /st")).toEqual([]);
});

test("refreshCatalog replaces the cached server catalog", async () => {
  let result: unknown = slashList;
  const request: CommandRequest = async () => result;
  const controller = createCommandController("session-1", request, modern);
  expect(await controller.completions("/st")).toHaveLength(2);
  result = { commands: [], notices: [] };
  await controller.refreshCatalog();
  expect(await controller.completions("/st")).toEqual([]);
});
