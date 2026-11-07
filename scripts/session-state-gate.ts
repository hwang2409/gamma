import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.SESSION_GATE_PORT ?? 4341);
const origin = `http://127.0.0.1:${port}`;
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-session-state-"));
const fake = await startFakeZeta({ origins: [origin], live: true });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) }, stdio: "ignore" });
const failures: string[] = [];
let passed = 0;
for (let attempt = 0; attempt < 100; attempt++) {
  try { if ((await fetch(origin)).ok) break; } catch {}
  if (attempt === 99) throw new Error("vite did not start");
  await Bun.sleep(100);
}

async function ready(page: Page) { await page.locator('.dock textarea[aria-label^="message"]').waitFor({ timeout: 15_000 }); }
async function fresh(browser: Browser, width: number, path = "/") {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
  await context.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`);
  await ready(page);
  return { context, page };
}
async function check(name: string, run: () => Promise<void>) {
  if (process.env.GATE_ONLY && process.env.GATE_ONLY !== name) return;
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); failures.push(`${name}: ${message}`); console.log(`FAIL ${name}: ${message}`); }
}
async function waitForIdle() {
  for (let attempt = 0; attempt < 100 && fake.running; attempt++) await Bun.sleep(100);
  if (fake.running) throw new Error("fake zeta did not finish the approved turn");
}
async function poll(check: () => Promise<boolean>, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt++) { if (await check()) return true; await Bun.sleep(100); }
  return false;
}

for (const width of [1440, 390]) await check(`approved reloaded owner becomes idle after new-run navigation at ${width}`, async () => {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await fresh(browser, width, "/?run=s-reconnect");
  try {
    await page.getByRole("button", { name: "approve" }).waitFor({ timeout: 15_000 });
    await page.reload();
    await page.getByRole("button", { name: "approve" }).waitFor({ timeout: 15_000 });
    const owner = page.url();
    await page.getByRole("button", { name: "new run" }).click();
    await page.goBack();
    await page.waitForURL(owner);
    await page.getByRole("button", { name: "approve" }).click();
    await waitForIdle();
    if (!await poll(async () => await page.getByRole("button", { name: "send message" }).count() > 0)) throw new Error("send remained unavailable after zeta finished");
    if (await page.getByRole("button", { name: "stop the running turn" }).count()) throw new Error("stop remained after zeta finished");
    if (await page.getByText(/live updates paused/i).count()) throw new Error("snapshot-only notice remained after zeta finished");
    const status = await page.locator(".status-line").getAttribute("data-state");
    if (status !== "ready") throw new Error(`status stayed ${status ?? "missing"} after zeta finished`);
  } finally { await context.close(); await browser.close(); fake.setLive(false); fake.setLive(true); fake.drop(); await Bun.sleep(300); await fake.start(); }
});

await check("one transient busy resume retries and opens", async () => {
  fake.busyNext("resume", 1);
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await fresh(browser, 1440, "/?run=s-themes");
  try {
    const opened = await poll(async () => await page.getByRole("log", { name: "run activity" }).getByText(/check every theme/, { exact: false }).count() > 0);
    if (!opened) throw new Error(`transient resume did not retry; panel=${await page.locator("main").innerText()}`);
  } finally { await context.close(); await browser.close(); }
});

await check("one transient busy new session retries and starts", async () => {
  fake.busyNext("new_session", 1);
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await fresh(browser, 1440);
  try {
    await page.locator('.dock textarea[aria-label="message"]').fill("retry transient create");
    await page.getByRole("button", { name: "send message" }).click();
    const created = await poll(async () => new URL(page.url()).searchParams.get("run")?.startsWith("s-new-") ?? false);
    if (!created) throw new Error(`transient new_session did not retry; url=${page.url()} body=${await page.locator("main").innerText()}`);
    await page.getByRole("log", { name: "run activity" }).getByText("retry transient create", { exact: true }).waitFor({ timeout: 15_000 });
  } finally { const stop = page.getByRole("button", { name: "stop the running turn" }); await stop.click().catch(() => {}); await context.close(); await browser.close(); }
});

await check("three busy resumes show the busy panel", async () => {
  fake.busyNext("resume", 3);
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await fresh(browser, 1440, "/?run=s-docs");
  try { await page.getByRole("heading", { name: "another run is active" }).waitFor({ timeout: 15_000 }); }
  finally { await context.close(); await browser.close(); }
});

vite.kill("SIGTERM");
await Promise.race([new Promise<void>((resolve) => vite.once("exit", () => resolve())), Bun.sleep(2_000)]);
await fake.close();
await rm(gammaHome, { recursive: true, force: true });
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log(`session state: ${passed} passed`);
