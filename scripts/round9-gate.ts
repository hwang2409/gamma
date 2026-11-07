import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.ROUND9_GATE_PORT ?? 4299);
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.WEB_SHOTS ?? join(root, "gate-artifacts", "round9");
await mkdir(shots, { recursive: true });
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-round9-"));
const fake = await startFakeZeta({ origins: [origin], live: false });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) }, stdio: "ignore" });
const failures: string[] = [];

async function ready(page: Page) {
  try { await page.locator('.dock textarea[aria-label="message"]').waitFor({ timeout: 15_000 }); }
  catch (error) { console.log("READY BODY", (await page.locator("body").innerText()).slice(0, 1_000)); throw error; }
}
async function fresh(browser: Awaited<ReturnType<typeof chromium.launch>>, path = "/", width = 390, storage: Record<string, string> = {}) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
  await context.addInitScript((values) => { localStorage.clear(); for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, storage);
  const page = await context.newPage();
  await page.goto(`${origin}${path}`);
  await ready(page);
  return { context, page };
}
async function close(context: BrowserContext) {
  for (let attempt = 0; fake.running && attempt < 120; attempt++) await Bun.sleep(50);
  await context.close();
  await Bun.sleep(100);
}
async function check(name: string, run: () => Promise<void>) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (cause) { const message = cause instanceof Error ? cause.message.split("\n")[0] : String(cause); failures.push(`${name}: ${message}`); console.log(`FAIL ${name}: ${message}`); }
}
async function choose(page: Page, name: string) {
  await page.locator('button[aria-label^="model:"]').click();
  await page.getByRole("option", { name, exact: true }).click();
}

