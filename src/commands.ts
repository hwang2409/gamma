export type ComposerAction =
  | { kind: "send"; text: string }
  | { kind: "send-input"; inputId: string; displayText: string }
  | { kind: "receipt"; text: string; tone: "quiet" | "error" }
  | { kind: "client-action"; name: ClientActionName; args: string };

export type ClientActionName =
  | "new_session"
  | "rename_session"
  | "approve"
  | "always"
  | "deny"
  | "theme"
  | "branch_view"
  | "model"
  | "vim"
  | "paste"
  | "accounts";

export type CompletionRow = {
  trigger: "/" | "$";
  name: string;
  description: string;
  sourceBadge: string;
};

export type CommandController = {
  prepareComposerInput(text: string): Promise<ComposerAction>;
  completions(valueBeforeCursor: string): Promise<CompletionRow[]>;
  refreshCatalog(): Promise<void>;
};

export type CommandRequest = (
  method: "slash_list" | "slash_run" | "input_prepare",
  params: Record<string, unknown>,
) => Promise<unknown>;

export type CommandCapabilities = {
  features: ReadonlySet<string>;
  requests: ReadonlySet<string>;
};

// Temporary local wire types. These mirror Zeta docs/serve-protocol.md:1304-1328
// and gamma-tui-parity.md "generic input preparation"; replace with @fulcrum/zeta exports after f1/z1 land.
type SlashCommand = {
  name: string;
  description: string;
  kind: "builtin" | "macro-prompt" | "macro-exec" | "skill" | "mcp-prompt";
  source: "builtin" | "home" | "project" | `mcp:${string}`;
  client_only: boolean;
  unavailable: string | null;
};
type SlashListResult = { commands: SlashCommand[]; notices: string[] };
type SlashRunResult =
  | { kind: "output"; text: string }
  | { kind: "model_input"; input_id?: string; display_text?: string; text?: string }
  | { kind: "client_only"; name: string }
  | { kind: "unknown"; name: string }
  | { kind: "error"; text: string };
type InputPrepareResult =
  | { kind: "direct" }
  | { kind: "model_input"; input_id: string; display_text: string }
  | { kind: "error"; text: string };

const CLIENT_ACTIONS: Readonly<Record<string, ClientActionName>> = {
  new: "new_session",
  name: "rename_session",
  approve: "approve",
  always: "always",
  deny: "deny",
  theme: "theme",
  tree: "branch_view",
  model: "model",
  vim: "vim",
  paste: "paste",
  accounts: "accounts",
};

const POSSIBLE_DOLLAR_SKILL = /(?:^|\s)\$[A-Za-z0-9][A-Za-z0-9_-]*/;
const COMPLETION = /(?:^|\s)([/\$])([A-Za-z0-9_-]*)$/;

export function createCommandController(
  sessionId: string,
  request: CommandRequest,
  capabilities: CommandCapabilities,
): CommandController {
  let catalog: SlashCommand[] | undefined;

  async function refreshCatalog(): Promise<void> {
    if (!capabilities.requests.has("slash_list")) {
      catalog = [];
      return;
    }
    const result = await request("slash_list", { session_id: sessionId }) as SlashListResult;
    catalog = result.commands;
  }

  async function completions(valueBeforeCursor: string): Promise<CompletionRow[]> {
    const match = COMPLETION.exec(valueBeforeCursor);
    if (!match || !capabilities.requests.has("slash_list")) return [];
    if (catalog === undefined) await refreshCatalog();
    const trigger = match[1] as "/" | "$";
    const prefix = match[2].toLowerCase();
    return (catalog ?? [])
      .filter((entry) => (trigger === "/" || entry.kind === "skill") && entry.name.toLowerCase().startsWith(prefix))
      .sort((a, b) => Number(b.name.toLowerCase() === prefix) - Number(a.name.toLowerCase() === prefix) || a.name.localeCompare(b.name))
      .map((entry) => ({ trigger, name: entry.name, description: entry.description, sourceBadge: entry.source }));
  }

  async function prepareComposerInput(text: string): Promise<ComposerAction> {
    // Zeta tests/test_slash.py:1126-1133: // sends one literal leading slash.
    if (text.startsWith("//")) return { kind: "send", text: text.slice(1) };

    const normalized = text.trimStart();
    if (normalized.startsWith("/")) {
      if (!capabilities.requests.has("slash_run")) return unavailableReceipt();
      const result = await request("slash_run", { session_id: sessionId, text: normalized }) as SlashRunResult;
      return slashAction(result, normalized);
    }

    if (capabilities.features.has("input_prepare") && POSSIBLE_DOLLAR_SKILL.test(text)) {
      const result = await request("input_prepare", { session_id: sessionId, text }) as InputPrepareResult;
      if (result.kind === "direct") return { kind: "send", text };
      if (result.kind === "error") return { kind: "receipt", text: result.text, tone: "error" };
      if (!capabilities.features.has("model_input_ids")) return unavailableReceipt();
      return { kind: "send-input", inputId: result.input_id, displayText: result.display_text };
    }

    return { kind: "send", text };
  }

  function slashAction(result: SlashRunResult, text: string): ComposerAction {
    switch (result.kind) {
      case "output":
        return { kind: "receipt", text: result.text, tone: "quiet" };
      case "error":
        return { kind: "receipt", text: result.text, tone: "error" };
      case "unknown":
        return { kind: "receipt", text: `unknown command: /${result.name}`, tone: "error" };
      case "client_only": {
        const name = CLIENT_ACTIONS[result.name];
        return name ? { kind: "client-action", name, args: commandArgs(text) } : unavailableReceipt();
      }
      case "model_input":
        if (!capabilities.features.has("model_input_ids") || result.input_id === undefined || result.display_text === undefined)
          return unavailableReceipt();
        return { kind: "send-input", inputId: result.input_id, displayText: result.display_text };
    }
  }

  return { prepareComposerInput, completions, refreshCatalog };
}

function commandArgs(text: string): string {
  const commandLine = text.split("\n", 1)[0].slice(1).trimStart();
  const separator = commandLine.search(/\s/);
  return separator < 0 ? "" : commandLine.slice(separator).trimStart();
}

function unavailableReceipt(): ComposerAction {
  return { kind: "receipt", text: "not available in this server version", tone: "error" };
}
