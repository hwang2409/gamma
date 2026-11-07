import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.DELIVERY_GATE_PORT ?? 4321);
const origin = `http://127.0.0.1:${port}`;
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-delivery-"));
const fake = await startFakeZeta({ origins: [origin], live: false });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) }, stdio: "ignore" });
const failures: string[] = [];
let passed = 0;

async function ready(page: Page) { try { await page.locator('.dock textarea[aria-label^="message"]').waitFor({ timeout: 15_000 }); } catch (error) { throw new Error(`${String(error)}\n${(await page.locator("body").innerText()).slice(0, 2_000)}`); } }
async function fresh(browser: Browser, width = 1080) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
  const page = await context.newPage();
  await page.goto(origin); await ready(page);
  return { context, page };
}
async function check(name: string, run: () => Promise<void>) {
  if (process.env.GATE_ONLY && process.env.GATE_ONLY !== name) return;
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); failures.push(`${name}: ${message}`); console.log(`FAIL ${name}: ${message}`); }
}
async function startQueued(page: Page, suffix: string) {
  const field = page.locator('.dock textarea[aria-label="message"]');
  await field.fill(`use a tool ${suffix}`); await page.getByRole("button", { name: "send message" }).click();
  await page.getByRole("button", { name: "stop the running turn" }).waitFor({ timeout: 15_000 });
  await field.fill(`queued ${suffix}`); await page.getByRole("button", { name: "steer the running turn" }).click();
  await page.getByLabel(/message queued/i).waitFor({ timeout: 10_000 });
  return field;
}
async function waitForSent(text: string, method = "send") {
  for (let attempt = 0; attempt < 100 && !fake.sent.some((item) => item.method === method && item.text === text); attempt++) await Bun.sleep(200);
  const matching = fake.sent.filter((item) => item.method === method && item.text === text);
  if (matching.length !== 1) throw new Error(`expected one ${method} for ${JSON.stringify(text)}, got ${matching.length}: ${JSON.stringify(fake.sent)}`);
}
async function cleanup(context: BrowserContext, page: Page) {
  await page.getByRole("button", { name: "stop the running turn" }).click({ timeout: 1_000 }).catch(() => {});
  await context.close(); fake.drop(); await Bun.sleep(300); fake.clearSent();
}

try {
  for (let attempt = 0; ; attempt++) { if (vite.exitCode !== null) throw new Error("vite exited"); if (await fetch(origin).then((response) => response.ok, () => false)) break; if (attempt > 300) throw new Error("vite did not start"); await Bun.sleep(100); }
  const browser = await chromium.launch();
  try {
    await check("queued-reload-natural-drop-resends-once", async () => {
      const { context, page } = await fresh(browser);
      try { await startQueued(page, "reload natural"); await page.reload(); await ready(page); await waitForSent("queued reload natural"); }
      finally { await cleanup(context, page); }
    });
    for (const width of [1440, 390]) await check(`explicit-stop-mark-survives-navigation-and-reload-${width}`, async () => {
      const { context, page } = await fresh(browser, width);
      try {
        await startQueued(page, "explicit stop");
        const owner = page.url(); await page.getByRole("button", { name: "stop the running turn" }).click();
        await page.locator('.undelivered[role="note"]').waitFor({ timeout: 10_000 });
        await page.locator('.status-line[data-state="ready"]').waitFor({ timeout: 10_000 });
        if (await page.locator('[data-part="composer-message"]', { hasText: "sending" }).count()) throw new Error(`idle composer still said sending at ${width}`);
        await page.getByRole("button", { name: "new run" }).click(); await page.goBack(); await page.waitForURL(owner);
        await page.reload(); await ready(page); await page.locator('.undelivered[role="note"]').waitFor({ timeout: 10_000 });
        await page.getByRole("button", { name: "resend" }).click(); await waitForSent("queued explicit stop");
      } finally { await cleanup(context, page); }
    });
    await check("disconnect-spanning-turn-end-resends-once", async () => {
      const { context, page } = await fresh(browser);
      try {
        await startQueued(page, "disconnect"); fake.drop(); await page.reload(); await ready(page);
        await waitForSent("queued disconnect");
        if ((await page.locator("body").innerText()).includes("content must be an array")) throw new Error("terminal delivery history failed fulcrum adaptation");
      } finally { await cleanup(context, page); }
    });
    await check("delayed-retry-blocks-and-orders-second-submit", async () => {
      const { context, page } = await fresh(browser);
      try {
        const field = await startQueued(page, "delayed retry"); fake.delayNext("send", 3_000);
        await page.getByLabel("message retrying").waitFor({ timeout: 15_000 });
        const action = page.locator('[data-part="composer-submit"]');
        if (await action.getAttribute("aria-disabled") !== "true") throw new Error("submit stayed enabled during retry");
        await field.fill("second after retry"); await action.click({ force: true }); await Bun.sleep(300);
        if (fake.sent.some((item) => item.text === "second after retry")) throw new Error("second submit overtook the delayed retry");
        await waitForSent("queued delayed retry");
        await page.getByRole("button", { name: /steer the running turn|send message/ }).click();
        await waitForSent("second after retry", "steer");
        const order = fake.sent.map((item) => item.text);
        if (order.indexOf("queued delayed retry") > order.indexOf("second after retry")) throw new Error(`second submit was out of order: ${JSON.stringify(order)}`);
      } finally { await cleanup(context, page); }
    });
  } finally { await browser.close(); }
} finally {
  vite.kill("SIGTERM"); await Promise.race([new Promise<void>((resolve) => vite.once("exit", () => resolve())), Bun.sleep(2_000)]);
  await fake.close(); await rm(gammaHome, { recursive: true, force: true });
}
if (failures.length) throw new Error(`${failures.length} delivery gate(s) failed\n${failures.join("\n")}`);
console.log(`delivery state gate: ${passed} passed`);
