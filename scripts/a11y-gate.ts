// Accessibility threshold in Chromium and WebKit at 1440x900 and 390x844, plus reduced motion and 200% zoom/reflow.
// It asserts what the other gates leave out: accessible names for every control, the approval keyboard path and its
// disabled reason, the command listbox's ARIA contract in WebKit, popover focus return, keyboard-only attachment removal,
// a stopped turn told apart by text, no endless motion under reduced motion, and reflow without horizontal scrolling.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type Browser, type BrowserType, type Page } from "playwright";
import { glyphNames, unnamed } from "./a11y-names";
import { ACTIVE, startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const portText = process.env.WEB_A11Y_GATE_PORT ?? "4232";
if (!/^\d+$/.test(portText)) throw new Error("WEB_A11Y_GATE_PORT must be an integer");
const port = Number(portText);
if (port < 1 || port > 65_535 || port === 5190 || port === 8765 || port + 1 === 5190 || port + 1 === 8765) throw new Error("WEB_A11Y_GATE_PORT is outside the allowed disposable range");
const only = process.env.A11Y_GATE_BROWSERS?.split(",") ?? ["chromium", "webkit"];
const artifacts = process.env.A11Y_GATE_ARTIFACTS ?? await mkdtemp(join(tmpdir(), "gamma-a11y-artifacts-"));
await mkdir(artifacts, { recursive: true });
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-a11y-gate-"));
let origin = "";
let fake: Awaited<ReturnType<typeof startFakeZeta>>;

/** One fake zeta and one vite per browser, so each browser starts on the live turn with its approval pending. */
async function withApp(appPort: number, run: () => Promise<void>) {
  origin = `http://127.0.0.1:${appPort}`;
  // sessionGrants (g4b) gives the permissions popover; live runs the active turn up to its approval.
  fake = await startFakeZeta({ origins: [origin], live: true, sessionGrants: true });
  const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(appPort), "--strictPort"], {
    cwd: root,
    env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  vite.stdout?.on("data", (data) => logs.push(String(data)));
  vite.stderr?.on("data", (data) => logs.push(String(data)));
  try {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (vite.exitCode !== null) throw new Error(`vite exited ${vite.exitCode}: ${logs.join("").slice(-3000)}`);
      if (await fetch(origin).then((response) => response.ok, () => false)) break;
      if (attempt === 299) throw new Error(`vite did not start: ${logs.join("").slice(-3000)}`);
      await Bun.sleep(100);
    }
    await run();
  } finally {
    vite.kill("SIGTERM");
    await fake.close();
  }
}

const failures: string[] = [];
let passed = 0;
async function check(name: string, run: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A hung browser call must fail under this check's name, not stall the whole gate without output.
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("did not finish within 120 s")), 120_000); });
  try { await Promise.race([run(), deadline]); passed++; console.log(`ok   ${name}`); }
  catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  finally { clearTimeout(timer); }
}
const expect = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const field = (page: Page) => page.getByRole("combobox", { name: "message" });
const focused = (page: Page) => page.evaluate(() => {
  const node = document.activeElement as HTMLElement | null;
  return node ? `${node.tagName.toLowerCase()}${node.getAttribute("aria-label") ? `[${node.getAttribute("aria-label")}]` : ""}:${(node.textContent ?? "").trim().slice(0, 40)}` : "none";
});
// macOS WebKit tabs to buttons only with Option held; other platforms tab to them plainly.
const webkitTab = (name: string, key: string) => name === "webkit" && process.platform === "darwin" ? `Alt+${key}` : key;
const pendingApproval = (page: Page) => page.locator('[data-part="approval"][data-state="pending"]');

/** Opens the live active run and waits for its approval, the one state that has every control on screen; a reload rejoins the same pending approval. */
async function openLive(page: Page) {
  await page.goto(`${origin}/?run=${ACTIVE}`);
  await pendingApproval(page).waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: /^permissions/ }).waitFor();
  // Every section types or tabs from the composer, so an opened run without it is a finding, not a later fill timeout.
  await field(page).waitFor({ timeout: 15_000 }).catch(async () => {
    await dump(page, `open-without-composer-${Date.now()}`);
    throw new Error(`the opened run shows its approval but no composer: ${(await page.locator(".dock").innerText().catch(() => "")).slice(0, 300)}`);
  });
}

async function dump(page: Page, label: string) {
  const snapshot = await page.locator("body").ariaSnapshot();
  await writeFile(join(artifacts, `${label}.aria.yml`), snapshot);
  await page.screenshot({ path: join(artifacts, `${label}.png`) });
  return snapshot;
}

