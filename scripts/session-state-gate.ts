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

async function ready(page: Page) {
  try { await page.locator('.dock textarea[aria-label^="message"]').waitFor({ timeout: 15_000 }); }
  catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\npage: ${await page.locator("main").innerText()}`); }
}
async function fresh(browser: Browser, width: number, path = "/") {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
  await context.addInitScript(() => {
    localStorage.clear(); sessionStorage.clear();
    (window as Window & { __gammaBusySeen?: boolean }).__gammaBusySeen = false;
    addEventListener("DOMContentLoaded", () => new MutationObserver(() => {
      if (document.body?.innerText.includes("another run is active")) (window as Window & { __gammaBusySeen?: boolean }).__gammaBusySeen = true;
    }).observe(document.body, { childList: true, subtree: true, characterData: true }));
  });
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

// UX-8 regression guards (the second passes on 58d9713 with this gate and fake).
// gamma does not negotiate session_history_fidelity, so zeta sends it no drop reason (delivery.py:305-325) and gamma never
// resends a dropped steer by itself: the row offers the resend, and the click sends it once.
for (const width of [1440, 390]) await check(`natural turn end offers the resend of a queued steer at ${width}`, async () => {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await fresh(browser, width, "/?run=s-reconnect");
  try {
    await page.getByRole("button", { name: "approve", exact: true }).waitFor({ timeout: 15_000 });
    await page.locator('.dock textarea[aria-label="message"]').fill("please approve this");
    await page.getByRole("button", { name: "steer the running turn" }).click();
    await page.getByRole("status", { name: "message queued" }).waitFor();
    await page.getByRole("button", { name: "approve", exact: true }).click();
    const resend = page.getByRole("button", { name: "resend" });
    await resend.waitFor({ timeout: 15_000 }); await Bun.sleep(300);
    if (fake.sent.some((item) => item.method === "send" && item.text === "please approve this")) throw new Error("a steer dropped with no known reason was resent without the user");
    await resend.click();
    if (!await poll(() => Promise.resolve(fake.sent.some((item) => item.method === "send" && item.text === "please approve this")), 100)) throw new Error("the resend click did not send the dropped steer as a new message");
    if (!await poll(async () => await page.getByRole("status", { name: /message (queued|requesting|resending)/ }).count() === 0)) throw new Error("the accepted resend still looked queued");
    if (await page.locator('[data-part="composer-message"]', { hasText: /sending|steering/ }).count()) throw new Error("the composer still looked like it was sending");
    if (await page.locator(".status-line").getAttribute("data-state") === "ready") throw new Error("the resent turn was running but the header said ready");
  } finally { await context.close(); await browser.close(); fake.setLive(false); fake.setLive(true); fake.drop(); await Bun.sleep(300); await fake.start(); }
});

for (const width of [1440, 390]) await check(`cached approved run stays settled after new-run navigation at ${width}`, async () => {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await fresh(browser, width, "/?run=s-reconnect");
  try {
    await page.getByRole("button", { name: "approve", exact: true }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "approve", exact: true }).click();
    await waitForIdle();
    const owner = page.url();
    await page.getByRole("button", { name: "new run" }).click();
    await page.goBack();
    await page.waitForURL(owner);
    if (await page.getByRole("button", { name: "approve", exact: true }).count()) throw new Error("the completed approval returned after back navigation");
    await page.reload();
    await ready(page);
    if (await page.getByRole("button", { name: "approve", exact: true }).count()) throw new Error("the completed approval returned after reload");
  } finally { await context.close(); await browser.close(); fake.setLive(false); fake.setLive(true); fake.drop(); await Bun.sleep(300); await fake.start(); }
});

// The transient-resume, transient-new-session, known-owner, delayed-retry, rapid-selection,
// approval-navigation, four-busy-new-session, and four-busy-resume cases below are regression guards;
// they already pass on 6216ad7 with the same packed Fulcrum.
await check("one transient busy resume retries and opens", async () => {
  const before = fake.requests.length;
  fake.busyNext("resume", 1);
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await fresh(browser, 1440, "/?run=s-themes");
  try {
    const opened = await poll(async () => await page.getByRole("log", { name: "run activity" }).getByText(/check every theme/, { exact: false }).count() > 0);
    if (!opened) throw new Error(`transient resume did not retry; panel=${await page.locator("main").innerText()}`);
    const attempts = fake.requests.slice(before).filter((request) => request.method === "resume" && request.params.session_id === "s-themes");
    if (attempts.length !== 2) throw new Error(`transient resume made ${attempts.length} attempts instead of 2`);
    if (await page.evaluate(() => Boolean((window as Window & { __gammaBusySeen?: boolean }).__gammaBusySeen))) throw new Error("transient resume flashed the busy panel");
  } finally { await context.close(); await browser.close(); }
});

await check("one transient busy new session retries and starts", async () => {
  const before = fake.requests.length;
  fake.busyNext("new_session", 1);
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await fresh(browser, 1440);
  try {
    await page.locator('.dock textarea[aria-label="message"]').fill("retry transient create");
    await page.getByRole("button", { name: "send message" }).click();
    const created = await poll(async () => new URL(page.url()).searchParams.get("run")?.startsWith("s-new-") ?? false);
    if (!created) throw new Error(`transient new_session did not retry; url=${page.url()} body=${await page.locator("main").innerText()}`);
    await page.getByRole("log", { name: "run activity" }).getByText("retry transient create", { exact: true }).waitFor({ timeout: 15_000 });
    const attempts = fake.requests.slice(before).filter((request) => request.method === "new_session");
    if (attempts.length !== 2) throw new Error(`transient new_session made ${attempts.length} attempts instead of 2`);
    if (await page.evaluate(() => Boolean((window as Window & { __gammaBusySeen?: boolean }).__gammaBusySeen))) throw new Error("transient new_session flashed the busy panel");
  } finally { const stop = page.getByRole("button", { name: "stop the running turn" }); await stop.click().catch(() => {}); await context.close(); await browser.close(); }
});

await check("a delayed resume retry is cancelled after navigation", async () => {
  fake.setLive(false);
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await fresh(browser, 1440, "/?run=s-docs");
  const before = fake.requests.length;
  fake.busyNext("resume", 1);
  fake.delayNext("resume", 800);
  try {
    await page.goto(`${origin}/?run=s-themes`);
    if (!await poll(() => Promise.resolve(fake.requests.slice(before).some((request) => request.method === "resume" && request.params.session_id === "s-themes")))) throw new Error("the first resume was not sent");
    await page.evaluate(() => {
      const run = `draft:${crypto.randomUUID()}`;
      const url = new URL(location.href); url.searchParams.set("run", run);
      history.pushState({ gammaEntryId: crypto.randomUUID(), run }, "", url);
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    });
    await page.waitForURL((url) => url.searchParams.get("run")?.startsWith("draft:") ?? false);
    const draft = page.url();
    await Bun.sleep(1_500);
    if (fake.activeId() === "s-themes") throw new Error("stale retry attached the old run after navigation");
    if (page.url() !== draft) throw new Error(`stale resume replaced the selected draft: ${page.url()}`);
    if (await page.getByRole("heading", { name: "another run is active" }).count()) throw new Error("stale resume showed a busy panel on the new run");
  } finally { await context.close(); await browser.close(); }
});

await check("a known different owner shows busy without a resume retry", async () => {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await fresh(browser, 1440);
  try {
    await page.locator('.dock textarea[aria-label="message"]').fill("keep this owner running");
    await page.getByRole("button", { name: "send message" }).click();
    await page.getByRole("button", { name: "stop the running turn" }).waitFor();
    const before = fake.requests.length;
    await page.evaluate(() => {
      const url = new URL(location.href); url.searchParams.set("run", "s-themes");
      history.pushState({ gammaEntryId: crypto.randomUUID(), run: "s-themes" }, "", url);
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    });
    await page.getByRole("heading", { name: "another run is active" }).waitFor();
    const attempts = fake.requests.slice(before).filter((request) => request.method === "resume" && request.params.session_id === "s-themes");
    if (attempts.length) throw new Error(`known owner still sent ${attempts.length} resume attempts`);
  } finally { await page.getByRole("button", { name: "stop the running turn" }).click().catch(() => {}); await context.close(); await browser.close(); }
});

await check("four busy new sessions keep the draft and show a stable error", async () => {
  const before = fake.requests.length;
  fake.busyNext("new_session", 4);
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await fresh(browser, 1440);
  try {
    const draft = page.url();
    await page.locator('.dock textarea[aria-label="message"]').fill("keep this failed draft");
    await page.getByRole("button", { name: "send message" }).click();
    if (!await poll(() => Promise.resolve(fake.requests.slice(before).filter((request) => request.method === "new_session").length === 4), 100)) throw new Error("new_session did not make exactly four bounded attempts");
    if (page.url() !== draft || !new URL(page.url()).searchParams.get("run")?.startsWith("draft:")) throw new Error(`failed create did not keep its draft URL: ${page.url()}`);
    await page.getByText(/could not send:/i).waitFor({ timeout: 15_000 });
    if (await page.locator('.dock textarea[aria-label="message"]').inputValue() !== "keep this failed draft") throw new Error("failed create lost its draft text");
  } finally { await context.close(); await browser.close(); }
});

await check("rapid selection ignores the stale open completion", async () => {
  fake.setOpenDelay(800);
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await fresh(browser, 1440);
  try {
    for (const run of ["s-themes", "s-docs"]) {
      await page.evaluate((run) => {
        const url = new URL(location.href); url.searchParams.set("run", run);
        history.pushState({ gammaEntryId: crypto.randomUUID(), run }, "", url);
        dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
      }, run);
      await Bun.sleep(50);
    }
    await page.getByRole("heading", { name: /write the quickstart/ }).waitFor({ timeout: 15_000 });
    if (await page.getByRole("log", { name: "run activity" }).getByText(/check every theme/, { exact: false }).count()) throw new Error("the stale first open replaced the second selection");
    if (new URL(page.url()).searchParams.get("run") !== "s-docs") throw new Error(`stale open replaced the URL: ${page.url()}`);
  } finally { fake.setOpenDelay(0); await context.close(); await browser.close(); }
});

await check("approval survives new-run back-forward before its decision", async () => {
  fake.setLive(false); fake.setLive(true);
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await fresh(browser, 1440, "/?run=s-reconnect");
  try {
    await page.getByRole("button", { name: "approve", exact: true }).waitFor({ timeout: 15_000 });
    const owner = page.url();
    await page.getByRole("button", { name: "new run" }).click();
    const draft = page.url();
    await page.goBack(); await page.waitForURL(owner);
    await page.goForward(); await page.waitForURL(draft);
    await page.goBack(); await page.waitForURL(owner);
    if (!await poll(async () => await page.getByRole("button", { name: "approve", exact: true }).count() > 0)) throw new Error(`approval was lost across back-forward navigation: ${await page.locator("main").innerText()}`);
    await page.getByRole("button", { name: "approve", exact: true }).click();
    if (!await poll(async () => await page.getByRole("button", { name: "approve", exact: true }).count() === 0, 100)) throw new Error("approval did not settle after back-forward navigation");
  } finally { await context.close(); await browser.close(); fake.setLive(false); fake.setLive(true); }
});

await check("four busy resumes show the busy panel", async () => {
  const before = fake.requests.length;
  fake.busyNext("resume", 4);
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await fresh(browser, 1440, "/?run=s-docs");
  try {
    await page.getByRole("heading", { name: "another run is active" }).waitFor({ timeout: 15_000 });
    const attempts = fake.requests.slice(before).filter((request) => request.method === "resume" && request.params.session_id === "s-docs");
    if (attempts.length !== 4) throw new Error(`always-busy resume made ${attempts.length} attempts instead of 4`);
  }
  finally { await context.close(); await browser.close(); }
});

vite.kill("SIGTERM");
await Promise.race([new Promise<void>((resolve) => vite.once("exit", () => resolve())), Bun.sleep(2_000)]);
await fake.close();
await rm(gammaHome, { recursive: true, force: true });
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log(`session state: ${passed} passed`);
