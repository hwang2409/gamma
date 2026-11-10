import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import { startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.NAVIGATION_GATE_PORT ?? 4311);
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.WEB_SHOTS ?? join(root, "gate-artifacts", "navigation");
await mkdir(shots, { recursive: true });
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-navigation-"));
const fake = await startFakeZeta({ origins: [origin], live: false, serialDelays: { send: Array(20).fill(3_000), new_session: Array(20).fill(3_000) } });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) }, stdio: "ignore" });
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
/**
 * Sends `text` once the composer accepts it: a forced click on send while the run is still opening is dropped, so no
 * turn starts. With `accepted`, also waits until the fake zeta took the send, so a later "stop" wait has a real turn.
 */
async function send(page: Page, text: string, { accepted = true } = {}) {
  const before = fake.sent.length;
  await page.locator('.dock textarea[aria-label="message"]').fill(text);
  await page.getByRole("button", { name: "send message", exact: true }).click();
  if (!accepted) return;
  const took = () => fake.sent.slice(before).some((sent) => sent.method === "send" && sent.text === text);
  for (let attempt = 0; attempt < 75 && !took(); attempt++) await Bun.sleep(200);
  if (!took()) throw new Error(`fake zeta did not accept send "${text}"; it recorded ${JSON.stringify(fake.sent.slice(before))}`);
}
async function stopAfterSend(page: Page, text: string) {
  await send(page, text);
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
    await send(page, `owner turn ${stopped ? "stop" : "natural"}`);
    await page.getByRole("button", { name: "stop the running turn" }).waitFor({ timeout: 15_000 });
    await field.fill(`queued steer ${stopped ? "stop" : "natural"}`); await page.getByRole("button", { name: "steer the running turn" }).click();
    if (stopped) {
      await page.getByRole("button", { name: "stop the running turn" }).click();
      await page.locator('[data-part="delivery-note"]').waitFor({ timeout: 15_000 }); // gamma's note with the resend; the message itself may also say "not delivered"
      await page.getByRole("button", { name: "resend" }).click();
    } else {
      // The automatic resend belongs to the view that sent the steer; leaving it in-app hands the steer to the user.
      const owner = page.url();
      await page.getByRole("button", { name: "new run" }).click();
      await page.getByText(/new run waits for the running run/i).waitFor();
      await page.getByText(/new run waits for the running run/i).waitFor({ state: "detached", timeout: 30_000 });
      await page.goBack(); await page.waitForURL(owner);
      await page.locator('[data-part="delivery-note"]').waitFor({ timeout: 15_000 }); // gamma's note with the resend; the message itself may also say "not delivered"
      if (fake.sent.some((sent) => sent.method === "send" && sent.text === "queued steer natural")) throw new Error("the steer was resent without the user after its view was left");
      await page.getByRole("button", { name: "resend" }).click();
    }
    await page.waitForFunction((text) => document.body.innerText.includes(String(text)), `queued steer ${stopped ? "stop" : "natural"}`, { timeout: 15_000 });
    for (let attempt = 0; attempt < 50 && !fake.sent.some((sent) => sent.method === "send" && sent.text === `queued steer ${stopped ? "stop" : "natural"}`); attempt++) await Bun.sleep(200);
    if (!fake.sent.some((sent) => sent.method === "steer" && sent.text === `queued steer ${stopped ? "stop" : "natural"}`)) throw new Error("steer was not queued for its owner run");
    if (!fake.sent.some((sent) => sent.method === "send" && sent.text === `queued steer ${stopped ? "stop" : "natural"}`)) throw new Error(stopped ? "manual resend did not send the stopped steer" : "the resend click did not send the dropped steer");
  } finally {
    const stop = page.getByRole("button", { name: "stop the running turn" });
    await stop.waitFor({ timeout: 5_000 }).then(() => stop.click()).catch(() => {});
    await context.close(); fake.drop(); await Bun.sleep(500);
  }
}

async function resetResumeFixture() {
  await fake.stop();
  fake.setEmpty(false);
  await fake.start();
  fake.attachQuietly("s-reconnect");
  fake.clearSent();
}

async function canonicalResumeSequence(browser: Browser) {
  await resetResumeFixture();
  fake.delayNext("resume", 400);
  const before = fake.requests.length;
  const { context, page } = await fresh(browser, 390, "/?run=s-re");
  try {
    const field = page.locator('.dock textarea[aria-label^="message"]');
    await field.fill("draft typed under prefix");
    if (fake.sent.length) throw new Error("the prefix draft sent while resume was pending");
    await page.waitForURL((url) => url.searchParams.get("run") === "s-reconnect", { timeout: 15_000 });
    if (await field.inputValue() !== "draft typed under prefix") throw new Error("canonicalization lost the prefix draft");
    if (fake.sent.length) throw new Error("canonicalization sent the prefix draft without Enter");
    const calls = fake.requests.slice(before);
    const history = calls.find((request) => request.method === "session_history");
    if (history?.params.session_id !== "s-reconnect") throw new Error(`history used ${String(history?.params.session_id)} instead of the canonical id`);
    await page.getByRole("button", { name: "send message", exact: true }).click();
    for (let attempt = 0; attempt < 75 && !fake.sent.some((sent) => sent.text === "draft typed under prefix"); attempt++) await Bun.sleep(100);
    const send = fake.requests.slice(before).find((request) => request.method === "send" && request.params.text === "draft typed under prefix");
    if (send?.params.session_id !== "s-reconnect") throw new Error(`send used ${String(send?.params.session_id)} instead of the canonical id`);
  } finally {
    const stop = page.getByRole("button", { name: "stop the running turn" });
    await stop.waitFor({ timeout: 2_000 }).then(() => stop.click()).catch(() => {});
    await context.close(); fake.drop(); await Bun.sleep(300);
  }
}