async function namesAndApproval(page: Page, name: string, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await openLive(page);
  const label = `${name}-${width}x${height}`;
  await check(`${label}: every control has an accessible name`, async () => {
    const snapshot = await dump(page, label);
    const missing = unnamed(snapshot);
    expect(!missing.length, `unnamed controls: ${missing.join(" | ")}`);
    const glyphs = glyphNames(snapshot);
    expect(!glyphs.length, `control names read a decorative arrow aloud: ${glyphs.join(" | ")}`);
  });
  await check(`${label}: the page reflows without horizontal scrolling`, async () => {
    const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(overflow.scroll <= overflow.client, `document scrolls sideways: ${JSON.stringify(overflow)}`);
  });
  await check(`${label}: the approval status link moves keyboard focus to approve`, async () => {
    const link = page.getByRole("button", { name: "waiting for your approval" });
    await link.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.matches('[data-part="approval"] button[data-action="approve"]'), undefined, { timeout: 5_000 })
      .catch(async () => { throw new Error(`focus is on ${await focused(page)}`); });
    for (const action of ["approve", "always allow", "deny"]) expect(await pendingApproval(page).getByRole("button", { name: action, exact: true }).count() === 1, `approval has no "${action}" button by name`);
  });
}

async function disabledReason(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLive(page);
  await check(`${name}: reconnecting approval buttons are disabled and say why`, async () => {
    // Zeta stays down until the row is read, so the reconnecting state cannot end before the check sees it.
    await fake.stop();
    const stale = await page.waitForFunction(() => {
      const row = document.querySelector('[data-part="approval"][data-state="reconnecting"]');
      if (!row) return null;
      const button = (action: string) => row.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
      return { approve: button("approve")?.disabled ?? null, deny: button("deny")?.disabled ?? null, reasons: [...row.querySelectorAll('[role="status"]')].map((node) => node.textContent ?? ""), text: (row as HTMLElement).innerText };
    }, undefined, { timeout: 10_000 }).then((handle) => handle.jsonValue()).finally(() => fake.start());
    expect(stale && stale.approve === true && stale.deny === true, `approve or deny stays enabled while reconnecting: ${JSON.stringify(stale)}`);
    expect(stale!.reasons.filter((text) => /disabled/.test(text)).length === 1, `no status names the disabled reason: ${JSON.stringify(stale)}`);
    await pendingApproval(page).waitFor({ timeout: 15_000 });
  });
}

