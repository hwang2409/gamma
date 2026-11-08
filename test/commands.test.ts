import { describe, expect, test } from "bun:test";
import { createCommandController, createUnavailableCommandController, findCommandCompletionToken, mapUnavailableSlashResult, type CommandCapabilities, type CommandRequest } from "../src/commands";

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

describe("completion tokens", () => {
  test("slash is first-token only and dollar follows Zeta whitespace and backtick rules", () => {
    expect(findCommandCompletionToken("/sta")).toEqual({ trigger: "/", prefix: "sta", start: 0 });
    expect(findCommandCompletionToken("say /sta")).toBeUndefined();
    expect(findCommandCompletionToken("say $rev")).toEqual({ trigger: "$", prefix: "rev", start: 4 });
    expect(findCommandCompletionToken("`$rev")).toBeUndefined();
    expect(findCommandCompletionToken("```ts\n$rev")).toBeUndefined();
    expect(findCommandCompletionToken("! run $rev")).toEqual({ trigger: "$", prefix: "rev", start: 6 });
    expect(findCommandCompletionToken("say($rev")).toBeUndefined();
  });
});

describe("slash results", () => {
  const cases = [
    ["output", { kind: "output", text: "model: luna" }, { kind: "receipt", text: "model: luna", tone: "quiet", command: "review" }],
    ["error", { kind: "error", text: "status unavailable" }, { kind: "receipt", text: "status unavailable", tone: "error" }],
    ["unknown", { kind: "unknown", name: "wat" }, { kind: "receipt", text: "unknown command: /wat", tone: "error" }],
    ["model_input", { kind: "model_input", input_id: "opaque-1", display_text: "/review this" }, { kind: "send-input", inputId: "opaque-1", displayText: "/review this", command: "review" }],
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

  test("maps fulcrum unavailable slash results to the local receipt", () => {
    expect(mapUnavailableSlashResult({ kind: "unavailable", feature: "model_input_ids" })).toEqual({
      kind: "receipt",
      text: "not available in this server version",
      tone: "error",
      retain: true,
    });
  });

  test("an opaque model input id is returned once without expansion text", async () => {
    const { controller, frames } = fake({ slash_run: { kind: "model_input", input_id: "one-use", display_text: "/review secret", text: "hidden expansion" } });
    expect(await controller.prepareComposerInput("/review secret")).toEqual({ kind: "send-input", inputId: "one-use", displayText: "/review secret", command: "review" });
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
      retain: true,
    });
  });
});

