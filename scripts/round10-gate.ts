import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.ROUND10_GATE_PORT ?? 4310);
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.WEB_SHOTS ?? join(root, "gate-artifacts", "round10");
await mkdir(shots, { recursive: true });
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-round10-"));
const fake = await startFakeZeta({ origins: [origin], live: false, helloDelay: 16_000, serialDelays: { send: process.env.GATE_ONLY ? [2_000] : [...Array(13).fill(0), 2_000] } });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) }, stdio: "ignore" });
for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(origin)).ok) break; } catch {} await Bun.sleep(50); }
const failures: string[] = [];
let passed = 0;

async function ready(page: Page) { await page.locator('.dock textarea[aria-label^="message"]').waitFor({ timeout: 15_000 }); }
async function fresh(browser: Awaited<ReturnType<typeof chromium.launch>>, path = "/", width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
  await context.addInitScript(() => { if (!sessionStorage.getItem("round10-started")) { localStorage.clear(); sessionStorage.setItem("round10-started", "1"); } });
  const page = await context.newPage(); await page.goto(`${origin}${path}`);
  try { await ready(page); } catch { console.log("fresh retry", (await page.locator("body").innerText()).slice(0, 500)); fake.drop(); await Bun.sleep(300); await page.reload(); await ready(page); }
  return { context, page };
}
async function close(context: BrowserContext) { await context.close(); fake.drop(); await Bun.sleep(300); }
async function check(name: string, run: () => Promise<void>) {
  if (process.env.GATE_ONLY && process.env.GATE_ONLY !== name) return;
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); failures.push(`${name}: ${message}`); console.log(`FAIL ${name}: ${message}`); }
}
async function choose(page: Page, name: string) { await page.locator('button[aria-label^="model:"]').click(); await page.getByRole("option", { name, exact: true }).click(); }
async function pendingNavigation(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  const { context, page } = await fresh(browser);
  try {
    const field = page.locator('.dock textarea[aria-label="message"]');
    await field.fill("send this"); await page.getByRole("button", { name: "send message" }).click();
    await field.fill("send thiskeep this unsent follow-up");
    await page.getByRole("button", { name: "new run" }).click();
    await page.getByRole("heading", { name: "untitled run" }).waitFor();
    await Bun.sleep(2_200); await page.goBack(); await ready(page);
    const actual = await field.inputValue();
    if (actual !== "keep this unsent follow-up") throw new Error(`follow-up became ${JSON.stringify(actual)}`);
    await page.screenshot({ path: join(shots, "blocker-pending-navigation-1440.png") });
  } finally { await close(context); }
}
async function send(page: Page, text: string) {
  const field = page.locator('.dock textarea[aria-label="message"]'); await field.fill(text); await page.getByRole("button", { name: "send message" }).click();
  const stop = page.getByRole("button", { name: "stop the running turn" });
  await stop.waitFor({ timeout: 10_000 }); await stop.click();
  await page.locator('button.new-run:not([disabled])').waitFor({ state: "visible", timeout: 15_000 });
}

