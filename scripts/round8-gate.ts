import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.ROUND8_GATE_PORT ?? 4288);
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.WEB_SHOTS ?? join(root, "gate-artifacts", "round8");
await mkdir(shots, { recursive: true });
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-round8-"));
const fake = await startFakeZeta({ origins: [origin], live: false });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin }, stdio: "ignore" });
const failures: string[] = [];

async function waitUntil(test: () => boolean, message: string) {
  for (let attempt = 0; attempt < 200; attempt++) { if (test()) return; await Bun.sleep(50); }
  throw new Error(message);
}
async function fresh(browser: Awaited<ReturnType<typeof chromium.launch>>, width = 1440, theme = "github-light") {
  fake.setEcho(true); fake.clearSent(); fake.setNewSessionSettings(true);
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
  const page = await context.newPage();
  await page.goto(`${origin}/?theme=${theme}`);
  await page.locator('.dock form[data-part="composer"]').waitFor({ timeout: 15_000 });
  if (!await page.getByRole("heading", { name: "new run" }).count()) {
    await page.locator("button.new-run").click();
    await page.getByRole("heading", { name: "new run" }).waitFor();
  }
  await page.locator('button[aria-label^="model:"]').waitFor();
  return { context, page };
}
async function send(page: Page, text: string) {
  await page.locator('.dock textarea[aria-label="message"]').fill(text);
  await page.getByRole("button", { name: "send message" }).click();
}
async function close(context: BrowserContext) { await context.close(); await Bun.sleep(200); }
async function check(name: string, test: () => Promise<void>) {
  try { await test(); console.log(`PASS ${name}`); }
  catch (cause) { const message = cause instanceof Error ? cause.message.split("\n")[0] : String(cause); failures.push(`${name}: ${message}`); console.log(`FAIL ${name}: ${message}`); }
}
function luminance(rgb: number[]) {
  const linear = rgb.map((part) => { const value = part / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; });
  return .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!;
}
function parse(color: string) { return (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number); }
function contrast(a: string, b: string) { const [high, low] = [luminance(parse(a)), luminance(parse(b))].sort((x, y) => y - x); return (high! + .05) / (low! + .05); }
async function auditDialog(page: Page, selector: string) {
  const buttons = page.locator(`${selector} button`);
  for (let index = 0; index < await buttons.count(); index++) {
    const values = await buttons.nth(index).evaluate((node) => { const style = getComputedStyle(node); const surface = getComputedStyle(node.closest('[role="dialog"]')!); return { color: style.color, background: style.backgroundColor, border: style.borderColor, width: style.borderWidth, surface: surface.backgroundColor }; });
    if (contrast(values.color, values.background) < 4.5) throw new Error(`button ${index} text contrast is ${contrast(values.color, values.background).toFixed(2)}`);
    if (values.width === "0px" || (values.border === values.background && contrast(values.background, values.surface) < 3)) throw new Error(`button ${index} has no visible boundary`);
  }
}

