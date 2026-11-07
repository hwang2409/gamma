import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.ROUND11_GATE_PORT ?? 4311);
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.WEB_SHOTS ?? join(root, "gate-artifacts", "round11");
await mkdir(shots, { recursive: true });
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-round11-"));
const fake = await startFakeZeta({ origins: [origin], live: false, serialDelays: { send: Array(20).fill(3_000) } });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin }, stdio: "ignore" });
const failures: string[] = [];
let passed = 0;

async function ready(page: Page) { await page.locator('.dock textarea[aria-label^="message"]').waitFor({ timeout: 15_000 }); }
async function fresh(browser: Awaited<ReturnType<typeof chromium.launch>>, width: number, path = "/") {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
  await context.addInitScript(() => localStorage.clear());
  const page = await context.newPage();
  await page.goto(`${origin}${path}`); await ready(page);
  return { context, page };
}
async function check(name: string, run: () => Promise<void>) {
  if (process.env.GATE_ONLY && process.env.GATE_ONLY !== name) return;
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); failures.push(`${name}: ${message}`); console.log(`FAIL ${name}: ${message}`); }
}
async function stopAfterSend(page: Page, text: string) {
  const field = page.locator('.dock textarea[aria-label="message"]');
  await field.fill(text); await page.getByRole("button", { name: "send message" }).click();
  const stop = page.getByRole("button", { name: "stop the running turn" });
  await stop.waitFor(); await stop.click();
  await page.getByRole("button", { name: "send message" }).waitFor();
}
async function rectInside(page: Page, selector: string) {
  const rect = await page.locator(selector).boundingBox();
  if (!rect || rect.x < 0 || rect.x + rect.width > page.viewportSize()!.width) throw new Error(`${selector} is outside viewport: ${JSON.stringify(rect)}`);
}
async function navigationSequence(browser: Awaited<ReturnType<typeof chromium.launch>>, width: number) {
  const { context, page } = await fresh(browser, width);
  try {
    await stopAfterSend(page, "run A first turn");
    const runA = page.url();
    const field = page.locator('.dock textarea[aria-label="message"]');
    await field.fill("draft kept in A");
    await page.getByRole("button", { name: "new run" }).click();
    await field.fill("run B long turn"); await page.getByRole("button", { name: "send message" }).click();
    await page.getByRole("button", { name: "stop the running turn" }).waitFor();
    const runB = page.url();
    const hint = page.locator('[data-part="composer-hint"]');
    if (await hint.evaluate((node) => node.scrollWidth > node.clientWidth)) throw new Error("running composer hint is clipped");
    await page.locator('button[aria-label^="model:"]').click();
    await page.getByRole("option", { name: "claude-opus-4-6", exact: true }).click();
    await page.getByText("model applies to the next turn").waitFor();
    await field.fill("draft in B while running");
    await page.screenshot({ path: join(shots, `model-next-turn-${width}.png`) });

    await page.goBack(); await page.waitForURL(runA);
    await page.getByRole("log", { name: "run activity" }).getByText("run A first turn", { exact: true }).waitFor();
    if (await page.getByRole("log", { name: "run activity" }).getByText("run B long turn", { exact: true }).count()) throw new Error("back showed run B transcript under run A url");
    const readOnly = page.locator('.dock textarea[aria-label="message (draft, read-only)"]');
    if (await readOnly.inputValue() !== "draft kept in A") throw new Error("back did not show run A draft");

    await page.goForward(); await page.waitForURL(runB);
    await page.getByRole("log", { name: "run activity" }).getByText("run B long turn", { exact: true }).waitFor();
    if (await field.inputValue() !== "draft in B while running") throw new Error("forward did not restore run B draft");
    await page.getByRole("button", { name: "stop the running turn" }).waitFor();
    await field.focus(); await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "send message" }).waitFor({ timeout: 15_000 });

    await field.fill("run B chained turn"); await page.getByRole("button", { name: "send message" }).click();
    await page.getByRole("button", { name: "stop the running turn" }).waitFor();
    await page.getByRole("button", { name: "new run" }).click();
    await page.getByRole("dialog", { name: "stop the running turn?" }).waitFor();
    await page.keyboard.press("Escape");
    await page.goBack(); await page.waitForURL(runA);
    await page.locator('.dock textarea[aria-label="message"]').waitFor({ timeout: 15_000 });
    await page.goForward(); await page.waitForURL(runB);
    await field.fill("editable after stop");
    if (await field.inputValue() !== "editable after stop") throw new Error("run B stayed locked after stop");
    await page.screenshot({ path: join(shots, `displayed-run-navigation-${width}.png`) });
  } finally {
    const stop = page.getByRole("button", { name: "stop the running turn" });
    if (await stop.count()) await stop.click().catch(() => {});
    await context.close(); fake.drop(); await Bun.sleep(500);
  }
}

