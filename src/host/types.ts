export const ALLOWED_MEDIA_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
  "text/plain", "text/markdown", "text/csv", "application/json", "application/pdf", "text/html",
]);
export const ITEM_LIMIT = 25 * 1024 * 1024;
export const SESSION_LIMIT = 100 * 1024 * 1024;

export type Artifact = {
  artifact_id: string;
  session_id: string;
  version: number;
  media_type: string;
  size: number;
  title: string | null;
  filename: string | null;
  created_at: string;
  anchor_tool_call_id: string | null;
};
export type HostCommand = { name: "gamma"; executable: string; summary: string; environment: { GAMMA_API_URL: string; GAMMA_API_TOKEN: string } };
