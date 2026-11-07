import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { ACTIVE, startFakeZeta } from "./fake-zeta";

// These four browser cases are regression guards; they already pass on b34d5fc.
const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.SETTINGS_GATE_PORT ?? 4331);
const origin = `http://127.0.0.1:${port}`;
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-settings-"));
const fake = await startFakeZeta({ origins: [origin], live: false, serialDelays: {} });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) }, stdio: "ignore" });
const failures: string[] = [];
let passed = 0;

async function waitFor<T>(read: () => T | undefined, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  do { const value = read(); if (value !== undefined) return value; await Bun.sleep(50); } while (Date.now() < end);
  throw new Error("timed out waiting for fake zeta state");
}
async function ready(page: Page) {
  await page.locator('.dock textarea[aria-label^="message"]').waitFor({ timeout: 15_000 });
  await page.locator('button[aria-label^="model:"]').waitFor({ timeout: 15_000 });
}
async function fresh(browser: Browser, run = ACTIVE) {
  const context = await browser.newContext({ viewport: { width: 1080, height: 800 } });
  await context.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  const page = await context.newPage();
  await page.goto(`${origin}/?run=${encodeURIComponent(run)}`);
  await ready(page);
  return { context, page };
}
async function check(name: string, run: () => Promise<void>) {
  if (process.env.GATE_ONLY && process.env.GATE_ONLY !== name) return;
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); failures.push(`${name}: ${message}`); console.log(`FAIL ${name}: ${message}`); }
}
async function chooseModel(page: Page, model: string) {
  await page.locator('button[aria-label^="model:"]').click();
  await page.getByRole("option", { name: model, exact: true }).click();
}
async function expectSettings(page: Page, model: string, mode: "Ask" | "YOLO") {
  const picker = page.locator('button[aria-label^="model:"]');
  await picker.waitFor({ timeout: 15_000 });
  await page.waitForFunction((expected) => document.querySelector('button[aria-label^="model:"]')?.getAttribute("aria-label")?.includes(expected), model, { timeout: 15_000 });
  await page.getByRole("button", { name: new RegExp(`^approval mode: ${mode}`) }).waitFor({ timeout: 15_000 });
}
async function navigate(page: Page, run: string) {
  await page.evaluate((nextRun) => {
    const url = new URL(location.href);
    url.searchParams.set("run", nextRun);
    history.pushState({ gammaEntryId: crypto.randomUUID(), run: nextRun }, "", url);
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, run);
  await page.waitForURL(new RegExp(`run=${encodeURIComponent(run).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
}
async function close(context: BrowserContext) { await context.close(); fake.drop(); await Bun.sleep(200); }

try {
  for (let attempt = 0; ; attempt++) { if (vite.exitCode !== null) throw new Error("vite exited"); if (await fetch(origin).then((response) => response.ok, () => false)) break; if (attempt > 300) throw new Error("vite did not start"); await Bun.sleep(100); }
  const browser = await chromium.launch();
  try {
    await check("failed-write-keeps-confirmed-value-and-retries", async () => {
      fake.setSettings(ACTIVE, { model: "claude-opus-4-6", approval_mode: "ask" });
      const { context, page } = await fresh(browser);
      try {
        await expectSettings(page, "claude-opus-4-6", "Ask");
        fake.failNext("set_settings", "settings write failed");
        const before = fake.requests.filter((request) => request.method === "set_settings").length;
        await chooseModel(page, "gpt-5.1-codex");
        await waitFor(() => fake.requests.filter((request) => request.method === "set_settings").slice(before).some((request) => request.replied !== undefined) ? true : undefined);
        await Bun.sleep(200);
        const alert = await page.getByRole("alert").textContent().catch(() => null);
        if (!alert?.includes("settings write failed")) throw new Error(`failed write did not keep a visible error: ${JSON.stringify(alert)}`);
        const label = await page.locator('button[aria-label^="model:"]').getAttribute("aria-label");
        if (!label?.includes("claude-opus-4-6") || label.includes("gpt-5.1-codex")) throw new Error(`failed write displayed ${label}, not the confirmed model`);
        await chooseModel(page, "gpt-5.1-codex");
        await waitFor(() => fake.settingsFor(ACTIVE)?.model === "gpt-5.1-codex" ? true : undefined);
        await expectSettings(page, "gpt-5.1-codex", "Ask");
        if (await page.getByRole("alert").count()) throw new Error("the settings error remained after a successful retry");
      } finally { await close(context); }
    });

    await check("back-forward-reload-keep-each-run-settings", async () => {
      fake.setSettings(ACTIVE, { model: "gpt-5.1-codex", approval_mode: "allow" });
      fake.setSettings("s-themes", { model: "claude-opus-4-6", approval_mode: "ask" });
      const { context, page } = await fresh(browser);
      try {
        await expectSettings(page, "gpt-5.1-codex", "YOLO");
        await navigate(page, "s-themes"); await expectSettings(page, "claude-opus-4-6", "Ask");
        await page.goBack(); await expectSettings(page, "gpt-5.1-codex", "YOLO");
        await page.goForward(); await expectSettings(page, "claude-opus-4-6", "Ask");
        await page.reload(); await ready(page); await expectSettings(page, "claude-opus-4-6", "Ask");
        const targets = fake.requests.filter((request) => request.method === "session_settings").map((request) => request.params.session_id);
        if (!targets.includes(ACTIVE) || !targets.includes("s-themes")) throw new Error(`settings calls targeted the wrong sessions: ${JSON.stringify(targets)}`);
      } finally { await close(context); }
    });

    await check("running-change-writes-on-idle", async () => {
      fake.setSettings(ACTIVE, { model: "claude-opus-4-6", approval_mode: "ask" });
      const { context, page } = await fresh(browser);
      try {
        await expectSettings(page, "claude-opus-4-6", "Ask");
        const before = fake.requests.filter((request) => request.method === "set_settings").length;
        const field = page.locator('.dock textarea[aria-label="message"]');
        await field.fill("keep this turn running while settings change");
        await page.getByRole("button", { name: "send message" }).click();
        await page.getByRole("button", { name: "stop the running turn" }).waitFor();
        await chooseModel(page, "claude-sonnet-5");
        await page.getByRole("status").filter({ hasText: "model applies to the next turn" }).waitFor();
        await page.getByRole("button", { name: "send message" }).waitFor({ timeout: 20_000 });
        await waitFor(() => fake.settingsFor(ACTIVE)?.model === "claude-sonnet-5" ? true : undefined).catch(() => { throw new Error(`deferred write did not commit: settings=${JSON.stringify(fake.settingsFor(ACTIVE))} requests=${JSON.stringify(fake.requests.filter((request) => request.method === "set_settings"))}`); });
        const writes = fake.requests.filter((request) => request.method === "set_settings").slice(before);
        if (writes.length !== 1) throw new Error(`expected one deferred settings write, got ${writes.length}`);
        if (writes[0]!.running) throw new Error("the settings write reached zeta before the turn became idle");
        if (writes[0]!.params.model !== "claude-sonnet-5") throw new Error(`zeta received ${JSON.stringify(writes[0]!.params)}`);
        await expectSettings(page, "claude-sonnet-5", "Ask");
      } finally { await close(context); }
    });

    await check("slow-old-run-write-stays-with-owner", async () => {
      fake.setSettings(ACTIVE, { model: "claude-opus-4-6", approval_mode: "ask" });
      fake.setSettings("s-themes", { model: "claude-sonnet-5", approval_mode: "allow" });
      const { context, page } = await fresh(browser);
      try {
        await expectSettings(page, "claude-opus-4-6", "Ask");
        fake.delayNext("set_settings", 1_000);
        await chooseModel(page, "gpt-5.1-codex");
        await navigate(page, "s-themes");
        await expectSettings(page, "claude-sonnet-5", "YOLO");
        await waitFor(() => fake.settingsFor(ACTIVE)?.model === "gpt-5.1-codex" ? true : undefined);
        await expectSettings(page, "claude-sonnet-5", "YOLO");
        const write = [...fake.requests].reverse().find((request) => request.method === "set_settings");
        if (write?.params.session_id !== ACTIVE) throw new Error(`slow write targeted ${JSON.stringify(write?.params)}`);
      } finally { await close(context); }
    });
  } finally { await browser.close(); }
} finally {
  vite.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolve) => vite.once("exit", () => resolve())), Bun.sleep(2_000)]);
  await fake.close();
  await rm(gammaHome, { recursive: true, force: true });
}

if (failures.length) throw new Error(`${failures.length} settings state gate(s) failed\n${failures.join("\n")}`);
console.log(`settings state gate: ${passed} passed`);
