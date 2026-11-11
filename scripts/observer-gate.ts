import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import { CHILD_HOLD, startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.OBSERVER_GATE_PORT ?? 4357);
const origin = `http://127.0.0.1:${port}`;
const screenshots = process.env.OBSERVER_SCREENSHOTS;
const runId = "s-themes";
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-observer-gate-"));
const fake = await startFakeZeta({ origins: [origin], live: true });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: root,
  env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) },
  stdio: "ignore",
});
const failures: string[] = [];
let passed = 0;
const mutatingMethods = [
  "new_session", "resume", "send", "steer", "send_images", "approve", "deny", "abort", "rename_session",
  "delete_session", "repair_transcript", "switch_branch", "fork_message", "set_settings", "set_compaction",
  "slash_run", "set_turn_context", "account_logout", "account_refresh", "account_switch", "login_start",
  "login_cancel", "project_inbox", "clear_steering", "revoke_session_grants", "child_run_send",
] as const;

for (let attempt = 0; attempt < 100; attempt++) {
  try { if ((await fetch(origin)).ok) break; } catch {}
  if (attempt === 99) throw new Error("vite did not start");
  await Bun.sleep(100);
}
if (screenshots) await mkdir(screenshots, { recursive: true });

async function ready(page: Page) {
  await page.locator(".app").waitFor({ timeout: 15_000 });
}
async function check(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); failures.push(`${name}: ${message}`); console.log(`FAIL ${name}: ${message}`); }
}
async function matrix(type: BrowserType, browserName: string, width: number) {
  const browser = await type.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
  try {
    fake.setMode("controller-busy");
    fake.attachQuietly(runId);
    const observerStart = fake.requests.length;
    const observer = await context.newPage();
    await observer.goto(`${origin}/?run=${runId}`);
    await ready(observer);
    if (screenshots) { await Bun.sleep(800); await observer.screenshot({ path: join(screenshots, `after-${browserName}-${width}.png`), fullPage: true }); }
    await observer.getByText("observing", { exact: true }).waitFor({ timeout: 15_000 });
    await observer.getByText("you are observing this run; sending is off", { exact: true }).waitFor();
    if (await observer.locator('.dock textarea[aria-label="message"]').count()) throw new Error("observer composer remained editable");
    const observerRequests = fake.requests.slice(observerStart);
    const mutated = observerRequests.filter(({ method }) => mutatingMethods.includes(method as typeof mutatingMethods[number]));
    if (mutated.length) throw new Error(`observer made mutating calls: ${mutated.map(({ method }) => method).join(", ")}`);
    await observer.close();

    fake.attachQuietly(CHILD_HOLD);
    const childStart = fake.requests.length;
    const child = await context.newPage();
    await child.goto(`${origin}/?run=${CHILD_HOLD}&child=${encodeURIComponent("root:2")}`);
    await ready(child);
    await child.getByRole("log", { name: "saved child activity" }).getByText("saved child transcript is available", { exact: true }).waitFor({ timeout: 15_000 });
    if (await child.getByLabel("child follow-up").count()) throw new Error("observer child view exposed its composer");
    const childRequests = fake.requests.slice(childStart);
    if (childRequests.some(({ method }) => method === "child_run_list" || method === "child_run_send")) throw new Error("observer child route listed or sent to children");
    await child.close();

    fake.setMode("observer-limit");
    const limitStart = fake.requests.length;
    const limited = await context.newPage();
    await limited.goto(`${origin}/?run=${runId}`);
    await ready(limited);
    await limited.getByText("observer limit reached", { exact: true }).waitFor({ timeout: 15_000 });
    const beforeWait = fake.requests.slice(limitStart).filter(({ method }) => method === "hello").length;
    await Bun.sleep(1_200);
    const afterWait = fake.requests.slice(limitStart).filter(({ method }) => method === "hello").length;
    if (beforeWait !== 2 || afterWait !== 2) throw new Error(`observer limit made ${afterWait} hello attempts instead of waiting after 2`);
    await limited.getByRole("button", { name: "retry now" }).click();
    for (let attempt = 0; attempt < 50 && fake.requests.slice(limitStart).filter(({ method }) => method === "hello").length < 3; attempt++) await Bun.sleep(100);
    const afterRetry = fake.requests.slice(limitStart).filter(({ method }) => method === "hello");
    if (afterRetry.length !== 3 || afterRetry[2]?.params.role !== "observer") throw new Error("explicit retry did not make one observer hello attempt");
    await limited.close();

    fake.setMode("ok");
    fake.attachQuietly(runId);
    const controllerStart = fake.requests.length;
    const controller = await context.newPage();
    await controller.goto(`${origin}/?run=${runId}`);
    await controller.locator('.dock textarea[aria-label="message"]').waitFor({ timeout: 15_000 });
    if (await controller.getByText("observing", { exact: true }).count()) throw new Error("controller view showed the observer badge");
    await controller.locator('.dock textarea[aria-label="message"]').fill("controller send remains enabled");
    await controller.getByRole("button", { name: "send message" }).click();
    for (let attempt = 0; attempt < 50 && !fake.requests.slice(controllerStart).some(({ method }) => method === "send"); attempt++) await Bun.sleep(100);
    if (!fake.requests.slice(controllerStart).some(({ method }) => method === "send")) throw new Error("controller could not send");
    await controller.close();
  } finally {
    await context.close();
    await browser.close();
  }
}

try {
  for (const [type, name] of [[chromium, "chromium"], [webkit, "webkit"]] as const) {
    if (process.env.OBSERVER_GATE_BROWSER && process.env.OBSERVER_GATE_BROWSER !== name) continue;
    for (const width of [1440, 390]) {
      if (process.env.OBSERVER_GATE_WIDTH && Number(process.env.OBSERVER_GATE_WIDTH) !== width) continue;
      await check(`${name} observer mode at ${width}`, () => matrix(type, name, width));
    }
  }
} finally {
  vite.kill("SIGTERM");
  await fake.stop();
  await fake.close();
  await rm(gammaHome, { recursive: true, force: true });
}
if (failures.length) throw new Error(`${failures.length} observer gate failure(s)\n${failures.join("\n")}`);
console.log(`observer gate: ${passed} rows passed`);
