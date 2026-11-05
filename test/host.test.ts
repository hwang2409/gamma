import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostStore } from "../src/host/store";
import { ITEM_LIMIT, SESSION_LIMIT } from "../src/host/types";
import { startHost } from "../src/host/server";

const roots: string[] = [];
const root = async () => { const path = await mkdtemp(join(tmpdir(), "gamma-host-")); roots.push(path); return path; };
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const png = new Uint8Array([137,80,78,71,13,10,26,10,0]);

describe("host store", () => {
  test("isolates capabilities and artifact ids between sessions", async () => {
    const path = await root(); const store = new HostStore(path); await store.ready();
    const one = store.mint("one"), two = store.mint("two");
    expect(store.authenticate(one.token)).toBe("one"); expect(store.authenticate(two.token)).toBe("two"); expect(store.authenticate(`${one.token.slice(0, -1)}x`)).toBeNull();
    const artifact = await store.create("one", { bytes: png, mediaType: "image/png" });
    expect(store.get("one", artifact.artifact_id)?.size).toBe(png.length); expect(store.get("two", artifact.artifact_id)).toBeNull();
    await expect(store.create("two", { bytes: png, mediaType: "image/png", artifactId: artifact.artifact_id })).rejects.toMatchObject({ code: "artifact_not_found" });
    store.close();
  });

  test("enforces allowlist, signatures, item limit, and session quota before commit", async () => {
    const path = await root(); const store = new HostStore(path); await store.ready(); store.mint("one");
    await expect(store.create("one", { bytes: png, mediaType: "application/octet-stream" })).rejects.toMatchObject({ code: "unsupported_media_type" });
    await expect(store.create("one", { bytes: new TextEncoder().encode("not png"), mediaType: "image/png" })).rejects.toMatchObject({ code: "invalid_content" });
    await expect(store.create("one", { bytes: new Uint8Array(ITEM_LIMIT + 1), mediaType: "text/plain" })).rejects.toMatchObject({ code: "item_too_large" });
    store.db.run("INSERT INTO artifacts VALUES ('a', 'one', 1, 'text/plain', ?, NULL, NULL, ?, NULL, 'unused')", [SESSION_LIMIT, new Date().toISOString()]);
    await expect(store.create("one", { bytes: new Uint8Array([1]), mediaType: "text/plain" })).rejects.toMatchObject({ code: "session_quota_exceeded" });
    expect(store.list("one")).toHaveLength(1); store.close();
  });
});

describe("host http interface", () => {
  test("requires bearer auth, exact origin, and never accepts a source path", async () => {
    const path = await root(); const host = await startHost({ root: path, appOrigin: "http://localhost:5190" }); const session = host.store.mint("one");
    try {
      const unauthorized = await fetch(`${host.url}/api/artifacts`); expect(unauthorized.status).toBe(401); expect(await unauthorized.json()).toEqual({ error: { code: "unauthorized", message: "invalid bearer token" } });
      const foreignOrigin = await fetch(`${host.url}/api/artifacts`, { headers: { Authorization: `Bearer ${session.token}`, Origin: "http://evil.test" } }); expect(foreignOrigin.status).toBe(403);
      const pathAttempt = await fetch(`${host.url}/api/render`, { method: "POST", headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ path: "/private/secret.png" }) });
      expect(pathAttempt.status).toBe(201); // JSON is content; the server does not interpret its `path` field.
      expect(host.store.list("one")).toHaveLength(1);
      const upload = await fetch(`${host.url}/api/render`, { method: "POST", headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "image/png", "X-Gamma-Title": "chart" }, body: png });
      expect(upload.status).toBe(201); expect((await upload.json() as any).title).toBe("chart");
    } finally { host.stop(); }
  });
});

test("cli reads the file and uploads bytes without its path", async () => {
  const path = await root(); const file = join(path, "private-chart.txt"); await writeFile(file, "chart bytes");
  let seen = ""; const token = "x".repeat(43);
  const server = Bun.serve({ port: 0, async fetch(request) { seen = new TextDecoder().decode(await request.arrayBuffer()); return Response.json({ artifact_id: "a_test", version: 1, media_type: "text/plain", size: 11 }); } });
  try {
    const process = Bun.spawn([join(import.meta.dir, "../bin/gamma"), "render", file, "--type", "text/plain"], { env: { ...Bun.env, GAMMA_API_URL: `http://127.0.0.1:${server.port}/api`, GAMMA_API_TOKEN: token }, stdout: "pipe", stderr: "pipe" });
    expect(await process.exited).toBe(0); expect(await new Response(process.stdout).text()).toContain("a_test v1");
    expect(seen).toContain("chart bytes"); expect(seen).toContain("private-chart.txt"); expect(seen).not.toContain(path);
  } finally { server.stop(true); }
});