async function ambiguousResumeSequence(browser: Browser) {
  await resetResumeFixture();
  const before = fake.requests.length;
  const { context, page } = await fresh(browser, 390, "/?run=abcd");
  try {
    await page.getByText(/ambiguous/i).waitFor({ timeout: 15_000 });
    for (const candidate of ["abcd1111", "abcd2222"]) {
      const link = page.getByRole("link", { name: candidate, exact: true });
      if (await link.getAttribute("href") !== `?run=${candidate}`) throw new Error(`${candidate} did not link to its run route`);
    }
    if (new URL(page.url()).searchParams.get("run") !== "abcd") throw new Error(`ambiguous prefix auto-opened ${page.url()}`);
    if (fake.requests.slice(before).some((request) => request.method === "session_history" || request.method === "send")) throw new Error("ambiguous prefix replayed or sent");
  } finally { await context.close(); fake.drop(); await Bun.sleep(300); }
}

async function fullResumeSequence(browser: Browser) {
  await resetResumeFixture();
  const { context, page } = await fresh(browser, 390, "/?run=s-reconnect");
  try {
    await page.getByRole("log", { name: "run activity" }).waitFor({ timeout: 15_000 });
    if (new URL(page.url()).searchParams.get("run") !== "s-reconnect") throw new Error(`full id changed to ${page.url()}`);
  } finally { await context.close(); fake.drop(); await Bun.sleep(300); }
}

async function pendingCreateSequence(browser: Awaited<ReturnType<typeof chromium.launch>>, width: number) {
  const { context, page } = await fresh(browser, width, "/?run=s-themes");
  try {
    const runA = page.url();
    await page.getByRole("button", { name: "new run" }).click();
    const temporary = page.url();
    if (!temporary.includes("run=draft%3A")) throw new Error(`new run did not get an immediate draft history entry: ${temporary}`);
    const field = page.locator('.dock textarea[aria-label="message"]');
    await send(page, "pending first send C", { accepted: false }); // navigates away while the create is pending
    await page.goBack(); await page.waitForURL(runA);
    if (await field.inputValue() === "pending first send C") throw new Error("pending C draft appeared under A");
    await Bun.sleep(3_500);
    if (page.url() !== runA) throw new Error(`background create replaced A's entry: ${page.url()}`);
    await page.goForward();
    await page.waitForURL((url) => url.searchParams.get("run")?.startsWith("s-new-") ?? false);
    await page.getByRole("log", { name: "run activity" }).getByText("pending first send C", { exact: true }).waitFor({ timeout: 15_000 });
    await page.goBack(); await page.waitForURL(runA);
  } finally {
    const stop = page.getByRole("button", { name: "stop the running turn" });
    await stop.waitFor({ timeout: 5_000 }).then(() => stop.click()).catch(() => {});
    await context.close(); fake.drop(); await Bun.sleep(500);
  }
}

async function uncachedNavigationSequence(browser: Awaited<ReturnType<typeof chromium.launch>>, width: number) {
  fake.setOpenDelay(2_000); // the run is still opening when the composer appears, as on a slow CI runner
  const { context, page } = await fresh(browser, width, "/?run=s-reconnect");
  try {
    await send(page, "active run marker"); fake.setOpenDelay(0);
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
    const resume = [...fake.requests].reverse().find((request) => request.method === "resume" && request.params.session_id === "s-themes");
    const settings = [...fake.requests].reverse().find((request) => request.method === "session_settings" && request.params.session_id === "s-themes");
    if (settings && (!resume?.replied || settings.started < resume.replied)) throw new Error("target settings loaded before its resume completed");
  } finally {
    fake.setOpenDelay(0);
    const stop = page.getByRole("button", { name: "stop the running turn" });
    await stop.waitFor({ timeout: 5_000 }).then(() => stop.click()).catch(() => {});
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
    await send(page, "run B long turn");
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

    await send(page, "run B chained turn");
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
    await stop.waitFor({ timeout: 5_000 }).then(() => stop.click()).catch(() => {});
    await context.close(); fake.drop(); await Bun.sleep(500);
  }
}

try {
  for (let attempt = 0; ; attempt++) { if (vite.exitCode !== null) throw new Error("vite exited"); if (await fetch(origin).then((r) => r.ok, () => false)) break; if (attempt > 300) throw new Error("vite did not start"); await Bun.sleep(100); }
  const browser = await chromium.launch();
  try {
    await check("natural-end-away-waits-for-resend-at-1440", () => queuedSteerSequence(browser, 1440, false));
    await check("natural-end-away-waits-for-resend-at-390", () => queuedSteerSequence(browser, 390, false));
    await check("stop-marks-owner-steer-at-1440", () => queuedSteerSequence(browser, 1440, true));
    await check("stop-marks-owner-steer-at-390", () => queuedSteerSequence(browser, 390, true));
    await check("prefix-resume-canonicalizes-before-send-chromium", () => canonicalResumeSequence(browser));
    await check("ambiguous-prefix-lists-candidates-chromium", () => ambiguousResumeSequence(browser));
    await check("full-session-id-stays-unchanged-chromium", () => fullResumeSequence(browser));
    const webkitBrowser = await webkit.launch();
    try {
      await check("prefix-resume-canonicalizes-before-send-webkit", () => canonicalResumeSequence(webkitBrowser));
      await check("ambiguous-prefix-lists-candidates-webkit", () => ambiguousResumeSequence(webkitBrowser));
      await check("full-session-id-stays-unchanged-webkit", () => fullResumeSequence(webkitBrowser));
    } finally { await webkitBrowser.close(); }
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
