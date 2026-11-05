// One live check against a real `zeta serve --ws` with Henry's own login (not in CI). The zeta home is a temporary
// directory under ~/.zeta/scratch with copies of the real settings and accounts (read, never changed or printed), so the
// real home's discovery file and any running server are never touched. It picks an anthropic model in the composer,
// then a text turn must stream a reply, and an image turn must get a reply that describes the image.
// Usage: bun scripts/live-check.ts   (ZETA_CMD overrides the zeta binary; WEB_LIVE_PORT the app port)
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const root = new URL("..", import.meta.url).pathname;
const zeta = process.env.ZETA_CMD ?? "zeta";
const port = Number(process.env.WEB_LIVE_PORT ?? 4283);
const origin = `http://127.0.0.1:${port}`;
const real = process.env.ZETA_HOME ?? join(homedir(), ".zeta");
const scratch = join(real, "scratch", "gamma", "polish");
const shots = process.env.WEB_SHOTS ?? scratch;
const registry = JSON.parse(await readFile(join(real, "accounts.json"), "utf8")) as { defaults?: Record<string, string> };
const account = (registry.defaults?.anthropic ?? "anthropic:default").split(":")[1];
const { expires_at } = JSON.parse(await readFile(join(real, "accounts", "anthropic", account!, "oauth.json"), "utf8")) as { expires_at: number };
if (expires_at - Date.now() / 1000 < 30 * 60) throw new Error("the anthropic token expires within 30 minutes; run zeta once to refresh it, then retry");
const home = await mkdtemp(join(scratch, "live-home-"));
const gammaHome = await mkdtemp(join(scratch, "live-gamma-"));
const cwd = join(scratch, "live-cwd");
await mkdir(cwd, { recursive: true });
await mkdir(join(home, "sessions"), { recursive: true });
// zeta refuses linked account files and, under ZETA_HOME, reads no Claude Code login, so the home gets copies of the
// settings and accounts. A copy must never refresh a token (that would rotate Henry's refresh token), so the check
// refuses to run when the anthropic token expires within 30 minutes.
for (const name of ["settings.toml", "accounts.json", "accounts"]) await cp(join(real, name), join(home, name), { recursive: true });

const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } });
const wsPort = probe.port;
probe.stop(true);

