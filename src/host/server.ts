import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HostStore } from "./store";
import type { HostCommand } from "./types";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) => {
  const value = error as { code?: string; status?: number; message?: string };
  return json({ error: { code: value.code ?? "internal_error", message: value.status ? value.message : "internal server error" } }, value.status ?? 500);
};
const bearer = (request: Request) => request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? "";
const limited = new Map<string, { writes: number[]; reads: number[] }>();
const rate = (key: string, kind: "writes" | "reads", limit: number) => {
  const now = Date.now(); const item = limited.get(key) ?? { writes: [], reads: [] }; limited.set(key, item);
  item[kind] = item[kind].filter((at) => at > now - 60_000);
  if (item[kind].length >= limit) return false;
  item[kind].push(now); return true;
};
const safeName = (value: string | null) => value?.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "artifact";

export async function startHost(options: { root?: string; appOrigin: string; port?: number } ) {
  const root = options.root ?? join(process.env.HOME!, ".gamma", "sessions");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const store = new HostStore(root); await store.ready();
  store.db.run("DELETE FROM sessions"); // capabilities are process-local and rotate on every gamma restart
  const appToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  let url = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: options.port ?? 0, maxRequestBodySize: 25 * 1024 * 1024 + 64 * 1024, async fetch(request) {
    try {
      const target = new URL(request.url);
      if (request.headers.get("host") !== target.host) return failure(Object.assign(new Error("invalid host"), { code: "invalid_host", status: 403 }));
      const origin = request.headers.get("origin");
      if (origin && origin !== options.appOrigin) return failure(Object.assign(new Error("invalid origin"), { code: "invalid_origin", status: 403 }));
      const app = request.headers.get("x-gamma-app-token") === appToken;
      if (target.pathname === "/app/sessions" && request.method === "POST" && app) {
        const body = await request.json().catch(() => ({})) as { session_id?: string };
        const minted = store.mint(body.session_id);
        const command: HostCommand = { name: "gamma", executable: resolve(new URL("../../bin/gamma", import.meta.url).pathname), summary: "web-surface commands (render files into the chat); run `gamma help`", environment: { GAMMA_API_URL: `${url}/api`, GAMMA_API_TOKEN: minted.token } };
        return json({ registration_id: minted.sessionId, command });
      }
      const bind = target.pathname.match(/^\/app\/sessions\/([^/]+)\/bind$/);
      if (bind && request.method === "POST" && app) { const body = await request.json() as { session_id: string }; store.bind(decodeURIComponent(bind[1]!), body.session_id); return json({ ok: true }); }
      const context = target.pathname.match(/^\/app\/sessions\/([^/]+)\/context$/);
      if (context && request.method === "POST" && app) { const body = await request.json() as { tool_call_id?: string | null }; store.setContext(decodeURIComponent(context[1]!), body.tool_call_id ?? null); return json({ ok: true }); }
      const appArtifacts = target.pathname.match(/^\/app\/sessions\/([^/]+)\/artifacts$/);
      if (appArtifacts && request.method === "GET" && app) return json({ artifacts: store.list(decodeURIComponent(appArtifacts[1]!)) });
      const content = target.pathname.match(/^\/app\/sessions\/([^/]+)\/artifacts\/([^/]+)\/versions\/(\d+)\/content$/);
      if (content && request.method === "GET" && app) {
        const row = store.get(decodeURIComponent(content[1]!), decodeURIComponent(content[2]!), Number(content[3]));
        if (!row) return failure(Object.assign(new Error("artifact not found"), { code: "artifact_not_found", status: 404 }));
        return new Response(Bun.file(join(root, row.path)), { headers: { "Content-Type": row.media_type, "Content-Disposition": `inline; filename="${safeName(row.filename ?? row.title)}"`, "Cache-Control": "private, max-age=31536000, immutable" } });
      }
      const sessionId = store.authenticate(bearer(request));
      if (!sessionId) return failure(Object.assign(new Error("invalid bearer token"), { code: "unauthorized", status: 401 }));
      if (target.pathname === "/api/artifacts" && request.method === "GET") {
        if (!rate(sessionId, "reads", 120)) return failure(Object.assign(new Error("read rate exceeded"), { code: "rate_limited", status: 429 }));
        return json({ artifacts: store.list(sessionId) });
      }
      if (target.pathname === "/api/render" && request.method === "POST") {
        if (!rate(sessionId, "writes", 30)) return failure(Object.assign(new Error("write rate exceeded"), { code: "rate_limited", status: 429 }));
        let bytes: Uint8Array, mediaType: string, title: string | undefined, filename: string | undefined, artifactId: string | undefined;
        if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
          const form = await request.formData(); const file = form.get("file");
          if (!(file instanceof File)) return failure(Object.assign(new Error("file is required"), { code: "invalid_request", status: 400 }));
          bytes = new Uint8Array(await file.arrayBuffer()); mediaType = String(form.get("media_type") || file.type); title = String(form.get("title") || "") || undefined; artifactId = String(form.get("artifact_id") || "") || undefined; filename = file.name;
        } else {
          bytes = new Uint8Array(await request.arrayBuffer()); mediaType = request.headers.get("content-type") ?? ""; title = request.headers.get("x-gamma-title") ?? undefined; artifactId = request.headers.get("x-gamma-artifact-id") ?? undefined;
        }
        const row = await store.create(sessionId, { bytes, mediaType, title, filename, artifactId });
        return json(row, artifactId ? 200 : 201);
      }
      return failure(Object.assign(new Error("route not found"), { code: "not_found", status: 404 }));
    } catch (error) { return failure(error); }
  }});
  url = `http://127.0.0.1:${server.port}`;
  const discoveryDir = join(process.env.HOME!, ".gamma"); await mkdir(discoveryDir, { recursive: true, mode: 0o700 });
  const discovery = join(discoveryDir, "api.json"); await writeFile(discovery, JSON.stringify({ url, pid: process.pid, cli: resolve(new URL("../../bin/gamma", import.meta.url).pathname) }) + "\n", { mode: 0o600 }); await chmod(discovery, 0o600);
  return { url, appToken, store, stop() { server.stop(true); store.close(); } };
}

if (import.meta.main) {
  const host = await startHost({ appOrigin: process.env.GAMMA_APP_ORIGIN ?? "http://localhost:5190", port: process.env.GAMMA_API_PORT ? Number(process.env.GAMMA_API_PORT) : undefined });
  console.log(host.url);
  await new Promise(() => {});
}
