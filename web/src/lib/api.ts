/** REST client. Every call carries the access token the backend printed. */

import type {
  CreateSessionBody,
  InboxMessage,
  InboxStatus,
  MemoryLogResponse,
  MemoryVersion,
  MemoryVersionDetail,
  OptionsResponse,
  PagedInbox,
  PagedMemoryLog,
  PagedProjects,
  ProjectDetailResponse,
  ProjectInboxResponse,
  ProjectListResponse,
  ProjectSessionsResponse,
  ProjectSummary,
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

/** True when the running Zeta does not offer the projects feature. */
export function isUnsupported(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 501;
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

/**
 * Walk a paged endpoint to its end, following `next_offset`.
 *
 * Zeta caps a page at 100 records, so a project list, memory history, or inbox
 * larger than that would otherwise show only its first page. `PAGE_CAP` bounds
 * the walk far above any real project; stopping on it (or on a server that
 * never advances) returns `complete: false` so the view can warn.
 */
const PAGE_CAP = 5000;

interface Page<T> {
  items: T[];
  nextOffset: number | null;
}

async function pageAll<T>(fetchPage: (offset: number) => Promise<Page<T>>): Promise<{
  items: T[];
  complete: boolean;
}> {
  const items: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await fetchPage(offset);
    items.push(...page.items);
    const next = page.nextOffset ?? null;
    if (next === null) {
      return { items, complete: true };
    }
    if (next <= offset || items.length >= PAGE_CAP) {
      return { items, complete: false };
    }
    offset = next;
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
  projects: async (): Promise<PagedProjects> => {
    const { items, complete } = await pageAll<ProjectSummary>(async (offset) => {
      const page = await request<ProjectListResponse>(`/api/projects?offset=${offset}`);
      return { items: page.projects, nextOffset: page.next_offset };
    });
    return { projects: items, complete };
  },
  project: (id: string) =>
    request<ProjectDetailResponse>(`/api/projects/${encodeURIComponent(id)}`),
  projectMemoryLog: async (id: string): Promise<PagedMemoryLog> => {
    const { items, complete } = await pageAll<MemoryVersion>(async (offset) => {
      const page = await request<MemoryLogResponse>(
        `/api/projects/${encodeURIComponent(id)}/memory/log?offset=${offset}`,
      );
      return { items: page.versions, nextOffset: page.next_offset };
    });
    return { versions: items, complete };
  },
  projectMemoryVersion: (id: string, versionId: string, file: string) =>
    request<MemoryVersionDetail>(
      `/api/projects/${encodeURIComponent(id)}/memory/versions/${encodeURIComponent(versionId)}` +
        `?file=${encodeURIComponent(file)}`,
    ),
  projectSessions: (id: string) =>
    request<ProjectSessionsResponse>(`/api/projects/${encodeURIComponent(id)}/sessions`),
  projectInbox: async (id: string, status: InboxStatus): Promise<PagedInbox> => {
    let untrusted = false;
    const { items, complete } = await pageAll<InboxMessage>(async (offset) => {
      const page = await request<ProjectInboxResponse>(
        `/api/projects/${encodeURIComponent(id)}/inbox` +
          `?status=${encodeURIComponent(status)}&offset=${offset}`,
      );
      untrusted = untrusted || page.untrusted;
      return { items: page.messages, nextOffset: page.next_offset };
    });
    return { status, messages: items, untrusted, complete };
  },
};