test("client-only commands use only the explicit gamma mapping and keep arguments", async () => {
  const mappings = {
    new: "new_session", name: "rename_session", approve: "approve", always: "always", deny: "deny",
    theme: "theme", tree: "branch_view", paste: "paste", keys: "keys", restart: "restart", permissions: "permissions",
  } as const;
  for (const [command, action] of Object.entries(mappings)) {
    const { controller } = fake({ slash_run: { kind: "client_only", name: command } });
    expect(await controller.prepareComposerInput(`/${command} alpha beta`)).toEqual({ kind: "client-action", name: action, args: "alpha beta" });
  }
  for (const name of ["model", "vim", "accounts"]) {
    const { controller } = fake({ slash_run: { kind: "client_only", name } });
    expect(await controller.prepareComposerInput(`/${name}`)).toEqual({ kind: "receipt", text: `/${name} is not available in gamma yet`, tone: "error" });
  }

  const oldServer = fake({ slash_run: { kind: "client_only", name: "mcp" } }).controller;
  expect(await oldServer.prepareComposerInput("/mcp")).toEqual({ kind: "receipt", text: "/mcp is not available in gamma yet", tone: "error" });

  // zeta PR #835 head 886f5720 (unmerged): new servers return output for /mcp.
  const newServer = fake({ slash_run: { kind: "output", text: "mcp status" } }).controller;
  expect(await newServer.prepareComposerInput("/mcp")).toEqual({ kind: "receipt", text: "mcp status", tone: "quiet", command: "mcp" });
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

test("inline dollar skills stay direct text until g3z ships input_prepare", async () => {
  const { controller, frames } = fake({});
  expect(await controller.prepareComposerInput("please use $review now")).toEqual({ kind: "send", text: "please use $review now" });
  expect(frames).toEqual([]);
});

test("an old server hides completion and blocks slash text", async () => {
  const { controller, frames } = fake({}, { features: new Set(), requests: new Set() });
  expect(await controller.completions("/st")).toEqual([]);
  expect(await controller.prepareComposerInput("/status")).toEqual({ kind: "receipt", text: "not available in this server version", tone: "error", retain: true });
  expect(frames).toEqual([]);
});

test("the no-capability adapter leaves slash with no listbox rows", async () => {
  expect(await createUnavailableCommandController().completions("/", 1)).toEqual([]);
  expect(await createUnavailableCommandController("commands need an open run", true).prepareComposerInput("/permissions")).toEqual({ kind: "receipt", text: "open this run before changing permissions", tone: "error", retain: true });
});

test("a fresh draft runs gamma's own actions and refuses commands that need a zeta session", async () => {
  const fresh = createUnavailableCommandController("commands need an open run", true);
  const refusal = { kind: "receipt", text: "commands need an open run", tone: "error", retain: true };
  expect(await fresh.prepareComposerInput("/keys")).toEqual({ kind: "client-action", name: "keys", args: "" });
  expect(await fresh.prepareComposerInput("/theme dracula")).toEqual({ kind: "client-action", name: "theme", args: "dracula" });
  for (const text of ["/tree", "/name x", "/approve", "/status"]) expect(await fresh.prepareComposerInput(text)).toEqual(refusal);
  expect(await createUnavailableCommandController().prepareComposerInput("/keys")).toEqual({ kind: "receipt", text: "not available in this server version", tone: "error", retain: true });
});

test("an attach with a pending slash token sends one slash_list, shared by both askers", async () => {
  const { controller, frames } = fake({ slash_list: slashList });
  // composer.tsx: the new controller re-asks about the pending token and the mount effect refreshes the catalog.
  const [rows] = await Promise.all([controller.completions("/st"), controller.refreshCatalog()]);
  expect(rows.map((row) => row.name)).toEqual(["status", "story"]);
  expect(frames.filter((frame) => frame.method === "slash_list")).toHaveLength(1);
  await controller.refreshCatalog();
  expect(frames.filter((frame) => frame.method === "slash_list")).toHaveLength(2);
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

test("an active turn hides slash rows it always refuses but keeps builtins and inline skills", async () => {
  let active = true;
  const { controller } = fake({ slash_list: slashList }, { ...modern, turnActive: () => active });
  expect(await controller.completions("/r")).toEqual([]);
  expect((await controller.completions("/")).map((row) => row.name)).toEqual(["status"]);
  expect((await controller.completions("say $re")).map((row) => row.name)).toEqual(["release", "review"]);
  active = false;
  expect((await controller.completions("/r")).map((row) => row.name)).toEqual(["release", "review"]);
});

test("slash autocomplete hides unavailable commands", async () => {
  // zeta PR #835 head 886f5720 (unmerged): complete catalogs include unavailable TUI-only rows.
  const { controller } = fake({ slash_list: {
    commands: [
      { name: "restart", description: "restart", kind: "builtin", source: "builtin", client_only: true, unavailable: "requires_tui" },
      { name: "permissions", description: "permissions", kind: "builtin", source: "builtin", client_only: true, unavailable: "requires_tui" },
      { name: "status", description: "status", kind: "builtin", source: "builtin", client_only: false, unavailable: null },
    ],
    notices: [],
  } });
  expect(await controller.completions("/re")).toEqual([]);
  expect(await controller.completions("/pe")).toEqual([]);
  expect(await controller.completions("/st")).toEqual([
    { trigger: "/", name: "status", description: "status", sourceBadge: "builtin" },
  ]);
});

test("slash autocomplete only applies at the start of the composer", async () => {
  const { controller } = fake({ slash_list: slashList });
  // Zeta src/zeta/tui/completion.py:42-48 requires text_before_cursor to start with "/".
  expect(await controller.completions("explain /st")).toEqual([]);
  expect(await controller.completions("first line\n/st")).toEqual([]);
  expect(await controller.completions(" /st")).toEqual([]);
});

test("dollar completion follows zeta code-span and token boundaries", async () => {
  const { controller } = fake({ slash_list: slashList });
  for (const value of ["prose $re", "`code` $re", "```code``` $re", "!run $re"]) {
    expect(await controller.completions(value)).toHaveLength(2);
  }
  for (const value of ["`$re", "```\n$re", "a$re"]) {
    expect(await controller.completions(value)).toEqual([]);
  }
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
