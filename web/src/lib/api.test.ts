/**
 * The REST client's paging walk: it follows `next_offset` to the end so a
 * project list, memory history, or inbox larger than Zeta's 100-record page is
 * never shown as a silent first page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";

interface Page {
  body: Record<string, unknown>;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch stub that returns the next canned page for each matching path. */
function pager(pages: Record<string, Page[]>): typeof fetch {
  const cursors: Record<string, number> = {};
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString(), "http://test");
    const key = url.pathname;
    const index = cursors[key] ?? 0;
    cursors[key] = index + 1;
    const page = pages[key]?.[index];
    if (!page) {
      throw new Error(`no canned page ${index} for ${key}`);
    }
    return jsonResponse(page.body);
  }) as unknown as typeof fetch;
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

describe("api paging", () => {
  it("follows next_offset across every project page and reports complete", async () => {
    vi.stubGlobal(
      "fetch",
      pager({
        "/api/projects": [
          { body: { projects: [{ id: "p_1", name: "one" }], next_offset: 1 } },
          { body: { projects: [{ id: "p_2", name: "two" }], next_offset: 2 } },
          { body: { projects: [{ id: "p_3", name: "three" }], next_offset: null } },
        ],
      }),
    );

    const result = await api.projects();
    expect(result.projects.map((p) => p.id)).toEqual(["p_1", "p_2", "p_3"]);
    expect(result.complete).toBe(true);
  });

  it("concatenates every memory page in server (oldest-first) order", async () => {
    vi.stubGlobal(
      "fetch",
      pager({
        "/api/projects/p_1/memory/log": [
          { body: { versions: [{ version_id: "v_1" }], next_offset: 1 } },
          { body: { versions: [{ version_id: "v_2" }], next_offset: null } },
        ],
      }),
    );

    const result = await api.projectMemoryLog("p_1");
    expect(result.versions.map((v) => v.version_id)).toEqual(["v_1", "v_2"]);
    expect(result.complete).toBe(true);
  });

  it("merges inbox pages and marks the page untrusted when any page is", async () => {
    vi.stubGlobal(
      "fetch",
      pager({
        "/api/projects/p_1/inbox": [
          { body: { status: "new", messages: [{ id: "m_1" }], untrusted: false, next_offset: 1 } },
          {
            body: { status: "new", messages: [{ id: "m_2" }], untrusted: true, next_offset: null },
          },
        ],
      }),
    );

    const result = await api.projectInbox("p_1", "new");
    expect(result.messages.map((m) => m.id)).toEqual(["m_1", "m_2"]);
    expect(result.untrusted).toBe(true);
    expect(result.complete).toBe(true);
  });
});