async function commandListbox(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLive(page);
  await check(`${name}: command listbox keeps its combobox contract through keyboard, ime, and pointer`, async () => {
    const input = field(page);
    await input.fill("/");
    const listbox = page.getByRole("listbox", { name: "command suggestions" });
    const opens = (step: string) => listbox.waitFor({ timeout: 10_000 }).catch(async () => {
      await dump(page, `${name}-listbox-${step.replace(/[^a-z0-9]+/gi, "-")}-failure`);
      const catalog = fake.requests.filter((request) => request.method === "slash_list").length;
      throw new Error(`${step}: no command list; value ${JSON.stringify(await input.inputValue())}, focus on ${await focused(page)}, ${catalog} slash_list requests`);
    });
    await opens("typing /");
    const contract = () => input.evaluate((node) => {
      const list = document.getElementById(node.getAttribute("aria-controls") ?? "");
      const active = document.getElementById(node.getAttribute("aria-activedescendant") ?? "");
      return { expanded: node.getAttribute("aria-expanded"), controls: list?.getAttribute("role"), activeInList: Boolean(active && list?.contains(active)), selected: active?.getAttribute("aria-selected"), role: active?.getAttribute("role"), id: active?.id ?? "" };
    });
    const first = await contract();
    expect(first.expanded === "true" && first.controls === "listbox" && first.activeInList && first.selected === "true" && first.role === "option", `open list contract: ${JSON.stringify(first)}`);
    await input.press("ArrowDown");
    const moved = await contract();
    expect(moved.id !== first.id && moved.selected === "true" && moved.activeInList, `arrow down did not move the selected option: ${JSON.stringify(moved)}`);
    expect(await listbox.locator('[role="option"][aria-selected="true"]').count() === 1, "more than one option is selected");
    await input.fill("/st");
    await opens("typing /st");
    await input.evaluate((node) => node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    expect(await input.inputValue() === "/st", "ime enter accepted a command");
    await input.evaluate((node) => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await page.getByRole("option", { name: /^\/status/ }).click();
    await page.waitForFunction(() => (document.activeElement as HTMLTextAreaElement | null)?.value === "/status ", undefined, { timeout: 5_000 })
      .catch(async () => { throw new Error(`pointer accept left ${JSON.stringify(await input.inputValue())} with focus on ${await focused(page)}`); });
    await input.fill("/st");
    await opens("retyping /st after pointer accept");
    await input.press("Escape");
    expect(await listbox.count() === 0 && await input.getAttribute("aria-expanded") === "false", "escape did not collapse the combobox");
    await input.fill("");
  });
}

async function popovers(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLive(page);
  for (const [trigger, dialog] of [[/^permissions/, "session permissions"], [/^settings$/, "settings"]] as const) {
    await check(`${name}: the ${dialog} popover takes focus, keeps Tab inside or closes, and Escape returns focus`, async () => {
      const button = page.getByRole("button", { name: trigger });
      await button.focus();
      await page.keyboard.press("Enter");
      const popover = page.getByRole("dialog", { name: dialog });
      await popover.waitFor();
      await page.waitForFunction((label) => document.activeElement?.closest(`[role="dialog"][aria-label="${label}"]`) !== null, dialog, { timeout: 5_000 })
        .catch(async () => { throw new Error(`opening did not move focus inside: ${await focused(page)}`); });
      for (let index = 0; index < 12; index++) {
        await page.keyboard.press(webkitTab(name, "Tab"));
        const inside = await popover.evaluate((node) => node.contains(document.activeElement)).catch(() => false);
        // A popover may let Tab leave, but then it must close: an open popover must never sit over the focused control.
        if (!inside) { expect(await popover.count() === 0, `Tab left the open popover for ${await focused(page)}, and it stayed open`); break; }
      }
      if (!await popover.count()) { await button.focus(); await page.keyboard.press("Enter"); await popover.waitFor(); }
      await page.keyboard.press("Escape");
      await popover.waitFor({ state: "detached" });
      expect(await button.evaluate((node) => node === document.activeElement), `escape left focus on ${await focused(page)}`);
    });
  }
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
async function keyboardComposer(page: Page, name: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLive(page);
  await check(`${name}: keyboard-only attachment removal returns focus to the composer`, async () => {
    const image = join(gammaHome, "a11y.png");
    await writeFile(image, png);
    await page.locator('input[type="file"]').setInputFiles(image);
    const remove = page.getByRole("button", { name: "remove a11y.png" });
    await remove.waitFor();
    await field(page).focus();
    for (let index = 0; index < 12 && !await remove.evaluate((node) => node === document.activeElement); index++) await page.keyboard.press(webkitTab(name, "Shift+Tab"));
    expect(await remove.evaluate((node) => node === document.activeElement), `keyboard did not reach remove; focus on ${await focused(page)}`);
    await page.keyboard.press("Enter");
    await remove.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.matches('textarea[aria-label="message"]'), undefined, { timeout: 5_000 })
      .catch(async () => { throw new Error(`focus after the last removal is on ${await focused(page)}`); });
  });
}

const ready = (page: Page) => page.locator('.status-line[data-state="ready"]').waitFor({ timeout: 15_000 });
/** Sends a message on an idle run and waits for zeta's reply turn to be running. */
async function startTurn(page: Page, text: string) {
  await ready(page);
  await field(page).fill(text);
  await field(page).press("Enter");
  await page.locator('.status-line[data-state="thinking"]').waitFor({ timeout: 10_000 });
}

/** Runs last on the shared turn: it approves the pending call, then stops a fresh turn. */
async function stoppedTurn(page: Page, name: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLive(page);
  await check(`${name}: a stopped turn reads as stopped in text, not only by color`, async () => {
    await pendingApproval(page).getByRole("button", { name: "approve", exact: true }).click();
    await startTurn(page, "start a turn to stop");
    await field(page).press("Escape");
    const row = page.locator('[data-part="timeline"] [data-kind="stopped"]').last();
    await row.waitFor({ timeout: 10_000 });
    await ready(page);
    const text = (await row.innerText()).toLowerCase();
    expect(/stopped/.test(text) && !/error|failed/.test(text), `stopped row text: ${JSON.stringify(text)}`);
    await dump(page, `${name}-stopped`);
  });
}

async function reducedMotion(browser: Browser, name: string) {
  await check(`${name}: reduced motion leaves no endless animation while the run works`, async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?run=${ACTIVE}`);
      await startTurn(page, "a turn to watch under reduced motion");
      const endless = () => page.evaluate(() => document.getAnimations().filter((animation) => {
        const timing = animation.effect?.getComputedTiming();
        return animation.playState === "running" && timing?.iterations === Infinity && Number(timing.duration) > 0;
      }).map((animation) => `${(animation.effect as KeyframeEffect | null)?.target?.className ?? "?"}${(animation.effect as KeyframeEffect | null)?.pseudoElement ?? ""}:${(animation as CSSAnimation).animationName ?? "?"}`));
      const reduced = await endless();
      // Control: the same probe sees the working pulse when motion is allowed, so an empty list above means something.
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const allowed = await endless();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await dump(page, `${name}-reduced-motion`);
      await field(page).press("Escape");
      await ready(page);
      expect(allowed.length > 0, "the animation probe saw no endless animation even with motion allowed");
      expect(!reduced.length, `endless animations under reduced motion: ${reduced.join(", ")}`);
    } finally { await context.close(); }
  });
}

/** 200% zoom of a 1440x900 window is a 720x450 CSS viewport; WCAG reflow is 320 CSS px wide (1280 at 400%). */
async function zoom(browser: Browser, name: string) {
  for (const [label, viewport] of [["200pct-zoom", { width: 720, height: 450 }], ["reflow-320", { width: 320, height: 568 }]] as const) {
    await check(`${name} ${label}: no horizontal scrolling, and the composer, send, and approval stay reachable`, async () => {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
      try {
        const page = await context.newPage();
        await openLive(page);
        await dump(page, `${name}-${label}`);
        const layout = await page.evaluate(() => {
          const box = (selector: string) => { const node = document.querySelector(selector)?.getBoundingClientRect(); return node ? { left: node.left, right: node.right, top: node.top, bottom: node.bottom, width: node.width, height: node.height } : null; };
          const sideways = [...document.querySelectorAll<HTMLElement>(".app *")].filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.right > innerWidth + 1 && getComputedStyle(node).position !== "fixed" && !node.closest(".scroll pre, .scroll code, .scroll [data-part='code']");
          }).slice(0, 5).map((node) => `${node.tagName.toLowerCase()}.${node.className}`);
          return { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, field: box('textarea[aria-label="message"]'), send: box('[data-part="composer"] button[type="submit"]'), sideways };
        });
        expect(layout.scroll <= layout.client, `document scrolls sideways: ${JSON.stringify(layout)}`);
        expect(!layout.sideways.length, `content past the right edge: ${layout.sideways.join(", ")}`);
        expect(layout.field && layout.field.width >= 120 && layout.field.right <= viewport.width && layout.field.bottom <= viewport.height, `composer field is not usable: ${JSON.stringify(layout.field)}`);
        expect(layout.send && layout.send.right <= viewport.width && layout.send.bottom <= viewport.height, `send is off screen: ${JSON.stringify(layout.send)}`);
        const link = page.getByRole("button", { name: "waiting for your approval" });
        await link.focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.activeElement?.matches('[data-part="approval"] button[data-action="approve"]'), undefined, { timeout: 5_000 })
          .catch(async () => { throw new Error(`focus is on ${await focused(page)}`); });
        const approve = await page.evaluate(() => { const rect = document.activeElement!.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, right: rect.right }; });
        expect(approve.top >= 0 && approve.bottom <= viewport.height && approve.right <= viewport.width, `approve is focused but off screen: ${JSON.stringify(approve)}`);
      } finally { await context.close(); }
    });
  }
}

async function journey(browserType: BrowserType, name: string) {
  const browser = await browserType.launch({ headless: true });
  // A browser process that dies mid-run leaves Playwright calls pending forever; fail the journey by name instead.
  let finished = false;
  const crashed = new Promise<never>((_, reject) => browser.on("disconnected", () => { if (!finished) reject(new Error(`${name} browser process exited mid-journey`)); }));
  try { await Promise.race([sections(browser, name), crashed]); }
  finally { finished = true; await browser.close(); }
}

async function sections(browser: Browser, name: string) {
  const page = await browser.newPage();
  // WebKit reports a poll that a navigation cancels as "... due to access control checks"; host-client catches that rejection.
  page.on("pageerror", (error) => { if (!/due to access control checks/.test(error.message)) failures.push(`${name} page error: ${error.message}`); });
  await namesAndApproval(page, name, 1440, 900);
  await namesAndApproval(page, name, 390, 844);
  await disabledReason(page, name);
  await commandListbox(page, name);
  await popovers(page, name);
  await keyboardComposer(page, name);
  // One controller at a time: leave the run before another context opens it.
  await page.goto("about:blank", { timeout: 15_000 });
  await zoom(browser, name);
  await stoppedTurn(page, name);
  await page.close();
  await reducedMotion(browser, name);
}

try {
  if (only.includes("chromium")) await withApp(port, () => journey(chromium, "chromium"));
  if (only.includes("webkit")) await withApp(port + 1, () => journey(webkit, "webkit"));
} finally {
  await rm(gammaHome, { recursive: true, force: true });
}
console.log(`a11y artifacts: ${artifacts}`);
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log(`a11y gate passed: ${passed} checks`);
