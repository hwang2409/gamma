import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type Browser, type BrowserContext, type Page } from "playwright";
import { startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.DELIVERY_GATE_PORT ?? 4321);
const origin = `http://127.0.0.1:${port}`;
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-delivery-"));
const shots = process.env.GATE_SHOTS ?? gammaHome;
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
    // Only the view that sent a steer resends it by itself; after a reload the dropped steer waits for the user's resend.
    await check("queued-reload-natural-drop-waits-for-resend", async () => {
      const { context, page } = await fresh(browser);
      try {
        await startQueued(page, "reload natural"); await page.reload(); await ready(page);
        await page.locator('.undelivered[role="note"]').waitFor({ timeout: 15_000 });
        if (fake.sent.some((item) => item.method === "send" && item.text === "queued reload natural")) throw new Error("a reloaded page resent the steer without the user");
        await page.getByRole("button", { name: "resend" }).click(); await waitForSent("queued reload natural");
      } finally { await cleanup(context, page); }
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
    await check("disconnect-dropped-steer-waits-for-resend", async () => {
      const { context, page } = await fresh(browser);
      try {
        await startQueued(page, "disconnect"); fake.drop(); await page.reload(); await ready(page);
        await page.locator('.undelivered[role="note"]').waitFor({ timeout: 15_000 });
        if (fake.sent.some((item) => item.method === "send" && item.text === "queued disconnect")) throw new Error("a steer dropped by a disconnect was resent without the user");
        await page.getByRole("button", { name: "resend" }).click(); await waitForSent("queued disconnect");
        if ((await page.locator("body").innerText()).includes("content must be an array")) throw new Error("terminal delivery history failed fulcrum adaptation");
      } finally { await cleanup(context, page); }
    });
    await check("delayed-retry-blocks-and-orders-second-submit", async () => {
      const { context, page } = await fresh(browser);
      try {
        const field = await startQueued(page, "delayed retry"); fake.delayNext("send", 3_000);
        // gamma gets no drop reason without session_history_fidelity, so the natural drop waits for the resend click.
        await page.locator('.undelivered[role="note"]').getByRole("button", { name: "resend" }).click({ timeout: 15_000 });
        await page.getByLabel("message resending").waitFor({ timeout: 15_000 });
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
    // A lost reply is a wait, not an error (quiet tone, no raw close code), and it never ends in two turns.
    await check("lost-send-reply-is-a-quiet-wait-and-never-runs-twice", async () => {
      const { context, page } = await fresh(browser, 1440);
      try {
        await page.goto(`${origin}/?run=s-docs`); await ready(page);
        await page.locator('.status-line[data-state="ready"]').waitFor({ timeout: 15_000 });
        const field = page.locator('.dock textarea[aria-label="message"]');
        fake.delayNext("send", 2_500);
        await field.fill("retry me once"); await field.press("Enter");
        await Bun.sleep(500); fake.drop(); // zeta takes the send; its reply is lost with the socket
        await Bun.sleep(300);
        const status = page.locator('[data-part="composer-status"]');
        if (await status.getAttribute("data-tone") === "danger" || /\(10\d\d\)/.test(await status.innerText())) throw new Error(`a lost reply read as an error: ${JSON.stringify(await status.innerText())}`);
        await page.screenshot({ path: join(shots, "lost-reply-wait-1440.png") });
        // The reopen may ask zeta before the delayed send lands ("unknown"): the draft stays with its saved id and a quiet
        // note; if zeta already says delivered, the draft clears. Either way Enter cannot start a second turn.
        await Bun.sleep(3_500);
        const kept = await field.inputValue();
        if (kept && !(await status.innerText()).includes("Enter will not run it twice")) throw new Error(`a kept draft has no may-already-be-sent note: ${JSON.stringify(await status.innerText())}`);
        if (kept) await field.press("Enter");
        await Bun.sleep(1_500);
        if (await field.inputValue()) throw new Error(`after Enter the composer still held ${JSON.stringify(await field.inputValue())}`);
        const accepted = fake.sent.filter((item) => item.text === "retry me once");
        if (accepted.length !== 1) throw new Error(`the lost reply ended with ${accepted.length} turns`);
      } finally { await cleanup(context, page); }
    });
  } finally { await browser.close(); }
  // M1: a full page back then forward (real navigations, not pushState) must not bring a delivered send back as a
  // draft. CI installs only chromium; on macOS webkit runs too.
  for (const [name, type] of [["chromium", chromium], ...(process.platform === "darwin" ? [["webkit", webkit] as const] : [])] as const) {
    const other = await type.launch();
    try {
      await check(`delivered-send-is-not-a-draft-after-page-back-forward-${name}`, async () => {
        const context = await other.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        try {
          await page.goto(`${origin}/?run=s-markdown`); await ready(page);
          await page.goto(`${origin}/?run=s-themes`); await ready(page);
          await page.locator('.status-line[data-state="ready"]').waitFor({ timeout: 15_000 });
          const text = `dup check ${name}`;
          const field = page.locator('.dock textarea[aria-label="message"]');
          fake.delayNext("send", 3_000);
          await field.fill(text); await field.press("Enter");
          await Bun.sleep(200);
          await page.goBack(); await page.waitForURL(/run=s-markdown/); await ready(page);
          await Bun.sleep(4_500); // zeta takes the send while this page is away
          await page.goForward(); await page.waitForURL(/run=s-themes/); await ready(page);
          await page.locator('.status-line').waitFor({ timeout: 15_000 });
          await Bun.sleep(1_500); // the restored delivery settles from delivery_status
          const restored = await field.inputValue();
          await page.screenshot({ path: join(shots, `page-back-forward-${name}.png`) });
          if (restored) await field.press("Enter"); // what a user does with a ready draft
          await Bun.sleep(1_500);
          const turns = fake.sent.filter((item) => item.text === text);
          if (turns.length !== 1 || restored) throw new Error(`after page back and forward the draft held ${JSON.stringify(restored)} and zeta accepted ${turns.length} turns`);
        } finally { await cleanup(context, page); }
      });
      // B1: a page for another run never queries or resends this run's saved delivery; only Enter sends it, in its own run.
      await check(`unconfirmed-send-is-not-resent-by-another-run-${name}`, async () => {
        const context = await other.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        let dropFrame = false;
        await page.routeWebSocket(new RegExp(`:${fake.port}`), (ws) => {
          const server = ws.connectToServer();
          ws.onMessage((frame) => { if (dropFrame && typeof frame === "string" && /"method":"send"/.test(frame)) { dropFrame = false; return; } server.send(frame); });
          server.onMessage((frame) => ws.send(frame));
        });
        try {
          await page.goto(`${origin}/?run=s-markdown`); await ready(page);
          await page.goto(`${origin}/?run=s-docs`); await ready(page);
          await page.locator('.status-line[data-state="ready"]').waitFor({ timeout: 15_000 });
          const text = `unknown check ${name}`;
          const field = page.locator('.dock textarea[aria-label="message"]');
          dropFrame = true; // the page leaves before the frame reaches zeta
          await field.fill(text); await field.press("Enter");
          await Bun.sleep(200);
          const since = fake.requests.length;
          await page.goBack(); await page.waitForURL(/run=s-markdown/); await ready(page);
          await page.locator('.status-line[data-state="ready"]').waitFor({ timeout: 15_000 });
          await Bun.sleep(2_500);
          const onBack = fake.requests.slice(since).map((request) => request.method);
          if (onBack.includes("send") || onBack.includes("delivery_status") || fake.sent.some((item) => item.text === text)) throw new Error(`the s-markdown page acted on s-docs's delivery: ${JSON.stringify(onBack)}`);
          await page.goForward(); await page.waitForURL(/run=s-docs/); await ready(page);
          await page.locator('[data-part="composer-message"]', { hasText: "Enter will not run it twice" }).waitFor({ timeout: 15_000 });
          if (await field.inputValue() !== text || fake.sent.some((item) => item.text === text)) throw new Error("the forward page did not restore the unsent draft, or sent it by itself");
          await page.screenshot({ path: join(shots, `unconfirmed-forward-${name}.png`) });
          await field.press("Enter");
          await waitForSent(text);
          const landed = fake.sent.filter((item) => item.text === text).map((item) => item.session);
          if (JSON.stringify(landed) !== JSON.stringify(["s-docs"])) throw new Error(`the message landed in ${JSON.stringify(landed)}`);
        } finally { await cleanup(context, page); }
      });
      // B-1: a page back from the bfcache keeps its memory but is a new page life; it never resends a steer by itself.
      // Playwright's chromium disables the bfcache, so only webkit (macOS; CI has no webkit) reaches pageshow.persisted.
      if (name === "webkit") await check("queued-steer-not-resent-after-bfcache-back-webkit", async () => {
        const context = await other.newContext({ viewport: { width: 1440, height: 900 } });
        await context.addInitScript(() => addEventListener("pageshow", (event) => { if (event.persisted) (window as Window & { __restored?: number }).__restored = ((window as Window & { __restored?: number }).__restored ?? 0) + 1; }));
        const page = await context.newPage();
        try {
          await page.goto(origin); await ready(page);
          await startQueued(page, "bfcache");
          const owner = page.url();
          await page.goto(`${origin}/?run=s-markdown`); await ready(page); // a real navigation away
          await page.goBack(); await page.waitForURL(owner);
          const restored = await page.evaluate(() => (window as Window & { __restored?: number }).__restored ?? 0);
          if (!restored) console.log("NOTE queued-steer-not-resent-after-bfcache-back-webkit: webkit loaded the page again instead of restoring it from the bfcache");
          await page.locator('.undelivered[role="note"]').waitFor({ timeout: 20_000 }); // the turn ended naturally and dropped the steer
          await Bun.sleep(1_500);
          if (fake.sent.some((item) => item.method === "send" && item.text === "queued bfcache")) throw new Error(`the page back from the bfcache (restored=${restored}) resent the steer without the user`);
          await page.getByRole("button", { name: "resend" }).click(); await waitForSent("queued bfcache");
        } finally { await cleanup(context, page); }
      });
    } finally { await other.close(); }
  }
} finally {
  vite.kill("SIGTERM"); await Promise.race([new Promise<void>((resolve) => vite.once("exit", () => resolve())), Bun.sleep(2_000)]);
  await fake.close(); await rm(gammaHome, { recursive: true, force: true });
}
if (failures.length) throw new Error(`${failures.length} delivery gate(s) failed\n${failures.join("\n")}`);
console.log(`delivery state gate: ${passed} passed`);
