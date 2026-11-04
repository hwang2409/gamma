// One live check against a real `zeta serve --ws` (not in CI). It runs zeta under a temporary ZETA_HOME with copies of
// a few sessions, so the real home and its server are never touched, then drives the app in Chromium: connect, list,
// open a session, stop zeta (the "not running" state), start it again (reconnect with the new token).
// Usage: WEB_LIVE_SESSIONS="<id> <id>" bun scripts/live-check.ts   (ZETA_CMD overrides the zeta binary)
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url).pathname;
const zeta = process.env.ZETA_CMD ?? "zeta";
const port = Number(process.env.WEB_LIVE_PORT ?? 4182);
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.WEB_SHOTS ?? join(root, "gate-artifacts");
const home = await mkdtemp(join(tmpdir(), "fulcrum-web-live-"));
const sessions = (process.env.WEB_LIVE_SESSIONS ?? "").split(/\s+/).filter(Boolean);
await mkdir(join(home, "sessions"), { recursive: true });
await mkdir(shots, { recursive: true });
await writeFile(join(home, "settings.toml"), 'provider = "ollama"\nmodel = "qwen3:4b"\n');
for (const id of sessions) {
  const copy = join(home, "sessions", id);
  await cp(join(homedir(), ".zeta", "sessions", id), copy, { recursive: true, filter: (path) => !path.includes("/agents/") });
  // The temporary home has no provider accounts, so the copies point at the local ollama provider (the copies only).
  const meta = JSON.parse(await readFile(join(copy, "meta.json"), "utf8"));
  await writeFile(join(copy, "meta.json"), JSON.stringify({ ...meta, provider: "ollama", model: "qwen3:4b", selected_accounts: {} }));
}

const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } });
const wsPort = probe.port;
probe.stop(true);
let server: ChildProcess | undefined;
const startZeta = async () => {
  await rm(join(home, "run", "serve.ws.json"), { force: true });
  // stderr carries the connect url with the token, so it is discarded, never printed.
  server = spawn(zeta, ["serve", "--ws", String(wsPort), "--ws-origin", origin], { env: { ...process.env, ZETA_HOME: home }, stdio: "ignore", detached: true });
  for (let i = 0; i < 100; i++) {
    if (await readFile(join(home, "run", "serve.ws.json"), "utf8").then(() => true, () => false)) return;
    await Bun.sleep(100);
  }
  throw new Error("zeta serve did not write its discovery file");
};
const stopZeta = async () => {
  if (!server?.pid || server.exitCode !== null) return;
  process.kill(-server.pid, "SIGTERM");
  await new Promise((resolve) => server!.once("exit", resolve));
};
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: home }, stdio: "ignore" });
const rows: Array<[string, string]> = [];
const check = async (name: string, run: () => Promise<void>) => {
  try { await run(); rows.push([name, "pass"]); } catch (error) { rows.push([name, `fail: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`]); }
};
try {
  await startZeta();
  while (!(await fetch(origin).then((response) => response.ok, () => false))) await Bun.sleep(100);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${origin}/?theme=gruvbox-dark`);
    await check("connects through the dev-server handoff", () => page.locator(".badge", { hasText: "connected" }).waitFor({ timeout: 60_000 }));
    await check(`lists the ${sessions.length} copied sessions`, async () => {
      await page.locator("button.session").first().waitFor({ timeout: 10_000 });
      const count = await page.locator("button.session").count();
      if (count !== sessions.length) throw new Error(`${count} rows`);
    });
    await check("opens a session from its history", async () => {
      await page.locator("button.session").first().click();
      await page.locator('[data-part="timeline"] [data-id]').first().waitFor({ timeout: 20_000 });
      await page.screenshot({ path: join(shots, "live-zeta-1440-gruvbox-dark.png") });
    });
    await check("zeta stopped: shows not running with the command", async () => {
      await stopZeta();
      await page.getByText("connection lost: zeta serve stopped").waitFor({ timeout: 15_000 });
      await page.screenshot({ path: join(shots, "live-zeta-stopped-1440.png") });
    });
    await check("zeta started again: reconnects with the new token and reopens the session", async () => {
      await startZeta();
      await page.locator(".badge", { hasText: "connected" }).waitFor({ timeout: 20_000 });
      await page.locator(".notice").waitFor({ state: "detached", timeout: 20_000 });
      await page.locator('[data-part="timeline"] [data-id]').first().waitFor({ timeout: 20_000 });
    });
  } finally {
    await browser.close();
  }
} finally {
  vite.kill("SIGTERM");
  await stopZeta().catch(() => {});
  await rm(home, { recursive: true, force: true });
}
for (const [name, result] of rows) console.log(`${result === "pass" ? "ok  " : "FAIL"} ${name}${result === "pass" ? "" : `: ${result}`}`);
process.exit(rows.some(([, result]) => result !== "pass") || rows.length === 0 ? 1 : 0);
