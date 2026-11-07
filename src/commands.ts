import {
  listSlashCommands,
  runSlashCommand,
  type CommandClient,
  type ParsedSlashRunResult,
  type SlashCommandInfo,
} from "@fulcrum/zeta";

export type ComposerAction =
  | { kind: "send"; text: string }
  | { kind: "send-input"; inputId: string; displayText: string }
  | { kind: "receipt"; text: string; tone: "quiet" | "error"; retain?: boolean }
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

export type CompletionToken = { trigger: "/" | "$"; prefix: string; start: number };

export type CommandController = {
  prepareComposerInput(text: string): Promise<ComposerAction>;
  completions(valueBeforeCursor: string): Promise<CompletionRow[]>;
  refreshCatalog(): Promise<void>;
};

export type CommandRequest = (
  method: "slash_list" | "slash_run",
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
const SLASH_COMPLETION = /^\/([A-Za-z0-9_-]*)$/;
const DOLLAR_COMPLETION = /(?<!\S)\$([A-Za-z0-9_-]*)$/;

// Zeta dcc4ce9 src/zeta/skills/invocation.py:46-80 owns these token and backtick rules.
export function findCommandCompletionToken(valueBeforeCursor: string): CompletionToken | undefined {
  const slash = SLASH_COMPLETION.exec(valueBeforeCursor);
  if (slash) return { trigger: "/", prefix: slash[1], start: 0 };
  const dollar = DOLLAR_COMPLETION.exec(valueBeforeCursor);
  if (!dollar || inBacktickRange(dollar.index, valueBeforeCursor)) return;
  return { trigger: "$", prefix: dollar[1], start: dollar.index };
}

function inBacktickRange(position: number, value: string): boolean {
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("`", cursor);
    if (start < 0) return false;
    let runEnd = start + 1;
    while (value[runEnd] === "`") runEnd++;
    const marker = value.slice(start, runEnd);
    const close = value.indexOf(marker, runEnd);
    const end = close < 0 ? value.length : close + marker.length;
    if (start <= position && position < end) return true;
    cursor = end;
  }
  return false;
}

export function createCommandController(
  sessionId: string,
  request: CommandRequest,
  capabilities: CommandCapabilities,
): CommandController {
  let catalog: SlashCommandInfo[] | undefined;
  const client = {
    request: (method: string, params?: Record<string, unknown>) => request(method as "slash_list" | "slash_run", params ?? {}),
    features: [...capabilities.features],
  } satisfies CommandClient;

  async function refreshCatalog(): Promise<void> {
    if (!capabilities.requests.has("slash_list")) {
      catalog = [];
      return;
    }
    catalog = (await listSlashCommands(client, sessionId)).commands;
  }

  async function completions(valueBeforeCursor: string): Promise<CompletionRow[]> {
    const token = findCommandCompletionToken(valueBeforeCursor);
    if (!token || !capabilities.requests.has("slash_list")) return [];
    if (catalog === undefined) await refreshCatalog();
    const prefix = token.prefix.toLowerCase();
    return (catalog ?? [])
      .filter((entry) => entry.unavailable === null && (token.trigger === "/" || entry.kind === "skill") && entry.name.toLowerCase().startsWith(prefix))
      .sort((a, b) => Number(b.name.toLowerCase() === prefix) - Number(a.name.toLowerCase() === prefix) || a.name.localeCompare(b.name))
      .map((entry) => ({ trigger: token.trigger, name: entry.name, description: entry.description, sourceBadge: entry.source }));
  }

  async function prepareComposerInput(text: string): Promise<ComposerAction> {
    // Zeta tests/test_slash.py:1126-1133: // sends one literal leading slash.
    if (text.startsWith("//")) return { kind: "send", text: text.slice(1) };
    const normalized = text.trimStart();
    if (!normalized.startsWith("/")) return { kind: "send", text };
    if (!capabilities.requests.has("slash_run")) return unavailableReceipt();
    return slashAction(await runSlashCommand(client, sessionId, normalized), normalized);
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
        return typeof result.input_id === "string"
          ? { kind: "send-input", inputId: result.input_id, displayText: result.display_text }
          : unavailableReceipt();
      default:
        return mapUnavailableSlashResult(result) ?? invalidResponseReceipt();
    }
  }

  return { prepareComposerInput, completions, refreshCatalog };
}

export function createUnavailableCommandController(): CommandController {
  return {
    async prepareComposerInput(text) {
      if (text.startsWith("//")) return { kind: "send", text: text.slice(1) };
      return text.trimStart().startsWith("/") ? unavailableReceipt() : { kind: "send", text };
    },
    async completions() { return []; },
    async refreshCatalog() {},
  };
}

function commandArgs(text: string): string {
  const commandLine = text.split("\n", 1)[0].slice(1).trimStart();
  const separator = commandLine.search(/\s/);
  return separator < 0 ? "" : commandLine.slice(separator).trimStart();
}

export function mapUnavailableSlashResult(result: { kind?: unknown }): ComposerAction | undefined {
  return result.kind === "unavailable" ? unavailableReceipt() : undefined;
}

function unavailableReceipt(): ComposerAction {
  return { kind: "receipt", text: "not available in this server version", tone: "error", retain: true };
}

function unavailableCommandReceipt(name: string): ComposerAction {
  return { kind: "receipt", text: `/${name} is not available in gamma yet`, tone: "error" };
}

function invalidResponseReceipt(): ComposerAction {
  return { kind: "receipt", text: "invalid response from server", tone: "error", retain: true };
}
