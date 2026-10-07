/**
 * The REST client's project reads. The backend walks Zeta's pages over one
 * serve connection and returns the whole set with a `complete` flag, so each
 * view makes a single request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch stub that returns one canned body and records the paths it saw. */
function stub(bodies: Record<string, unknown>): { fetch: typeof fetch; paths: string[] } {
  const paths: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString(), "http://test");
    paths.push(url.pathname + url.search);
    const body = bodies[url.pathname];
    if (body === undefined) {
      throw new Error(`no canned body for ${url.pathname}`);
    }
    return jsonResponse(body);
  }) as unknown as typeof fetch;
  return { fetch: fetchMock, paths };
}

beforeEach(() => {
  vi.stubGlobal("window", {
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("project reads", () => {
  it("fetches the whole project list in one request", async () => {
    const { fetch, paths } = stub({
      "/api/projects": {
        projects: [
          { id: "p_1", name: "one" },
          { id: "p_2", name: "two" },
        ],
        complete: true,
      },
    });
    vi.stubGlobal("fetch", fetch);

    const result = await api.projects();
    expect(result.projects.map((p) => p.id)).toEqual(["p_1", "p_2"]);
    expect(result.complete).toBe(true);
    expect(paths).toEqual(["/api/projects"]);
  });

  it("marks an incomplete project list when the backend capped the walk", async () => {
    vi.stubGlobal(
      "fetch",
      stub({ "/api/projects": { projects: [{ id: "p_1", name: "one" }], complete: false } }).fetch,
    );

    const result = await api.projects();
    expect(result.complete).toBe(false);
  });

  it("fetches the whole memory history in one request", async () => {
    const { fetch, paths } = stub({
      "/api/projects/p_1/memory/log": {
        versions: [{ version_id: "v_1" }, { version_id: "v_2" }],
        complete: true,
      },
    });
    vi.stubGlobal("fetch", fetch);

    const result = await api.projectMemoryLog("p_1");
    expect(result.versions.map((v) => v.version_id)).toEqual(["v_1", "v_2"]);
    expect(result.complete).toBe(true);
    expect(paths).toEqual(["/api/projects/p_1/memory/log"]);
  });

  it("fetches the whole inbox in one request and keeps the untrusted flag", async () => {
    const { fetch, paths } = stub({
      "/api/projects/p_1/inbox": {
        status: "new",
        messages: [{ id: "m_1" }, { id: "m_2" }],
        untrusted: true,
        complete: true,
      },
    });
    vi.stubGlobal("fetch", fetch);

    const result = await api.projectInbox("p_1", "new");
    expect(result.messages.map((m) => m.id)).toEqual(["m_1", "m_2"]);
    expect(result.untrusted).toBe(true);
    expect(result.complete).toBe(true);
    expect(paths).toEqual(["/api/projects/p_1/inbox?status=new"]);
  });
});