try {
  for (let attempt = 0; ; attempt++) { if (vite.exitCode !== null) throw new Error("vite exited"); if (await fetch(origin).then((r) => r.ok, () => false)) break; if (attempt > 300) throw new Error("vite did not start"); await Bun.sleep(100); }
  const browser = await chromium.launch();
  try {
    await check("run-scoped-composer-back-forward", async () => {
      const { context, page } = await fresh(browser, "/?run=s-reconnect");
      try {
        const field = page.locator('.dock textarea[aria-label="message"]');
        await field.fill("private draft for run a");
        await page.getByRole("button", { name: "new run" }).click();
        await page.getByRole("heading", { name: "untitled run" }).waitFor();
        await field.fill("blank run draft b");
        await page.goBack(); await ready(page);
        if (await field.inputValue() !== "private draft for run a") throw new Error(`run a draft became ${JSON.stringify(await field.inputValue())}`);
        await page.goForward(); await ready(page);
        if (await field.inputValue() !== "blank run draft b") throw new Error(`blank run draft became ${JSON.stringify(await field.inputValue())}`);
        await page.screenshot({ path: join(shots, "major-composer-run-scope-390.png") });
      } finally { await close(context); }
    });

    await check("resumed-model-beats-next-run-preference", async () => {
      const { context, page } = await fresh(browser, "/?run=s-reconnect", 390, { "gamma-model": "claude-sonnet-5" });
      try {
        await page.getByRole("button", { name: "model: default (claude-opus-4-6)" }).waitFor({ timeout: 10_000 });
        if (await page.getByRole("button", { name: /model: claude-sonnet-5/ }).count()) throw new Error("browser preference replaced resumed session settings");
        await page.screenshot({ path: join(shots, "major-resumed-session-model-390.png") });
      } finally { await close(context); }
    });

    await check("default-model-stays-zeta-default", async () => {
      const { context, page } = await fresh(browser);
      try {
        await page.locator('.dock textarea[aria-label="message"]').fill("start with zeta default");
        await page.getByRole("button", { name: "send message" }).click();
        await page.getByRole("button", { name: "model: default (gpt-5.1-codex)" }).waitFor({ timeout: 10_000 });
        await choose(page, "claude-sonnet-5");
        await choose(page, "default (gpt-5.1-codex)");
        for (let attempt = 0; fake.settings.model !== "gpt-5.1-codex" && attempt < 100; attempt++) await Bun.sleep(20);
        if (fake.settings.model !== "gpt-5.1-codex") throw new Error(`default left model at ${fake.settings.model}`);
        if (await page.evaluate(() => localStorage.getItem("gamma-model")) !== null) throw new Error("resolved default leaked into next-run preference");
        await page.screenshot({ path: join(shots, "major-zeta-default-model-390.png") });
      } finally { await close(context); }
    });

    await check("mobile-inspector-keeps-actions-visible", async () => {
      const { context, page } = await fresh(browser);
      try {
        const name = "screenshot-of-the-failing-test-run-with-a-very-long-name.png";
        await page.locator('.dock input[type="file"]').setInputFiles({ name, mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71]) });
        await page.getByRole("button", { name: `open image: ${name}` }).click();
        const dialog = page.getByRole("dialog", { name: "file inspector" }); await dialog.waitFor();
        for (const label of ["download", "close"]) {
          const box = await dialog.getByRole(label === "download" ? "link" : "button", { name: label }).boundingBox();
          if (!box || box.x < 0 || box.x + box.width > 390) throw new Error(`${label} is outside the viewport: ${JSON.stringify(box)}`);
        }
        if (await dialog.evaluate((node) => node.scrollWidth > node.clientWidth)) throw new Error("inspector overflows horizontally");
        await page.screenshot({ path: join(shots, "major-inspector-long-name-390.png") });
      } finally { await close(context); }
    });

    await check("compact-notice-keeps-copy-visible", async () => {
      const { context, page } = await fresh(browser, "/?run=s-reconnect");
      try {
        await page.getByRole("log", { name: "run activity" }).waitFor();
        await fake.stop();
        const notice = page.locator(".notice"); await notice.waitFor({ timeout: 10_000 });
        const copy = notice.getByRole("button", { name: /copy/ }); const box = await copy.boundingBox();
        if (!box || box.x < 0 || box.x + box.width > 390) throw new Error(`copy is outside the viewport: ${JSON.stringify(box)}`);
        if (await notice.evaluate((node) => node.scrollWidth > node.clientWidth)) throw new Error("compact notice overflows horizontally");
        await page.screenshot({ path: join(shots, "major-compact-notice-390.png") });
      } finally { await fake.start(); await close(context); }
    });

    await check("mobile-delivery-note-has-no-empty-reservation", async () => {
      const { context, page } = await fresh(browser);
      try {
        await page.locator('.dock textarea[aria-label="message"]').fill("delivery note reservation");
        await page.getByRole("button", { name: "send message" }).click();
        await page.locator('[data-kind="user"]', { hasText: "delivery note reservation" }).waitFor({ timeout: 10_000 });
        const empty = page.locator('.undelivered[data-empty][data-reserve]').last();
        if (!await empty.count()) throw new Error("delivery row has no note anchor");
        const height = await empty.evaluate((node) => node.getBoundingClientRect().height);
        if (height > 1) throw new Error(`empty delivery note reserves ${height}px`);
        await page.screenshot({ path: join(shots, "minor-delivery-note-no-gap-390.png") });
      } finally { await close(context); }
    });

    await check("popover-tab-dismissal-and-mobile-labels", async () => {
      const { context, page } = await fresh(browser);
      try {
        await page.locator('button[aria-label^="model:"]').click();
        const list = page.getByRole("listbox", { name: "model" }); await list.press("Tab");
        if (await list.count()) throw new Error("Tab left model list open");
        await page.getByRole("button", { name: /^approval mode: Ask/ }).click();
        await page.keyboard.press("Tab");
        if (await page.getByRole("dialog", { name: "allow tools without asking" }).count()) throw new Error("Tab left YOLO popover open");
        const modelWidth = await page.locator('button[aria-label^="model:"]').evaluate((node) => node.getBoundingClientRect().width);
        if (modelWidth < 90) throw new Error(`model control is only ${modelWidth}px wide`);
        await page.screenshot({ path: join(shots, "minor-mobile-controls-390.png") });
      } finally { await close(context); }
    });
  } finally { await browser.close(); }
} finally {
  vite.kill("SIGTERM");
  await fake.close();
  await rm(gammaHome, { recursive: true, force: true });
}
if (failures.length) throw new Error(`round 9 gate failed (${failures.length}):\n${failures.join("\n")}`);
console.log("round 9 gate passed (7 checks)");
