import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.ROUND7_GATE_PORT ?? 4184);
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.WEB_SHOTS ?? join(root, "gate-artifacts");
await mkdir(shots, { recursive: true });
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-round7-"));
const fake = await startFakeZeta({ origins: [origin], live: false });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin }, stdio: "ignore" });
const failures: string[] = [];

async function freshPage(browser: Awaited<ReturnType<typeof chromium.launch>>, viewport = { width: 1440, height: 900 }, newSessionSettings = true) {
  fake.setEmpty(false);
  fake.setNewSessionSettings(newSessionSettings);
  fake.setEcho(true);
  fake.clearSent();
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${origin}/?theme=tokyo-night`);
  await page.locator('.dock form[data-part="composer"]').waitFor({ timeout: 15_000 }).catch(() => { throw new Error("the fresh browser did not reach an editable composer"); });
  if (!await page.getByRole("heading", { name: "new run" }).count()) {
    const newRun = page.locator("button.new-run");
    await newRun.waitFor();
    if (await newRun.isDisabled()) throw new Error("the open run cannot start a new run");
    await newRun.evaluate((button) => (button as HTMLButtonElement).click());
    await page.getByRole("heading", { name: "new run" }).waitFor({ timeout: 10_000 });
  }
  await page.locator('button[aria-label^="model:"]').waitFor({ timeout: 15_000 }).catch(() => { throw new Error("the new run did not show a model picker"); });
  return { context, page };
}

async function closePage(context: BrowserContext) {
  await context.close();
  await Bun.sleep(300);
}

async function send(page: Page, message: string) {
  await page.locator('.dock textarea[aria-label="message"]').fill(message);
  await page.getByRole("button", { name: "send message" }).click();
}

async function waitUntil(condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await Bun.sleep(50);
  }
  throw new Error(message);
}

async function check(name: string, run: () => Promise<void>) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (cause) {
    const message = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    failures.push(`${name}: ${message}`);
    console.log(`FAIL ${name}: ${message}`);
  }
}

try {
  for (let attempt = 0; ; attempt++) {
    if (vite.exitCode !== null) throw new Error("vite exited");
    if (await fetch(origin).then((response) => response.ok, () => false)) break;
    if (attempt > 600) throw new Error("vite did not start");
    await Bun.sleep(100);
  }
  const browser = await chromium.launch();
  try {
    await check("first-turn-default-settings-delivery", async () => {
      const { context, page } = await freshPage(browser);
      try {
        await page.getByRole("button", { name: /^approval mode: Ask/ }).waitFor();
        await send(page, "fail this turn after the default-model first message");
        await waitUntil(() => fake.sent.length === 1, `fake zeta received ${fake.sent.length} messages, expected 1`);
        if (fake.settings.model !== "gpt-5.1-codex" || fake.settings.approval_mode !== "ask") throw new Error(`created with ${fake.settings.model}/${fake.settings.approval_mode}`);
      } finally { await closePage(context); }
    });

    await check("near-limit-image-delivery", async () => {
      const { context, page } = await freshPage(browser);
      try {
        await page.locator('.dock input[type="file"]').setInputFiles({ name: "near-limit.png", mimeType: "image/png", buffer: Buffer.alloc(500 * 1024) });
        await page.getByRole("button", { name: "remove near-limit.png" }).waitFor({ timeout: 10_000 }).catch(() => { throw new Error("the 500 KiB image was not attached"); });
        await send(page, "fail this turn after the near-limit image");
        await waitUntil(() => fake.imageSends.length === 1 && fake.sent.length === 1, `fake zeta received ${fake.imageSends.length} image sends and ${fake.sent.length} messages`);
        await page.getByText("fail this turn after the near-limit image", { exact: true }).waitFor({ timeout: 10_000 }).catch(() => { throw new Error("the near-limit image message was not shown as delivered"); });
        const data = String((fake.imageSends[0]!.images as Array<{ data: string }>)[0]!.data);
        if (data.length < 680_000) throw new Error(`encoded image was only ${data.length} base64 characters`);
      } finally { await closePage(context); }
    });

    await check("resolved-default-model-remains-selected", async () => {
      const { context, page } = await freshPage(browser, { width: 1440, height: 900 }, false);
      try {
        await send(page, "fail this turn after checking the resolved default");
        await waitUntil(() => fake.sent.length === 1, `fake zeta received ${fake.sent.length} messages, expected 1`);
        await Bun.sleep(500);
        const picker = page.getByRole("button", { name: "model: default (gpt-5.1-codex)" });
        await picker.waitFor({ timeout: 10_000 }).catch(async () => { throw new Error(`the picker shows ${await page.locator('button[aria-label^="model:"]').getAttribute("aria-label")}, not the resolved default`); });
        await picker.click();
        const option = page.getByRole("option", { name: "default (gpt-5.1-codex)" });
        await option.waitFor();
        if (await option.getAttribute("aria-selected") !== "true") throw new Error("the resolved default option is not selected");
      } finally { await closePage(context); }
    });

    await check("withheld-echo-queued-row-reconciles", async () => {
      const { context, page } = await freshPage(browser);
      try {
        fake.setEcho(false);
        const message = "hold this turn while the echo is withheld";
        await send(page, message);
        await waitUntil(() => fake.sent.length === 1, `fake zeta received ${fake.sent.length} messages, expected 1`);
        await page.getByRole("status", { name: "message queued" }).waitFor({ timeout: 2_000 }).catch(async () => { throw new Error(`queued status never appeared while the echo was withheld; rows=${JSON.stringify(await page.locator('[data-kind="user"]').evaluateAll((rows) => rows.map((row) => ({ id: (row as HTMLElement).dataset.id, text: row.textContent }))))}`); });
        if (await page.locator('[data-kind="user"]', { hasText: message }).count() !== 1) throw new Error("queued message is not exactly one row");
        await page.screenshot({ path: join(shots, "queued-withheld-echo-1440.png") });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("status", { name: "message queued" }).waitFor();
        await page.screenshot({ path: join(shots, "queued-withheld-echo-390.png") });
        fake.flushEchoes();
        await page.getByRole("status", { name: "message queued" }).waitFor({ state: "detached", timeout: 10_000 }).catch(() => { throw new Error("queued status remained after the echo arrived"); });
        if (await page.locator('[data-kind="user"]', { hasText: message }).count() !== 1) throw new Error("echo created a duplicate user row");
      } finally { fake.setEcho(true); fake.flushEchoes(); await closePage(context); }
    });
  } finally { await browser.close(); }
} finally {
  vite.kill("SIGTERM");
  await fake.close();
}

if (failures.length) {
  console.error(`\n${failures.length} round 7 gate check(s) failed`);
  process.exit(1);
}
console.log("\nround 7 gate passed: 4 checks");
