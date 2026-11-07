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

/** zeta's model → provider map from `model_catalog`, so a new run can name both. */
export function catalogProviders(value: unknown): Record<string, string> {
  const providers = value && typeof value === "object" ? (value as { providers?: unknown }).providers : undefined;
  if (!providers || typeof providers !== "object") return {};
  return Object.fromEntries(Object.entries(providers).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