try {
  for (let attempt = 0; ; attempt++) { if (vite.exitCode !== null) throw new Error("vite exited"); if (await fetch(origin).then((r) => r.ok, () => false)) break; if (attempt > 300) throw new Error("vite did not start"); await Bun.sleep(100); }
  const browser = await chromium.launch();
  try {
    await check("echo-first-clears-queued-on-failed-turn", async () => {
      const { context, page } = await fresh(browser);
      try { await send(page, "fail this turn after the real echo"); await waitUntil(() => fake.sent.length === 1, "send missing"); await Bun.sleep(1_000); if (await page.getByRole("status", { name: "message queued" }).count()) throw new Error("queued remained after echo-first failed turn"); await page.screenshot({ path: join(shots, "b1-echo-first-failed-1440.png") }); }
      finally { await close(context); }
    });
    await check("reply-first-echo-reconciles", async () => {
      const { context, page } = await fresh(browser, 390);
      try { fake.setEcho(false); await send(page, "hold this turn while the echo is withheld"); await page.getByRole("status", { name: "message queued" }).waitFor(); if (await page.locator('[data-kind="user"]', { hasText: "hold this turn" }).count() !== 1) throw new Error("provisional row duplicated"); fake.flushEchoes(); await page.getByRole("status", { name: "message queued" }).waitFor({ state: "detached", timeout: 10_000 }); if (await page.locator('[data-kind="user"]', { hasText: "hold this turn" }).count() !== 1) throw new Error("echo row duplicated"); await page.screenshot({ path: join(shots, "b1-reply-first-390.png") }); }
      finally { fake.setEcho(true); fake.flushEchoes(); await close(context); }
    });
    await check("stopped-turn-clears-queued", async () => {
      const { context, page } = await fresh(browser);
      try { fake.setEcho(false); await send(page, "long turn to stop"); await page.getByRole("status", { name: "message queued" }).waitFor(); await page.getByRole("button", { name: "stop the running turn" }).click(); await page.getByRole("status", { name: "message queued" }).waitFor({ state: "detached", timeout: 10_000 }); await page.screenshot({ path: join(shots, "b1-stopped-1440.png") }); }
      finally { fake.setEcho(true); fake.flushEchoes(); await close(context); }
    });
    await check("zeta-resolved-default-and-model-listbox", async () => {
      const { context, page } = await fresh(browser, 390);
      try {
        if (await page.locator('button[aria-label="model: default"]').count() !== 1) throw new Error("blank run invented a default model name");
        const picker = page.locator('button[aria-label="model: default"]'); await picker.click();
        const list = page.getByRole("listbox", { name: "model" }); await list.press("ArrowDown");
        const active = await list.getAttribute("aria-activedescendant"); if (!active || !await page.locator(`[id="${active}"]`).getAttribute("data-active")) throw new Error("active option is not exposed and visible");
        await list.press("g"); if (!(await list.getAttribute("aria-activedescendant"))?.endsWith("-3")) throw new Error("typeahead did not select gpt");
        const box = await list.boundingBox(); if (!box || box.x < 0 || box.x + box.width > 390) throw new Error(`model list is outside viewport: ${JSON.stringify(box)}`);
        await list.press("Escape"); await send(page, "fail this turn after model resolution"); await page.getByRole("button", { name: "model: default (gpt-5.1-codex)" }).waitFor({ timeout: 10_000 });
        await page.screenshot({ path: join(shots, "b3-model-resolved-390.png") });
      } finally { await close(context); }
    });
    await check("inspector-mobile-attachments-and-browser-back", async () => {
      const { context, page } = await fresh(browser, 390);
      try {
        await page.locator('.dock input[type="file"]').setInputFiles([1, 2, 3, 4].map((n) => ({ name: `image-${n}.png`, mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71]) })));
        await page.getByRole("button", { name: "open image: image-1.png" }).click();
        await page.getByRole("dialog", { name: "file inspector" }).waitFor();
        await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
        if (!await page.evaluate(() => document.activeElement?.closest('[role="dialog"]')?.getAttribute("aria-label") === "file inspector")) throw new Error("focus escaped the image inspector");
        await page.screenshot({ path: join(shots, "m5-inspector-390.png") });
        await page.keyboard.press("Escape"); await page.getByRole("dialog", { name: "file inspector" }).waitFor({ state: "detached" });
        const strip = await page.locator(".attachments").boundingBox(); if (!strip || strip.height > 90) throw new Error(`attachment strip is ${strip?.height}px tall`);
        await page.screenshot({ path: join(shots, "minor-attachments-390.png") });
        await page.goto(`${origin}/?run=s-reconnect&theme=github-light`); await page.locator("button.new-run").waitFor(); await page.locator("button.new-run").click();
        if (new URL(page.url()).searchParams.has("run")) throw new Error("new run did not clear the run URL");
        await page.goBack(); if (new URL(page.url()).searchParams.get("run") !== "s-reconnect") throw new Error("Back did not restore the previous run URL");
      } finally { await close(context); }
    });
    await check("confirmation-contrast-and-boundaries", async () => {
      for (const theme of ["github-light", "github-dark", "dracula", "solarized-light"]) for (const width of [1440, 390]) {
        const { context, page } = await fresh(browser, width, theme);
        try {
          await page.getByRole("button", { name: /^approval mode: Ask/ }).click(); await auditDialog(page, ".confirm-popover");
          if (await page.evaluate(() => document.activeElement?.textContent) !== "keep asking") throw new Error("YOLO dialog focuses the risky action");
          await page.screenshot({ path: join(shots, `b2-yolo-${theme}-${width}.png`) }); await page.keyboard.press("Escape");
          await send(page, "long turn for new run dialog");
          await waitUntil(() => fake.sent.length === 1, "the dialog turn did not reach zeta");
          await page.locator('button.new-run:not([disabled])').click(); await auditDialog(page, ".confirm-dialog");
          if (await page.evaluate(() => document.activeElement?.textContent) !== "cancel") throw new Error("new-run dialog focuses the destructive action");
          await page.screenshot({ path: join(shots, `b2-new-run-${theme}-${width}.png`) });
          await page.getByRole("button", { name: "cancel" }).click();
          await page.getByRole("button", { name: "stop the running turn" }).click();
          await Bun.sleep(300);
        } finally { await close(context); }
      }
    });
  } finally { await browser.close(); }
} finally { vite.kill("SIGTERM"); await fake.close(); }
if (failures.length) { console.error(`\n${failures.length} round 8 gate check(s) failed`); process.exit(1); }
console.log("\nround 8 gate passed: 6 checks");
