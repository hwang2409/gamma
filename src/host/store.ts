import { Database } from "bun:sqlite";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { ALLOWED_MEDIA_TYPES, ITEM_LIMIT, SESSION_LIMIT, type Artifact } from "./types";

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const randomId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const normalizeType = (value: string) => {
  const [type, ...parameters] = value.toLowerCase().split(";").map((part) => part.trim());
  if (parameters.some((part) => part !== "charset=utf-8")) return null;
  return type && ALLOWED_MEDIA_TYPES.has(type) ? type : null;
};
const validSignature = (type: string, bytes: Uint8Array) => {
  if (type === "image/png") return bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (type === "image/gif") return new TextDecoder().decode(bytes.subarray(0, 6)).match(/^GIF8[79]a$/) !== null;
  if (type === "image/webp") return new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
  if (type === "application/pdf") return new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  if (type === "image/svg+xml") {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    const root = text.replace(/^<\?xml[\s\S]*?\?>\s*/i, "");
    return !/<!DOCTYPE|<!ENTITY/i.test(root) && /^<svg(?:\s|>)/i.test(root) && (/<\/svg>\s*$/i.test(root) || /<svg\b[^>]*\/>\s*$/i.test(root));
  }
  return true;
};

export class HostStore {
  readonly db: Database;
  readonly root: string;
  constructor(root: string) {
    this.root = root;
    this.db = new Database(join(root, "gamma.sqlite"), { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, current_tool_call_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (artifact_id TEXT NOT NULL, session_id TEXT NOT NULL, version INTEGER NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL, title TEXT, filename TEXT, created_at TEXT NOT NULL, anchor_tool_call_id TEXT, path TEXT NOT NULL, PRIMARY KEY (artifact_id, version));
      CREATE INDEX IF NOT EXISTS artifact_sessions ON artifacts(session_id, created_at);`);
  }
  async ready() { await mkdir(this.root, { recursive: true, mode: 0o700 }); await chmod(this.root, 0o700); }
  mint(sessionId = randomId("pending")) {
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    this.db.run("INSERT OR REPLACE INTO sessions(id, token_hash, current_tool_call_id, created_at) VALUES (?, ?, NULL, ?)", [sessionId, tokenHash(token), new Date().toISOString()]);
    return { sessionId, token };
  }
  bind(from: string, to: string) {
    if (from === to) return;
    this.db.transaction(() => {
      this.db.run("DELETE FROM sessions WHERE id = ?", [to]);
      this.db.run("UPDATE sessions SET id = ? WHERE id = ?", [to, from]);
    })();
  }
  authenticate(token: string): string | null {
    if (!token) return null;
    const hash = tokenHash(token);
    const row = this.db.query("SELECT id, token_hash FROM sessions WHERE token_hash = ?").get(hash) as { id: string; token_hash: string } | null;
    if (!row || !timingSafeEqual(Buffer.from(hash), Buffer.from(row.token_hash))) return null;
    return row.id;
  }
  setContext(sessionId: string, toolCallId: string | null) { this.db.run("UPDATE sessions SET current_tool_call_id = ? WHERE id = ?", [toolCallId, sessionId]); }
  list(sessionId: string): Artifact[] {
    return this.db.query("SELECT artifact_id, session_id, version, media_type, size, title, filename, created_at, anchor_tool_call_id FROM artifacts WHERE session_id = ? ORDER BY created_at, version").all(sessionId) as Artifact[];
  }
  get(sessionId: string, id: string, version?: number): (Artifact & { path: string }) | null {
    const suffix = version === undefined ? "ORDER BY version DESC LIMIT 1" : "AND version = ?";
    return this.db.query(`SELECT * FROM artifacts WHERE session_id = ? AND artifact_id = ? ${suffix}`).get(...(version === undefined ? [sessionId, id] : [sessionId, id, version])) as (Artifact & { path: string }) | null;
  }
  async create(sessionId: string, input: { bytes: Uint8Array; mediaType: string; title?: string; filename?: string; artifactId?: string }): Promise<Artifact> {
    const mediaType = normalizeType(input.mediaType);
    if (!mediaType) throw Object.assign(new Error("unsupported content type"), { code: "unsupported_media_type", status: 415 });
    if (input.bytes.byteLength > ITEM_LIMIT) throw Object.assign(new Error("item exceeds 25 MiB"), { code: "item_too_large", status: 413 });
    let signatureValid = false;
    try { signatureValid = validSignature(mediaType, input.bytes); } catch { /* invalid UTF-8 SVG */ }
    if (!signatureValid) throw Object.assign(new Error("content does not match its media type"), { code: "invalid_content", status: 400 });
    if (input.title !== undefined && (input.title.trim().length < 1 || input.title.length > 200)) throw Object.assign(new Error("title must be 1 to 200 characters"), { code: "invalid_title", status: 400 });
    const total = (this.db.query("SELECT COALESCE(SUM(size), 0) total FROM artifacts WHERE session_id = ?").get(sessionId) as { total: number }).total;
    if (total + input.bytes.byteLength > SESSION_LIMIT) throw Object.assign(new Error("session exceeds 100 MiB"), { code: "session_quota_exceeded", status: 413 });
    const id = input.artifactId ?? randomId("a");
    const prior = this.get(sessionId, id);
    if (input.artifactId && !prior) throw Object.assign(new Error("artifact not found in this session"), { code: "artifact_not_found", status: 404 });
    const version = (prior?.version ?? 0) + 1;
    const createdAt = new Date().toISOString();
    const anchor = (this.db.query("SELECT current_tool_call_id FROM sessions WHERE id = ?").get(sessionId) as { current_tool_call_id: string | null }).current_tool_call_id;
    const sessionDirectory = tokenHash(sessionId);
    const relative = join(sessionDirectory, id, `${version}.bin`);
    const finalPath = join(this.root, relative);
    const tempPath = `${finalPath}.${crypto.randomUUID()}.tmp`;
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    const file = await import("node:fs/promises").then(({ open }) => open(tempPath, "wx", 0o600));
    try { await file.writeFile(input.bytes); await file.sync(); } finally { await file.close(); }
    await rename(tempPath, finalPath);
    try {
      this.db.run("INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, sessionId, version, mediaType, input.bytes.byteLength, input.title?.trim() ?? null, input.filename ?? null, createdAt, anchor, relative]);
    } catch (error) { await rm(finalPath, { force: true }); throw error; }
    return { artifact_id: id, session_id: sessionId, version, media_type: mediaType, size: input.bytes.byteLength, title: input.title?.trim() ?? null, filename: input.filename ?? null, created_at: createdAt, anchor_tool_call_id: anchor };
  }
  close() { this.db.close(); }
}