try {
  for (let attempt = 0; ; attempt++) { if (vite.exitCode !== null) throw new Error("vite exited"); if (await fetch(origin).then((r) => r.ok, () => false)) break; if (attempt > 300) throw new Error("vite did not start"); await Bun.sleep(100); }
  const browser = await chromium.launch();
  try {
    await check("displayed-run-follows-url-at-1440", () => navigationSequence(browser, 1440));
    await check("displayed-run-follows-url-at-390", () => navigationSequence(browser, 390));
    await check("narrow-popovers-stay-in-viewport", async () => {
      const { context, page } = await fresh(browser, 390);
      try {
        await page.getByRole("button", { name: "settings" }).click();
        await rectInside(page, ".settings-popover");
        await page.locator(".theme-button").click();
        await rectInside(page, ".theme-list");
        await page.screenshot({ path: join(shots, "settings-popovers-390.png") });
      } finally { await context.close(); fake.drop(); await Bun.sleep(200); }
    });
    await check("compact-protocol-notice-names-the-remedy", async () => {
      const { context, page } = await fresh(browser, 390, "/?run=s-reconnect");
      try {
        await page.getByRole("log", { name: "run activity" }).waitFor();
        fake.setMode("incompatible"); fake.drop();
        await page.getByText("unsupported protocol version").waitFor({ timeout: 15_000 });
        const body = await page.locator("body").innerText();
        if (!body.includes("zeta serve does not speak protocol 1.2; update zeta")) throw new Error(`protocol remedy missing: ${body}`);
        await page.screenshot({ path: join(shots, "protocol-reason-390.png") });
      } finally { fake.setMode("ok"); await context.close(); fake.drop(); await Bun.sleep(500); }
    });
    await check("hello-timeout-reason-persists-while-retrying", async () => {
      const { context, page } = await fresh(browser, 390);
      try {
        fake.setMode("slow"); fake.drop();
        const reason = page.getByText(/did not answer/i).first();
        await reason.waitFor({ timeout: 20_000 }); await Bun.sleep(2_000);
        if (!await reason.isVisible()) throw new Error(`hello-timeout reason disappeared during retry: ${await page.locator("body").innerText()}`);
        await page.screenshot({ path: join(shots, "hello-timeout-persistent-390.png") });
      } finally { fake.setMode("ok"); await context.close(); fake.drop(); await Bun.sleep(500); }
    });
    await check("outage-keeps-draft-editable", async () => {
      const { context, page } = await fresh(browser, 390);
      try {
        const field = page.locator('.dock textarea[aria-label="message"]');
        await field.fill("draft before outage"); await fake.close();
        await page.getByText(/sending is paused/i).waitFor({ timeout: 15_000 });
        await field.fill("draft typed during outage");
        if (await field.inputValue() !== "draft typed during outage") throw new Error("outage made draft read-only");
        if (await page.getByRole("button", { name: "send message" }).getAttribute("aria-disabled") !== "true") throw new Error("send stayed enabled during outage");
        await page.screenshot({ path: join(shots, "outage-editable-draft-390.png") });
      } finally { await context.close(); }
    });
  } finally { await browser.close(); }
} finally {
  vite.kill("SIGTERM"); await Promise.race([new Promise<void>((resolve) => vite.once("exit", () => resolve())), Bun.sleep(2_000)]);
  await fake.close(); await rm(gammaHome, { recursive: true, force: true });
}
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log(`round 11: ${passed} passed`);
