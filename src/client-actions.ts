import { pendingApprovals, type ApprovalStore } from "./approvals";
import type { ClientActionName, LocalActionName } from "./commands";
import { keysReceipt } from "./keys";
import type { ThemeChoice } from "./theme";

export type ActionReceipt = { text: string; tone: "quiet" | "error"; retain?: boolean };
type Branch = { id: string; label?: string; seq?: number; current?: boolean };
type PermissionsAction = {
  readonly grants: readonly string[];
  open(): void;
  revoke(grant: string): Promise<{ removed: string[] } | null>;
  clear(): Promise<{ removed: string[] }>;
};

/** What gamma's own actions need; none of it involves a zeta session. */
export type LocalActionDependencies = {
  newRun(): void;
  themes: readonly ThemeChoice[];
  currentTheme(): ThemeChoice;
  setTheme(theme: ThemeChoice): void;
  openFilePicker(): void;
};

export type ClientActionDependencies = LocalActionDependencies & {
  sessionId: string;
  requests: ReadonlySet<string>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  refreshStatus(): Promise<unknown>;
  retrySession(sessionId: string): Promise<unknown>;
  currentName(): string | undefined;
  approvalStore: ApprovalStore;
  approvalDisabledReason?: string;
  decide(method: "approve" | "deny", requestId: string, always?: boolean): Promise<unknown>;
  markAlways(toolId: string): void;
  permissions?: PermissionsAction;
};

const quiet = (text: string): ActionReceipt => ({ text, tone: "quiet" });
const error = (text: string, retain = false): ActionReceipt => ({ text, tone: "error", ...(retain ? { retain: true } : {}) });

export function createLocalActions(deps: LocalActionDependencies): Record<LocalActionName, (args: string) => Promise<ActionReceipt | void>> {
  return {
    async new_session(args) {
      if (args) return error("new unchanged: /new does not accept arguments");
      deps.newRun();
    },
    async theme(args) {
      const available = deps.themes.join(", ");
      if (!args || args === "list") return quiet(`theme: ${deps.currentTheme()} · available: ${available}`);
      const theme = deps.themes.find((candidate) => candidate.toLowerCase() === args.toLowerCase());
      if (!theme) return error(`theme unchanged: unknown theme '${args}'; available: ${available}`);
      deps.setTheme(theme);
      return quiet(`theme: ${theme}`);
    },
    async paste(args) {
      if (args) return error("paste unavailable: /paste does not take arguments");
      deps.openFilePicker();
      return quiet("choose images to attach (paste and drop also work)");
    },
    async keys() { return quiet(keysReceipt()); },
    async restart() { return quiet("/restart restarts the terminal app; gamma reconnects on its own"); },
  };
}

export function createClientActions(deps: ClientActionDependencies): Record<ClientActionName, (args: string) => Promise<ActionReceipt | void>> {
  const requireRequest = (method: string, message: string) => {
    if (!deps.requests.has(method)) throw new Error(message);
  };
  const approval = async (method: "approve" | "deny", args: string, always = false) => {
    if (deps.approvalDisabledReason) return error(deps.approvalDisabledReason, true);
    const items = pendingApprovals(deps.approvalStore);
    const item = args ? items.find((candidate) => candidate.request.request_id === args) : items[0];
    if (!item) return error("approval · no matching request");
    const id = item.request.request_id;
    const result = await deps.decide(method, id, always) as { grant?: string; tool_name?: string } | undefined;
    if (always) {
      if (item.request.tool_call?.id) deps.markAlways(item.request.tool_call.id);
      return quiet(`approval · always allowed ${result?.grant ?? result?.tool_name ?? item.request.tool_call?.name ?? "tool"} for this session · request ${id}`);
    }
    return quiet(`approval · ${method === "approve" ? "approved" : "denied"} ${id}`);
  };
  const tree = async (args: string) => {
    requireRequest("session_tree", "branch history needs a newer zeta server");
    const raw = await deps.request("session_tree", { session_id: deps.sessionId }) as { branches?: unknown };
    const branches = Array.isArray(raw?.branches) ? raw.branches.filter((branch): branch is Branch => Boolean(branch) && typeof branch === "object" && typeof (branch as Branch).id === "string") : [];
    if (!args) return quiet(branches.length ? branches.map((branch, index) => `${branch.current ? "*" : " "} ${index + 1}. ${branch.label ?? `head ${branch.seq ?? branch.id}`}`).join("\n") : "no branches");
    const index = Number(args);
    if (!Number.isInteger(index) || index < 1 || index > branches.length) return error(`branch unchanged: choose 1-${branches.length || 0}`);
    requireRequest("switch_branch", "branch switching needs a newer zeta server");
    const branch = branches[index - 1]!;
    await deps.request("switch_branch", { session_id: deps.sessionId, head_id: branch.id });
    await deps.retrySession(deps.sessionId);
    return quiet(`switched to branch ${index} (head ${branch.seq ?? branch.id})`);
  };
  return {
    ...createLocalActions(deps),
    async rename_session(args) {
      if (!args) return quiet(`session name: ${deps.currentName() || "(unnamed)"}`);
      requireRequest("rename_session", "session naming needs a newer zeta server");
      try {
        await deps.request("rename_session", { session_id: deps.sessionId, name: args });
        await deps.refreshStatus();
        return quiet(`session name: ${args}`);
      } catch (cause) {
        return error(`session name unchanged: ${cause instanceof Error ? cause.message : String(cause)}`, true);
      }
    },
    approve: (args) => approval("approve", args),
    always: (args) => approval("approve", args, true),
    deny: (args) => approval("deny", args),
    branch_view: tree,
    async permissions(args) {
      const permissions = deps.permissions;
      if (!permissions) return error("permissions need a newer zeta server", true);
      if (!args) { permissions.open(); return; }
      if (args === "clear") {
        const { removed } = await permissions.clear();
        return quiet(removed.length ? `permissions · session grants cleared: ${removed.join(", ")}` : "permissions · no session grants to clear");
      }
      if (args.startsWith("revoke ")) {
        const grant = args.slice("revoke ".length);
        if (!grant || !permissions.grants.includes(grant)) return error(`permissions · no session grant matches '${grant}'; use /permissions to list exact grants`);
        const result = await permissions.revoke(grant);
        return result ? quiet(`permissions · session grant revoked: ${grant}`) : quiet("that grant was already removed");
      }
      return error("usage: /permissions | /permissions revoke <exact grant> | /permissions clear", true);
    },
  };
}
