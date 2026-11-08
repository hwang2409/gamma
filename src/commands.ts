import {
  listSlashCommands,
  runSlashCommand,
  type CommandClient,
  type ParsedSlashRunResult,
  type SlashCommandInfo,
} from "@fulcrum/zeta";

export type ComposerAction =
  | { kind: "send"; text: string }
  | { kind: "send-input"; inputId: string; displayText: string; command: string }
  | { kind: "receipt"; text: string; tone: "quiet" | "error"; retain?: boolean; command?: string }
  | { kind: "client-action"; name: ClientActionName; args: string };

export type ClientActionName =
  | "new_session"
  | "rename_session"
  | "approve"
  | "always"
  | "deny"
  | "theme"
  | "branch_view"
  | "paste"
  | "keys"
  | "restart"
  | "permissions";

/** Client actions that run in gamma alone, so a fresh draft with no zeta session can run them too. */
export type LocalActionName = Extract<ClientActionName, "new_session" | "theme" | "paste" | "keys" | "restart">;
const LOCAL_ACTIONS: ReadonlySet<ClientActionName> = new Set<LocalActionName>(["new_session", "theme", "paste", "keys", "restart"]);
export const isLocalAction = (name: ClientActionName): name is LocalActionName => LOCAL_ACTIONS.has(name);

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
  /** True while this run's turn is active: the same test as the "waits until the turn ends" receipt. */
  turnActive?(): boolean;
};

// Zeta ee6a82d6 server/slash_commands.py:516-536 and 586-606: skills and prompt macros become model input, which a
// running turn always refuses. Builtins stay offered because their busy rule is zeta policy, which gamma does not copy;
// six of them are still refused for any arguments while busy (zeta 1221f676 core/slash.py:1039-1148: plan, implement,
// project-instructions, init, compact, decisions). Hiding those waits for a busy-eligibility field in zeta's slash_list.
const REFUSED_WHILE_TURN_RUNS = new Set(["skill", "macro-prompt"]);

const CLIENT_ACTIONS: Readonly<Partial<Record<string, ClientActionName>>> = {
  new: "new_session",
  name: "rename_session",
  approve: "approve",
  always: "always",
  deny: "deny",
  theme: "theme",
  tree: "branch_view",
  paste: "paste",
  keys: "keys",
  restart: "restart",
  permissions: "permissions",
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

  let loading: Promise<void> | undefined;
  /** One catalog request at a time: an attach asks from both the mount effect and the pending token, and they share it. */
  function refreshCatalog(): Promise<void> {
    if (!capabilities.requests.has("slash_list")) {
      catalog = [];
      return Promise.resolve();
    }
    return loading ??= listSlashCommands(client, sessionId).then(
      (result) => { catalog = result.commands; },
    ).finally(() => { loading = undefined; });
  }

  async function completions(valueBeforeCursor: string): Promise<CompletionRow[]> {
    const token = findCommandCompletionToken(valueBeforeCursor);
    if (!token || !capabilities.requests.has("slash_list")) return [];
    if (catalog === undefined) await refreshCatalog();
    const prefix = token.prefix.toLowerCase();
    const busy = token.trigger === "/" && capabilities.turnActive?.() === true;
    return (catalog ?? [])
      .filter((entry) => entry.unavailable === null && (token.trigger === "/" || entry.kind === "skill") && !(busy && REFUSED_WHILE_TURN_RUNS.has(entry.kind)) && entry.name.toLowerCase().startsWith(prefix))
      .sort((a, b) => Number(b.name.toLowerCase() === prefix) - Number(a.name.toLowerCase() === prefix) || a.name.localeCompare(b.name))
      .map((entry) => ({ trigger: token.trigger, name: entry.name, description: entry.description, sourceBadge: entry.source }));
  }

  async function prepareComposerInput(text: string): Promise<ComposerAction> {
    if (!isSlashCommandText(text)) return directSend(text);
    if (!capabilities.requests.has("slash_run")) return unavailableReceipt();
    const normalized = text.trimStart();
    return slashAction(await runSlashCommand(client, sessionId, normalized), normalized);
  }

  function slashAction(result: ParsedSlashRunResult, text: string): ComposerAction {
    const command = commandName(text);
    switch (result.kind) {
      case "output":
        return { kind: "receipt", text: result.text, tone: "quiet", command };
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
          ? { kind: "send-input", inputId: result.input_id, displayText: result.display_text, command }
          : unavailableReceipt();
      default:
        return mapUnavailableSlashResult(result) ?? invalidResponseReceipt();
    }
  }

  return { prepareComposerInput, completions, refreshCatalog };
}

/** True when text is a command for slash preparation: a first-token `/` that is not the `//` literal escape. */
export function isSlashCommandText(text: string): boolean {
  return !text.startsWith("//") && text.trimStart().startsWith("/");
}

function directSend(text: string): ComposerAction {
  // Zeta tests/test_slash.py:1126-1133: // sends one literal leading slash.
  return { kind: "send", text: text.startsWith("//") ? text.slice(1) : text };
}

export function createUnavailableCommandController(message = "not available in this server version", detached = false): CommandController {
  return {
    async prepareComposerInput(text) {
      if (detached && /^\/permissions(?:\s|$)/.test(text.trim())) return { kind: "receipt", text: "open this run before changing permissions", tone: "error", retain: true };
      const local = localCommand(text);
      if (local) return { kind: "client-action", name: local, args: commandArgs(text.trimStart()) };
      return isSlashCommandText(text) ? { kind: "receipt", text: message, tone: "error", retain: true } : directSend(text);
    },
    async completions() { return []; },
    async refreshCatalog() {},
  };
}

/** gamma's own action for slash text, if it names one: it needs no zeta session and no connection. */
function localCommand(text: string): LocalActionName | undefined {
  const name = isSlashCommandText(text) ? CLIENT_ACTIONS[commandName(text.trimStart())] : undefined;
  return name && isLocalAction(name) ? name : undefined;
}
export const isLocalCommandText = (text: string) => localCommand(text) !== undefined;

function commandLine(text: string): string {
  return text.split("\n", 1)[0].slice(1).trimStart();
}

function commandName(text: string): string {
  return commandLine(text).split(/\s/, 1)[0].toLowerCase();
}

function commandArgs(text: string): string {
  const line = commandLine(text);
  const separator = line.search(/\s/);
  return separator < 0 ? "" : line.slice(separator).trimStart();
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
