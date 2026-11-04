export type ApprovalMode = "ask" | "allow" | "deny";
export type SessionSettings = { model?: string; approval_mode?: ApprovalMode };
export type ModelCatalog = { models?: Array<string | { id?: string; name?: string }> };

export function settingModel(value: unknown): SessionSettings {
  if (!value || typeof value !== "object") return {};
  const item = value as Record<string, unknown>;
  return {
    ...(typeof item.model === "string" ? { model: item.model } : {}),
    ...(item.approval_mode === "ask" || item.approval_mode === "allow" || item.approval_mode === "deny" ? { approval_mode: item.approval_mode } : {}),
  };
}

export function catalogModels(value: unknown): string[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as ModelCatalog).models)) return [];
  return (value as ModelCatalog).models!.flatMap((item) => typeof item === "string" ? [item] : item?.id ? [item.id] : []);
}

export function settingsRequest(current: SessionSettings, patch: Partial<SessionSettings>) {
  return { model: patch.model ?? current.model ?? "", approval_mode: patch.approval_mode ?? current.approval_mode ?? "ask" };
}
