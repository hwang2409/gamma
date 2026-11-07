import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.NAVIGATION_GATE_PORT ?? 4311);
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.WEB_SHOTS ?? join(root, "gate-artifacts", "navigation");
await mkdir(shots, { recursive: true });
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-navigation-"));
const fake = await startFakeZeta({ origins: [origin], live: false, serialDelays: { send: Array(20).fill(3_000), new_session: Array(20).fill(3_000) } });
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
  await field.fill(text); await page.locator('button[aria-label="send message"]').click({ force: true });
  const stop = page.getByRole("button", { name: "stop the running turn" });
  await stop.waitFor(); await stop.click();
  await page.getByRole("button", { name: "send message" }).waitFor();
}
async function rectInside(page: Page, selector: string) {
  const rect = await page.locator(selector).boundingBox();
  if (!rect || rect.x < 0 || rect.x + rect.width > page.viewportSize()!.width) throw new Error(`${selector} is outside viewport: ${JSON.stringify(rect)}`);
}
async function queuedSteerSequence(browser: Awaited<ReturnType<typeof chromium.launch>>, width: number, stopped: boolean) {
  fake.clearSent();
  const { context, page } = await fresh(browser, width);
  try {
    const field = page.locator('.dock textarea[aria-label="message"]');
    await field.fill(`owner turn ${stopped ? "stop" : "natural"}`); await page.locator('button[aria-label="send message"]').click({ force: true });
    await page.getByRole("button", { name: "stop the running turn" }).waitFor({ timeout: 15_000 });
    await field.fill(`queued steer ${stopped ? "stop" : "natural"}`); await page.getByRole("button", { name: "steer the running turn" }).click();
    if (stopped) {
      await page.getByRole("button", { name: "stop the running turn" }).click();
      await page.getByText(/not delivered/i).waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: "resend" }).click();
    } else {
      const owner = page.url();
      await page.getByRole("button", { name: "new run" }).click();
      await page.getByText(/new run waits for the running run/i).waitFor();
      for (let attempt = 0; attempt < 150 && !fake.sent.some((sent) => sent.method === "send" && sent.text === "queued steer natural"); attempt++) await Bun.sleep(200);
      await page.goBack(); await page.waitForURL(owner);
    }
    await page.waitForFunction((text) => document.body.innerText.includes(String(text)), `queued steer ${stopped ? "stop" : "natural"}`, { timeout: 15_000 });
    for (let attempt = 0; attempt < 50 && !fake.sent.some((sent) => sent.method === "send" && sent.text === `queued steer ${stopped ? "stop" : "natural"}`); attempt++) await Bun.sleep(200);
    if (!fake.sent.some((sent) => sent.method === "steer" && sent.text === `queued steer ${stopped ? "stop" : "natural"}`)) throw new Error("steer was not queued for its owner run");
    if (!fake.sent.some((sent) => sent.method === "send" && sent.text === `queued steer ${stopped ? "stop" : "natural"}`)) throw new Error(stopped ? "manual resend did not send the stopped steer" : "natural turn end did not resend the dropped steer");
  } finally { await context.close(); fake.drop(); await Bun.sleep(500); }
}

async function pendingCreateSequence(browser: Awaited<ReturnType<typeof chromium.launch>>, width: number) {
  const { context, page } = await fresh(browser, width, "/?run=s-themes");
  try {
    const runA = page.url();
    await page.getByRole("button", { name: "new run" }).click();
    const temporary = page.url();
    if (!temporary.includes("run=draft%3A")) throw new Error(`new run did not get an immediate draft history entry: ${temporary}`);
    const field = page.locator('.dock textarea[aria-label="message"]');
    await field.fill("pending first send C"); await page.locator('button[aria-label="send message"]').click({ force: true });
    await page.goBack(); await page.waitForURL(runA);
    if (await field.inputValue() === "pending first send C") throw new Error("pending C draft appeared under A");
    await Bun.sleep(3_500);
    if (page.url() !== runA) throw new Error(`background create replaced A's entry: ${page.url()}`);
    await page.goForward();
    await page.waitForURL((url) => url.searchParams.get("run")?.startsWith("s-new-") ?? false);
    await page.getByRole("log", { name: "run activity" }).getByText("pending first send C", { exact: true }).waitFor({ timeout: 15_000 });
    await page.goBack(); await page.waitForURL(runA);
  } finally { await context.close(); fake.drop(); await Bun.sleep(500); }
}