// stderr carries the connect url with the token, so it is discarded, never printed.
const server: ChildProcess = spawn(zeta, ["serve", "--ws", String(wsPort), "--ws-origin", origin, "--cwd", cwd, "--no-auto-memory"], {
  cwd, env: { ...process.env, ZETA_HOME: home, ZETA_ANTHROPIC_OAUTH_COMPAT: "1" }, stdio: "ignore", detached: true,
});
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: root, env: { ...process.env, ZETA_HOME: home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin }, stdio: "ignore",
});
const rows: Array<[string, string]> = [];
const replies: string[] = [];
let usage: unknown;
let page: Page | undefined;
const check = async (name: string, run: () => Promise<void>) => {
  try { await run(); rows.push([name, "pass"]); } catch (error) {
    rows.push([name, `fail: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`]);
    await page?.screenshot({ path: join(shots, `live-fail-${rows.length}.png`) });
  }
};
try {
  for (let i = 0; !existsSync(join(home, "run", "serve.ws.json")); i++) {
    if (i > 300 || server.exitCode !== null) throw new Error("zeta serve did not write its discovery file");
    await Bun.sleep(100);
  }
  for (let i = 0; !(await fetch(origin).then((response) => response.ok, () => false)); i++) {
    if (i > 600) throw new Error("vite did not start");
    await Bun.sleep(100);
  }
  const browser = await chromium.launch();
  try {
    // A real image to describe: a red circle on white.
    const maker = await browser.newPage({ viewport: { width: 240, height: 240 } });
    await maker.setContent('<body style="margin:0;background:#fff"><div style="margin:20px;width:200px;height:200px;border-radius:50%;background:#d11"></div></body>');
    const circle = await maker.screenshot();
    await maker.close();

    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("dialog", (dialog) => void dialog.accept());
    // The first usage event, kept so adapter tests can use a real payload (token counts and tiers only, no secrets).
    page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
      if (usage || typeof payload !== "string" || !payload.includes('"usage"')) return;
      const frame = JSON.parse(payload) as { params?: { event?: string } };
      if (frame.params?.event === "usage") usage = frame.params;
    }));
    await page.goto(`${origin}/?theme=tokyo-night`);
    const field = page.getByRole("textbox", { name: "message" });
    const finished = async (count: number) => {
      // The reply streams, then the run is ready again with no error row.
      await page.locator('[data-part="timeline"] [data-kind="message"]').nth(count - 1).waitFor({ timeout: 120_000 });
      await page.locator('.status-line[data-state="ready"]').waitFor({ timeout: 180_000 });
      if (await page.locator('[data-part="timeline"] [data-kind="error"]').count()) throw new Error(`turn failed: ${await page.locator('[data-part="timeline"] [data-kind="error"]').first().textContent()}`);
      return (await page.locator('[data-part="timeline"] [data-kind="message"]').nth(count - 1).textContent())?.trim() ?? "";
    };
    const pickModel = async () => {
      await page!.getByRole("button", { name: /^model:/ }).click({ timeout: 20_000 });
      const options = page!.getByRole("option");
      const names = await options.allTextContents();
      const model = names.find((name) => /^claude-sonnet-5$/.test(name)) ?? names.find((name) => /sonnet/.test(name));
      if (!model) throw new Error(`no anthropic sonnet model in ${names.join(", ")}`);
      await options.filter({ hasText: new RegExp(`^${model}$`) }).click();
      await page!.getByRole("button", { name: `model: ${model}` }).waitFor({ timeout: 20_000 });
      replies.push(`picked: ${model}`);
    };
    await check("a text turn streams a real reply (zeta's default anthropic model)", async () => {
      await field.waitFor({ timeout: 60_000 });
      await field.fill("do not use any tools. reply with one short sentence that says the gamma live check works.");
      await field.press("Enter");
      const reply = await finished(1);
      if (!reply) throw new Error("empty reply");
      replies.push(`model: ${(await page!.getByRole("button", { name: /^model:/ }).textContent())?.trim()}`, `text reply: ${reply}`);
      await page!.screenshot({ path: join(shots, "live-anthropic-text-1440.png") });
    });
    await check("picks an anthropic model in the composer footer", pickModel);
    await check("an image turn gets a reply that describes the image", async () => {
      await page.locator('.dock [data-part="composer"] input[type=file]').setInputFiles({ name: "circle.png", mimeType: "image/png", buffer: circle });
      const thumb = page.locator('.dock [data-part="attachment"] img');
      await thumb.waitFor();
      if (!(await thumb.evaluate((node) => (node as HTMLImageElement).naturalWidth > 0))) throw new Error("thumbnail did not load");
      await field.fill("do not use any tools. describe this image in one sentence: its shape and its color.");
      await page.getByRole("button", { name: "send message" }).click();
      const reply = await finished(2);
      replies.push(`image reply: ${reply}`);
      if (!/red/i.test(reply) || !/circle|round|disc|dot/i.test(reply)) throw new Error(`reply does not describe a red circle: ${reply}`);
      await page.screenshot({ path: join(shots, "live-anthropic-image-1440.png") });
    });
  } finally {
    await browser.close();
  }
} finally {
  vite.kill("SIGTERM");
  if (server.pid && server.exitCode === null) process.kill(-server.pid, "SIGTERM");
  // LIVE_KEEP=1 keeps the home (with its copied accounts) to read the session afterwards; delete it when done.
  if (process.env.LIVE_KEEP !== "1") await rm(home, { recursive: true, force: true });
  await rm(gammaHome, { recursive: true, force: true });
}
for (const line of replies) console.log(line);
if (usage) console.log(`usage event: ${JSON.stringify(usage)}`);
for (const [name, result] of rows) console.log(`${result === "pass" ? "ok  " : "FAIL"} ${name}${result === "pass" ? "" : `: ${result}`}`);
process.exit(rows.some(([, result]) => result !== "pass") || rows.length === 0 ? 1 : 0);
