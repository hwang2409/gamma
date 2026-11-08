// Compatibility matrix for servers that lack parity features (gate-compat). The invariant: an unsupported action is
// hidden or answered by a local retained receipt, and a slash-led draft never reaches the model as plain text.
import { describe, expect, test } from "bun:test";
import { createCommandController, createUnavailableCommandController, type CommandCapabilities, type CommandRequest } from "../src/commands";

type Frame = { method: string; params: Record<string, unknown> };

// Zeta 8389c6e docs/serve-protocol.md:1405-1418: slash_list rows carry name, description, kind, source,
// client_only, unavailable. Extra keys model additive fields such as zeta #1066's runs_while_busy.
const row = (name: string, kind = "builtin", extra: Record<string, unknown> = {}) =>
  ({ name, description: `${name} command`, kind, source: kind === "skill" ? "home" : "builtin", client_only: false, unavailable: null, ...extra });

const servers: Record<string, CommandCapabilities> = {
  // Zeta 8389c6e docs/serve-protocol.md:1501-1504: a server without slash methods returns -32601 for both.
  "no slash methods": { features: new Set(["model_input_ids", "session_grants"]), requests: new Set(["status"]) },
  // docs/serve-protocol.md:1493-1499: without model_input_ids, model input has no opaque id.
  "no model_input_ids": { features: new Set(["session_grants"]), requests: new Set(["slash_list", "slash_run"]) },
  "nothing negotiated (protocol 1.0)": { features: new Set(), requests: new Set(["list_sessions", "new_session", "resume", "send", "steer", "approve", "deny", "abort", "status"]) },
};

function controllerFor(capabilities: CommandCapabilities, replies: Record<string, unknown> = {}) {
  const frames: Frame[] = [];
  const request: CommandRequest = async (method, params) => {
    frames.push({ method, params });
    if (!capabilities.requests.has(method)) throw Object.assign(new Error("method not found"), { code: -32601 });
    return replies[method];
  };
  return { controller: createCommandController("session-1", request, capabilities), frames };
}

describe("servers without parity features", () => {
  for (const [name, capabilities] of Object.entries(servers)) {
    test(`${name}: slash drafts stay local and retained`, async () => {
      const { controller, frames } = controllerFor(capabilities, { slash_list: { commands: [row("status")], notices: [] } });
      for (const draft of ["/status", "/review this change", "  /plan write it", "/mcp status"]) {
        const action = await controller.prepareComposerInput(draft);
        expect(action.kind).toBe("receipt");
        expect(action).toMatchObject({ tone: "error", retain: true });
      }
      expect(frames.filter((frame) => frame.method === "slash_run")).toEqual([]);
      if (!capabilities.requests.has("slash_list")) expect(await controller.completions("/st")).toEqual([]);
      expect(frames.filter((frame) => !capabilities.requests.has(frame.method))).toEqual([]);
    });

    test(`${name}: plain text and the // escape are the only direct sends`, async () => {
      const { controller } = controllerFor(capabilities);
      expect(await controller.prepareComposerInput("hello there")).toEqual({ kind: "send", text: "hello there" });
      expect(await controller.prepareComposerInput("//status is literal")).toEqual({ kind: "send", text: "/status is literal" });
    });
  }
});

describe("additive and legacy result shapes", () => {
  const full: CommandCapabilities = { features: new Set(["model_input_ids"]), requests: new Set(["slash_list", "slash_run"]) };

  test("unknown slash_list fields and an unknown future runs_while_busy value keep every row", async () => {
    const { controller } = controllerFor(full, {
      slash_list: {
        commands: [
          row("status", "builtin", { runs_while_busy: "sometimes-in-the-future", future_badge: { tone: "new" } }),
          row("stash", "builtin", { runs_while_busy: true }),
          row("summarize", "skill", { runs_while_busy: 7, unknown: null }),
        ],
        notices: ["a notice"],
        next_cursor: "future-paging",
      },
    });
    expect((await controller.completions("/s")).map((entry) => entry.name)).toEqual(["stash", "status", "summarize"]);
    expect((await controller.completions("use $su")).map((entry) => entry.name)).toEqual(["summarize"]);
  });

  test("additive slash_run fields keep the normal output receipt", async () => {
    const { controller } = controllerFor(full, { slash_run: { kind: "output", text: "fake status", format: "markdown", future: [1] } });
    expect(await controller.prepareComposerInput("/status")).toEqual({ kind: "receipt", text: "fake status", tone: "quiet", command: "status" });
  });

  // Fulcrum 69eb643a removed the legacy `text` alias (pre-#835 mcp output); gamma #19 removed its own fallback.
  const malformed: Array<[string, unknown]> = [
    ["legacy kind text", { kind: "text", text: "mcp: 0 mounted" }],
    ["unknown future kind", { kind: "future_panel", text: "secret prompt text" }],
    ["model_input without an id", { kind: "model_input", display_text: "/review", text: "expanded hidden prompt", origin: "skill" }],
    ["no kind", { text: "loose text" }],
    ["not an object", "loose text"],
  ];
  for (const [name, reply] of malformed) test(`${name} is a local retained error receipt, never chat text`, async () => {
    const { controller } = controllerFor(full, { slash_run: reply });
    const action = await controller.prepareComposerInput("/mcp status");
    expect(action).toMatchObject({ kind: "receipt", tone: "error", retain: true });
    expect(JSON.stringify(action)).not.toMatch(/mounted|secret|hidden|loose/);
  });
});

describe("gamma's local actions need no zeta feature", () => {
  // g5k: /keys and /theme run in gamma alone (src/commands.ts LOCAL_ACTIONS). Zeta 8389c6e slash_commands.py marks them client_only.
  const capabilitySets: Record<string, CommandCapabilities> = {
    "full": { features: new Set(["model_input_ids", "session_grants"]), requests: new Set(["slash_list", "slash_run"]) },
    ...servers,
  };
  for (const [name, capabilities] of Object.entries(capabilitySets)) test(`${name}: /keys and /theme open locally`, async () => {
    const { controller } = controllerFor(capabilities, { slash_run: { kind: "client_only", name: "keys" } });
    expect(await controller.prepareComposerInput("/keys")).toEqual({ kind: "client-action", name: "keys", args: "" });
    const theme = controllerFor(capabilities, { slash_run: { kind: "client_only", name: "theme" } });
    expect(await theme.controller.prepareComposerInput("/theme dark")).toEqual({ kind: "client-action", name: "theme", args: "dark" });
  });
});

test("no client at all (disconnected): /keys and /theme still run locally; zeta commands keep their draft", async () => {
  // src/app.tsx builds this controller with no arguments while there is no zeta client.
  const offline = createUnavailableCommandController();
  expect(await offline.prepareComposerInput("/keys")).toEqual({ kind: "client-action", name: "keys", args: "" });
  expect(await offline.prepareComposerInput("/theme dracula")).toEqual({ kind: "client-action", name: "theme", args: "dracula" });
  for (const draft of ["/status", "/review this", "/permissions", "/approve"]) expect(await offline.prepareComposerInput(draft)).toEqual({ kind: "receipt", text: "not available in this server version", tone: "error", retain: true });
  expect(await offline.prepareComposerInput("hello")).toEqual({ kind: "send", text: "hello" });
});