async function uncachedNavigationSequence(browser: Awaited<ReturnType<typeof chromium.launch>>, width: number) {
  const { context, page } = await fresh(browser, width, "/?run=s-reconnect");
  try {
    const field = page.locator('.dock textarea[aria-label="message"]');
    await field.fill("active run marker");
    await page.locator('button[aria-label="send message"]').click({ force: true });
    await page.getByRole("button", { name: "stop the running turn" }).waitFor();
    await page.evaluate(() => {
      const url = new URL(location.href);
      url.searchParams.set("run", "s-themes");
      history.pushState({ gammaComposerScope: "s-themes" }, "", url);
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    });
    await page.waitForURL(/run=s-themes/);
    if (await page.getByRole("log", { name: "run activity" }).getByText("active run marker", { exact: true }).count())
      throw new Error("uncached target showed the active run transcript");
    if (await page.getByRole("button", { name: "stop the running turn" }).count())
      throw new Error("uncached target exposed the active run stop control");
    const resume = [...fake.requests].reverse().find((request) => request.method === "resume");
    const settings = [...fake.requests].reverse().find((request) => request.method === "session_settings");
    if (settings && (!resume?.replied || settings.started < resume.replied)) throw new Error("settings loaded before resume completed");
  } finally {
    const stop = page.getByRole("button", { name: "stop the running turn" });
    if (await stop.count()) await stop.click().catch(() => {});
    await context.close(); fake.drop(); await Bun.sleep(500);
  }
}

async function navigationSequence(browser: Awaited<ReturnType<typeof chromium.launch>>, width: number) {
  const { context, page } = await fresh(browser, width);
  try {
    await stopAfterSend(page, "run A first turn");
    const runA = page.url();
    const field = page.locator('.dock textarea[aria-label="message"]');
    await field.fill("draft kept in A");
    await page.getByRole("button", { name: "new run" }).click();
    await field.fill("run B long turn"); await page.locator('button[aria-label="send message"]').click({ force: true });
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
    await page.getByRole("button", { name: "stop the running turn" }).click();
    await page.waitForFunction(() => { const button = document.querySelector('button[aria-label="send message"]'); return button && button.getAttribute("aria-disabled") !== "true"; }, undefined, { timeout: 15_000 });

    await field.fill("run B chained turn"); await page.locator('button[aria-label="send message"]').click({ force: true });
    await page.getByRole("button", { name: "stop the running turn" }).waitFor();
    await page.getByRole("button", { name: "new run" }).click();
    await page.getByText(/new run waits for the running run/i).waitFor();
    await field.fill("draft while B runs");
    await page.goBack(); await page.waitForURL(runB);
    await page.goBack(); await page.waitForURL(runA);
    await page.locator(".dock textarea").waitFor({ timeout: 15_000 });
    await page.goForward(); await page.waitForURL(runB);
    await field.fill("editable after stop");
    if (await field.inputValue() !== "editable after stop") throw new Error("run B stayed locked after stop");
    await page.screenshot({ path: join(shots, `displayed-run-navigation-${width}.png`) });
    await page.goForward(); await page.waitForURL(/run=draft%3A/);
    if (await field.inputValue() !== "draft while B runs") throw new Error("draft history entry did not retain its own text");
    await Bun.sleep(200);
    const storedDrafts = await page.evaluate(() => sessionStorage.getItem("gamma-run-drafts"));
    if (!storedDrafts?.includes("draft while B runs")) throw new Error(`draft was not persisted before reload: ${storedDrafts}`);
    await page.reload();
    const reloaded = page.locator(".dock textarea"); await reloaded.waitFor();
    if (await reloaded.isDisabled() || await reloaded.getAttribute("readonly") !== null) throw new Error("reloaded draft became read-only while B runs");
    if (await reloaded.inputValue() !== "draft while B runs") throw new Error("text-only draft did not survive reload");
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
    await check("natural-end-resends-owner-steer-at-1440", () => queuedSteerSequence(browser, 1440, false));
    await check("natural-end-resends-owner-steer-at-390", () => queuedSteerSequence(browser, 390, false));
    await check("stop-marks-owner-steer-at-1440", () => queuedSteerSequence(browser, 1440, true));
    await check("stop-marks-owner-steer-at-390", () => queuedSteerSequence(browser, 390, true));
    await check("pending-create-history-at-1440", () => pendingCreateSequence(browser, 1440));
    await check("pending-create-history-at-390", () => pendingCreateSequence(browser, 390));
    await check("uncached-run-follows-url-at-1440", () => uncachedNavigationSequence(browser, 1440));
    await check("uncached-run-follows-url-at-390", () => uncachedNavigationSequence(browser, 390));
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
console.log(`navigation/activity: ${passed} passed`);
