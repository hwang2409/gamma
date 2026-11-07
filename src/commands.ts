import {
  listSlashCommands,
  parseModelInput,
  runSlashCommand,
  type CommandClient,
  type ParsedSlashRunResult,
  type SlashCommandInfo,
} from "@fulcrum/zeta";

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
const SLASH_COMPLETION = /^\/([A-Za-z0-9_-]*)$/;
const DOLLAR_COMPLETION = /(?:^|\s)\$([A-Za-z0-9_-]*)$/;

export function createCommandController(
  sessionId: string,
  request: CommandRequest,
  capabilities: CommandCapabilities,
): CommandController {
  let catalog: SlashCommandInfo[] | undefined;
  const client: CommandClient = {
    request: (method, params) => request(method as "slash_list" | "slash_run" | "input_prepare", params ?? {}),
  };

  async function refreshCatalog(): Promise<void> {
    if (!capabilities.requests.has("slash_list")) {
      catalog = [];
      return;
    }
    catalog = (await listSlashCommands(client, sessionId)).commands;
  }

  async function completions(valueBeforeCursor: string): Promise<CompletionRow[]> {
    const slash = SLASH_COMPLETION.exec(valueBeforeCursor);
    const dollar = DOLLAR_COMPLETION.exec(valueBeforeCursor);
    if ((!slash && !dollar) || !capabilities.requests.has("slash_list")) return [];
    if (catalog === undefined) await refreshCatalog();
    const trigger = slash ? "/" : "$";
    const prefix = (slash?.[1] ?? dollar?.[1] ?? "").toLowerCase();
    return (catalog ?? [])
      .filter((entry) => entry.unavailable === null && (trigger === "/" || entry.kind === "skill") && entry.name.toLowerCase().startsWith(prefix))
      .sort((a, b) => Number(b.name.toLowerCase() === prefix) - Number(a.name.toLowerCase() === prefix) || a.name.localeCompare(b.name))
      .map((entry) => ({ trigger, name: entry.name, description: entry.description, sourceBadge: entry.source }));
  }

  async function prepareComposerInput(text: string): Promise<ComposerAction> {
    // Zeta tests/test_slash.py:1126-1133: // sends one literal leading slash.
    if (text.startsWith("//")) return { kind: "send", text: text.slice(1) };

    const normalized = text.trimStart();
    if (normalized.startsWith("/")) {
      if (!capabilities.requests.has("slash_run")) return unavailableReceipt();
      return slashAction(await runSlashCommand(client, sessionId, normalized), normalized);
    }

    if (capabilities.features.has("input_prepare") && POSSIBLE_DOLLAR_SKILL.test(text)) {
      const result: unknown = await request("input_prepare", { session_id: sessionId, text });
      if (!isRecord(result) || typeof result.kind !== "string") return invalidResponseReceipt();
      switch (result.kind) {
        case "direct":
          return { kind: "send", text };
        case "error":
          return typeof result.text === "string" ? { kind: "receipt", text: result.text, tone: "error" } : invalidResponseReceipt();
        case "model_input": {
          const modelInput = parseModelInput(result, { requireInputId: true });
          if (!modelInput) return invalidResponseReceipt();
          return capabilities.features.has("model_input_ids")
            ? { kind: "send-input", inputId: modelInput.input_id, displayText: modelInput.display_text }
            : unavailableReceipt();
        }
        default:
          return invalidResponseReceipt();
      }
    }

    return { kind: "send", text };
  }

  function slashAction(result: ParsedSlashRunResult, text: string): ComposerAction {
    switch (result.kind) {
      case "output":
        return { kind: "receipt", text: result.text, tone: "quiet" };
      case "error":
        return { kind: "receipt", text: result.text, tone: "error" };
      case "unknown":
        return { kind: "receipt", text: `unknown command: /${result.name}`, tone: "error" };
      case "client_only": {
        const name = CLIENT_ACTIONS[result.name];
        return name ? { kind: "client-action", name, args: commandArgs(text) } : unavailableCommandReceipt(result.name);
      }
      case "model_input":
        return capabilities.features.has("model_input_ids") && typeof result.input_id === "string"
          ? { kind: "send-input", inputId: result.input_id, displayText: result.display_text }
          : unavailableReceipt();
      default:
        return invalidResponseReceipt();
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

function unavailableCommandReceipt(name: string): ComposerAction {
  return { kind: "receipt", text: `/${name} is not available in gamma yet`, tone: "error" };
}

function invalidResponseReceipt(): ComposerAction {
  return { kind: "receipt", text: "invalid response from server", tone: "error" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