try {
  for (let attempt = 0; ; attempt++) { if (vite.exitCode !== null) throw new Error("vite exited"); if (await fetch(origin).then((r) => r.ok, () => false)) break; if (attempt > 300) throw new Error("vite did not start"); await Bun.sleep(100); }
  const browser = await chromium.launch();
  try {
    if (process.env.GATE_ONLY) await check("pending-acceptance-keeps-follow-up-in-own-run", () => pendingNavigation(browser));

    await check("dirty-run-survives-clean-cache-bound", async () => {
      const { context, page } = await fresh(browser, "/?run=s-reconnect");
      try {
        const field = page.locator('.dock textarea[aria-label="message"]'); await field.fill("private draft that must stay");
        for (let index = 0; index < 9; index++) {
          console.log(`dirty sequence ${index}: new`);
          await page.getByRole("button", { name: "new run" }).click(); await page.getByRole("heading", { name: "untitled run" }).waitFor();
          console.log(`dirty sequence ${index}: send`);
          await send(page, `create clean run ${index}`);
        }
        await page.evaluate(() => { const url = new URL(location.href); url.searchParams.set("run", "s-reconnect"); history.replaceState({ ...history.state, gammaComposerScope: "s-reconnect" }, "", url); dispatchEvent(new PopStateEvent("popstate", { state: history.state })); });
        await ready(page);
        const actual = await field.inputValue();
        if (actual !== "private draft that must stay") throw new Error(`dirty draft became ${JSON.stringify(actual)}`);
        await page.screenshot({ path: join(shots, "blocker-dirty-eviction-1440.png") });
      } finally { await close(context); }
    });

    await check("creation-default-survives-switch-and-reload", async () => {
      const { context, page } = await fresh(browser);
      try {
        await send(page, "create with zeta default");
        await page.getByRole("button", { name: "model: default (gpt-5.1-codex)" }).waitFor({ timeout: 10_000 });
        await choose(page, "claude-sonnet-5"); await page.reload(); await ready(page);
        await page.getByRole("button", { name: "model: claude-sonnet-5" }).click();
        await page.getByRole("option", { name: "default (gpt-5.1-codex)", exact: true }).waitFor();
        if (await page.getByRole("option", { name: "default (claude-sonnet-5)", exact: true }).count()) throw new Error("current override was mislabeled as default");
        await page.screenshot({ path: join(shots, "blocker-default-persistence-1440.png") });
      } finally { await close(context); }
    });

    await check("vim-opt-in-and-running-hint", async () => {
      const { context, page } = await fresh(browser);
      try {
        if (await page.locator(".vim-mode").count()) throw new Error("vim started enabled");
        await page.screenshot({ path: join(shots, "vim-default-off-1440.png") });
        await page.getByRole("button", { name: "settings" }).click(); await page.getByRole("button", { name: /vim keys/ }).click(); await page.keyboard.press("Escape");
        const field = page.locator('.dock textarea[aria-label="message"]'); await field.fill("running hint"); await page.getByRole("button", { name: "send message" }).click();
        await page.getByRole("button", { name: "stop the running turn" }).waitFor();
        const hint = page.locator('[data-part="composer-hint"]'); if (!(await hint.textContent())?.includes("^c to stop")) throw new Error("running hint omits ^c to stop");
        if (await hint.evaluate((node) => node.scrollWidth > node.clientWidth)) throw new Error("running hint is clipped");
        await page.screenshot({ path: join(shots, "composer-running-hint-1440.png") });
        await page.getByRole("button", { name: "stop the running turn" }).click();
      } finally { await close(context); }
    });

    await check("back-during-running-turn-keeps-target-draft", async () => {
      const { context, page } = await fresh(browser);
      try {
        await send(page, "create target run");
        const targetUrl = page.url();
        const field = page.locator('.dock textarea[aria-label="message"]'); await field.fill("draft on target run");
        await page.evaluate(() => { const url = new URL(location.href); url.searchParams.set("run", "s-reconnect"); history.pushState({ ...history.state, gammaComposerScope: "s-reconnect" }, "", url); dispatchEvent(new PopStateEvent("popstate", { state: history.state })); });
        await field.fill("keep this turn running"); await page.getByRole("button", { name: "send message" }).click(); await page.getByRole("button", { name: "stop the running turn" }).waitFor();
        await page.evaluate(() => history.back()); await page.waitForURL(targetUrl); await Bun.sleep(300);
        if (await page.getByText(/could not reopen this run/i).count()) throw new Error("back showed the full reopen banner");
        await page.getByText(/this run waits while .* has the active zeta turn/i).waitFor();
        await page.screenshot({ path: join(shots, "back-running-read-only-1440.png") });
        // The store sequence test proves the hidden target draft remains intact while this read-only view is shown.
      } finally { await close(context); }
    });

    await check("auth-and-stopped-read-only-reasons", async () => {
      const { context, page } = await fresh(browser, "/?run=s-reconnect");
      try {
        await page.getByRole("log", { name: "run activity" }).waitFor();
        await fake.wrongToken(); fake.drop();
        await page.getByText(/controller credential refused/i).waitFor({ timeout: 10_000 });
        await page.screenshot({ path: join(shots, "auth-failed-reason-1440.png") });
        await fake.start(); await page.getByRole("button", { name: "retry now" }).click(); await ready(page);
        await fake.stop();
        await page.getByText(/sending is paused until zeta serve runs again/i).waitFor({ timeout: 10_000 });
        await page.screenshot({ path: join(shots, "stopped-read-only-reason-1440.png") });
      } finally { await fake.start(); await close(context); }
    });

    await check("mobile-composer-has-no-empty-delivery-gap", async () => {
      const { context, page } = await fresh(browser);
      try {
        await page.setViewportSize({ width: 390, height: 844 });
        if (await page.locator('[data-part="delivery-note"]').count()) throw new Error("empty composer renders a delivery note");
        await page.screenshot({ path: join(shots, "mobile-no-delivery-gap-390.png") });
      } finally { await close(context); }
    });

    await check("dark-image-viewer-follows-theme", async () => {
      const { context, page } = await fresh(browser, "/?theme=github-dark");
      try {
        await page.locator('.dock input[type="file"]').setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLkWQAAAABJRU5ErkJggg==", "base64") });
        await page.getByRole("button", { name: "open image: pixel.png" }).click();
        const image = page.locator(".inspector-body > img"); await image.waitFor();
        if (await image.evaluate((node) => getComputedStyle(node).backgroundColor) === "rgb(255, 255, 255)") throw new Error("dark viewer has a white background");
        await page.screenshot({ path: join(shots, "image-viewer-dark-1440.png") });
      } finally { await close(context); }
    });

    if (!process.env.GATE_ONLY) { await check("pending-acceptance-keeps-follow-up-in-own-run", () => pendingNavigation(browser)); await Bun.sleep(3_000); }

    await check("hello-timeout-closes-socket", async () => {
      const { context, page } = await fresh(browser, "/?run=s-reconnect");
      try {
        fake.setMode("slow"); fake.drop();
        await page.getByText(/did not answer/i).waitFor({ timeout: 20_000 });
        await page.screenshot({ path: join(shots, "hello-timeout-closed-1440.png") });
      } finally { fake.setMode("ok"); await close(context); }
    });
  } finally { await browser.close(); }
} finally {
  vite.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolve) => vite.once("exit", () => resolve())), Bun.sleep(2_000)]);
  await fake.close();
}
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log(`round 10: ${passed} passed`);
