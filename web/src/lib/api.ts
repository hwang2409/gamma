/** REST client. Every call carries the access token the backend printed. */

import type {
  CreateSessionBody,
  OptionsResponse,
  SessionView,
  ZetaSessionSummary,
} from "./protocol";

const TOKEN_HEADER = "X-Gamma-Token";
const TOKEN_KEY = "gamma.token";

/**
 * The token for this tab: one the user pasted (kept in sessionStorage), else
 * the one the dev server was started with (`make dev` sets VITE_GAMMA_TOKEN).
 */
export function readToken(): string {
  const stored = window.sessionStorage.getItem(TOKEN_KEY);
  if (stored) {
    return stored;
  }
  return devToken();
}

/** The token baked in by the dev server, or "" outside development. */
export function devToken(): string {
  const fromEnv = import.meta.env.VITE_GAMMA_TOKEN;
  return typeof fromEnv === "string" ? fromEnv : "";
}

export function writeToken(token: string): void {
  window.sessionStorage.setItem(TOKEN_KEY, token);
}

/** Forget a pasted token, for example after the backend rejected it. */
export function clearToken(): void {
  window.sessionStorage.removeItem(TOKEN_KEY);
}

export function isAuthError(cause: unknown): boolean {
  return cause instanceof ApiError && (cause.status === 401 || cause.status === 403);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      [TOKEN_HEADER]: readToken(),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new ApiError(response.status, await errorDetail(response));
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") {
      return body.detail;
    }
    return JSON.stringify(body.detail ?? body);
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

export const api = {
  options: () => request<OptionsResponse>("/api/options"),
  zetaSessions: (provider: string) =>
    request<{ sessions: ZetaSessionSummary[] }>(
      `/api/zeta-sessions?provider=${encodeURIComponent(provider)}`,
    ),
  listSessions: () => request<{ sessions: SessionView[] }>("/api/sessions"),
  createSession: (body: CreateSessionBody) =>
    request<SessionView>("/api/sessions", { method: "POST", body: JSON.stringify(body) }),
  session: (id: string) => request<SessionView>(`/api/sessions/${encodeURIComponent(id)}`),
  closeSession: (id: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
