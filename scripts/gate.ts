// Browser gate for gamma's single run against the fake zeta server (scripts/fake-zeta.ts), at 1440, 1024, and 390 px.
// Fails on: a console error; a page that scrolls sideways; a button under 36 px (44 px at touch widths) or with no
// name; a native select/input/textarea (the composer's field is the one textarea, styled by @fulcrum/react); a composer
// that cannot send, steer the running turn, or stop it, or that offers input while offline; UI text under 4.5:1 on its
// real background in any of the 12 themes (syntax token colors are reported, not gated yet: they are the palettes' own);
// a connection state that does not show its title, the exact `zeta serve --ws-origin` command, or a retry, or that
// shows the problem a second time in the status line; history, markdown, highlighting, tool cards, approvals, or
// follow-bottom that do not work; a reconnect that loses or duplicates rows; a settings popover or theme picker that the
// keyboard cannot drive; model, YOLO, or image attach controls that do not reach zeta; a startup that shows a busy or
// error panel for a remembered run on an idle zeta; a status line that says "ready" while an approval waits; or a
// discovery retry that logs an error.
// Screenshots go to $WEB_SHOTS (default gate-artifacts).
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { themes } from "@fulcrum/react";
import { ACTIVE, startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.WEB_GATE_PORT ?? 4180);
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.WEB_SHOTS ?? join(root, "gate-artifacts");
await mkdir(shots, { recursive: true });
// A private gamma host, so the gate never touches a running one.
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-gate-"));
const fake = await startFakeZeta({ origins: [origin] });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) }, stdio: "ignore" });
const failures: string[] = [];
const fail = (message: string) => { failures.push(message); console.log(`FAIL ${message}`); };
const ok = (message: string) => console.log(`ok   ${message}`);
const check = async (name: string, run: () => Promise<void>) => {
  try { await run(); ok(name); } catch (error) { fail(`${name}: ${error instanceof Error ? error.message.split("\n")[0] : error}`); }
};

// Runs in the page: sideways scroll, control sizes and names, native controls, and text contrast.
function audit(minHeight: number) {
  const pixel = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })!;
  const rgba = (color: string) => { pixel.clearRect(0, 0, 1, 1); pixel.fillStyle = color; pixel.fillRect(0, 0, 1, 1); const [r, g, b, a] = pixel.getImageData(0, 0, 1, 1).data; return [r!, g!, b!, a! / 255]; };
  const over = (top: number[], bottom: number[]) => top.slice(0, 3).map((c, i) => c * top[3]! + bottom[i]! * (1 - top[3]!)).concat(1);
  const luminance = (c: number[]) => c.slice(0, 3).map((v) => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const backgroundOf = (start: Element | null) => {
    const layers: number[][] = [];
    for (let node = start; node; node = node.parentElement) if (layers.at(-1)?.[3] !== 1) layers.push(rgba(getComputedStyle(node).backgroundColor));
    return layers.reduceRight((below, layer) => over(layer, below), [255, 255, 255, 1]);
  };
  const contrast = (color: string, background: number[]) => {
    const [light, dark] = [luminance(over(rgba(color), background)), luminance(background)].sort((a, b) => b - a);
    return (light! + 0.05) / (dark! + 0.05);
  };
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none") return false;
    }
    return true;
  };
  const problems: string[] = [];
  const tokens: string[] = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${innerWidth}`);
  for (const native of document.querySelectorAll('select, input:not([hidden]), textarea:not([data-part="composer-field"] > textarea)')) problems.push(`native control <${native.tagName.toLowerCase()}>`);
  for (const button of document.querySelectorAll<HTMLElement>("button, [role=option]")) {
    if (!visible(button) || button.classList.contains("scrim")) continue;
    const name = (button.getAttribute("aria-label") ?? button.textContent ?? "").trim();
    if (!name) problems.push(`a ${button.tagName.toLowerCase()} has no accessible name`);
    if (getComputedStyle(button).appearance !== "none" && button.tagName === "BUTTON") problems.push(`button "${name}" keeps the browser appearance`);
    const height = button.getBoundingClientRect().height;
    const inTimeline = button.closest("[data-part=timeline]");
    const floor = button.matches("[role=option]") ? 32 : minHeight;
    if (!inTimeline && height < floor - 0.5) problems.push(`"${name.slice(0, 40)}" is ${Math.round(height)} px tall, needs ${floor}`);
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement;
    if (!element || seen.has(element) || !node.textContent?.trim() || !visible(element) || element.closest("[data-part=timeline-live]")) continue;
    seen.add(element);
    const style = getComputedStyle(element);
    let opacity = 1;
    for (let parent: Element | null = element; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity);
    const ratio = contrast(style.color, backgroundOf(element));
    const label = `${element.tagName.toLowerCase()}${element.className && typeof element.className === "string" ? "." + element.className.split(" ")[0] : ""} "${node.textContent.trim().slice(0, 30)}"`;
    if (ratio * Math.min(1, opacity) < 4.5) (element.closest("[class*=tok-]") ? tokens : problems).push(`${label} ${ratio.toFixed(2)}:1${opacity < 1 ? ` at opacity ${opacity.toFixed(2)}` : ""}`);
  }
  return { problems, tokens };
}

/** The composer takes input: connected, with the run (or the blank run) open. */
const ready = (page: Page, timeout = 10_000) => page.locator('.dock form[data-part="composer"]').waitFor({ timeout });
const settle = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const shoot = (page: Page, name: string) => page.screenshot({ path: join(shots, `${name}.png`) });
const tokenReport = new Map<string, Set<string>>();
async function auditThemes(page: Page, label: string, minHeight: number) {
  for (const theme of themes) {
    await page.evaluate((name) => { document.documentElement.dataset.fulcrumTheme = name; }, theme);
    await settle(page);
    const { problems, tokens } = await page.evaluate(audit, minHeight);
    for (const problem of problems) fail(`${label} ${theme}: ${problem}`);
    for (const token of tokens) (tokenReport.get(theme) ?? tokenReport.set(theme, new Set()).get(theme)!).add(token.replace(/ "[^"]*"/, ""));
  }
  await page.evaluate(() => { document.documentElement.dataset.fulcrumTheme = "tokyo-night"; });
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const page = await context.newPage();
    const errors: string[] = [];
    // A stopped zeta is a normal state: its retries must not log errors (a WebSocket the server refuses still does).
    page.on("console", (message) => { if (message.type() === "error" && !/WebSocket connection/.test(message.text())) errors.push(message.text()); });
    page.on("response", (response) => { if (response.url().includes("/__fulcrum/zeta") && response.status() >= 400) errors.push(`discovery answered ${response.status()}`); });
    page.on("pageerror", (error) => errors.push(error.message));

    // The first load pays for vite's dependency scan, which can reload the page once.
    await page.goto(`${origin}/?theme=tokyo-night`);
    await page.locator(".brand").waitFor({ timeout: 60_000 });
    await page.waitForLoadState("networkidle");

    // Connection states, each from a fresh load.
    const states: Array<[string, () => Promise<void>, RegExp, boolean]> = [
      ["not-running", () => fake.stop(), /zeta serve is not running/, true],
      ["auth-failed-origin", async () => { await fake.start(); await fake.foreignOrigin(); }, /auth failed/, true],
      ["auth-failed-token", async () => { await fake.start(); await fake.wrongToken(); }, /auth failed/, true],
      ["busy", async () => { await fake.start(); fake.setMode("busy"); }, /zeta serve is in use/, false],
      ["incompatible", async () => { fake.setMode("incompatible"); }, /unsupported protocol version/, false],
    ];
    for (const [name, arrange, title, command] of states) {
      await check(`state ${name}`, async () => {
        await arrange();
        await page.goto(`${origin}/?theme=tokyo-night`);
        await page.getByRole("heading", { name: title }).waitFor({ timeout: 5000 });
        if (command) {
          const shown = await page.locator(".panel .command code").textContent();
          // The isolated fake port is required even while stopped; the gate must never suggest or probe zeta's live default.
          if (shown !== `zeta serve --ws ${fake.port} --ws-origin ${origin}`) throw new Error(`command is "${shown}"`);
          await page.locator('.panel .command code [class*="tok-"]').first().waitFor({ timeout: 3000 }).catch(() => { throw new Error("the command is not highlighted"); });
        }
        if (name !== "incompatible") await page.getByRole("button", { name: "retry now" }).waitFor();
        // One problem, one home: the panel. The dock adds no status line and no composer note about it.
        if (await page.locator(".status-line").count()) throw new Error("the problem shows again in the dock");
        await shoot(page, `state-${name}-1440`);
      });
    }
    await check("state connecting: the status line says connecting, with no panel", async () => {
      fake.setMode("slow");
      await page.goto(`${origin}/?theme=tokyo-night`);
      await page.locator('.status-line[data-state="connecting"]').waitFor({ timeout: 5000 });
      if (await page.locator(".panel").count()) throw new Error("a panel shows while connecting");
      await shoot(page, "state-connecting-1440");
    });
    fake.setMode("ok");
    await fake.start();
    await check("retry now connects once the server is back", async () => {
      await page.goto(`${origin}/?theme=tokyo-night`);
      await ready(page, 5000);
    });

    await check("startup: a remembered run on an idle zeta reopens with no busy or error panel", async () => {
      fake.setLive(false);
      try {
        await page.goto("about:blank");
        fake.drop();
        await fake.start();
        await page.goto(`${origin}/?theme=tokyo-night`);
        await page.evaluate(() => localStorage.setItem("gamma-run", "s-themes"));
        await page.goto(`${origin}/?theme=tokyo-night`);
        await page.locator('[data-part="timeline"] [data-kind="user"]').first().waitFor({ timeout: 15_000 });
        await ready(page);
        if (await page.locator(".panel, [role=alert]").count()) throw new Error(`startup shows "${await page.locator(".panel, [role=alert]").first().textContent()}"`);
        if (!new URL(page.url()).searchParams.get("run")) throw new Error("the remembered run is not in the url");
      } finally {
        await page.evaluate(() => localStorage.removeItem("gamma-run"));
        fake.setLive(true);
        fake.drop();
        await fake.start();
      }
    });

    // Connected: the server's active run, history, live run, approval, follow-bottom.
    await check("the server's session opens with history, markdown, highlighting, and tool cards", async () => {
      await page.goto(`${origin}/?theme=tokyo-night&run=${ACTIVE}`);
      await page.locator('[data-part="timeline"] [data-part="message"]').first().waitFor();
      if (!(await page.locator('[data-part="timeline"] [data-part="tool"]').count())) throw new Error("no tool card");
      if (await page.locator('[data-part="timeline"] [data-part="tool"][data-state="streaming"]').count() > 1) throw new Error("history tool left running");
    });
    await check("shell cards are highlighted: line 1 of the command has token colors", async () => {
      const summary = page.locator('[data-tool-view="shell"] [data-part="tool-summary"]').first();
      await summary.waitFor({ timeout: 5000 });
      await summary.locator('[class*="tok-"]').first().waitFor({ timeout: 5000 }).catch(() => { throw new Error("no token spans in the shell header"); });
      const colors = await summary.evaluate((node) => new Set([...node.querySelectorAll('[class*="tok-"]')].map((span) => getComputedStyle(span).color)).size);
      if (colors < 2) throw new Error(`the shell header has ${colors} token color(s)`);
    });
    await check("live run keeps one approval through a negotiated reconnect and resumes after approval", async () => {
      await page.locator('[data-tool-view="shell"]').first().waitFor({ timeout: 5000 });
      await page.locator(".scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      const approval = page.locator('[data-part="approval"][data-state="pending"]');
      await approval.waitFor({ timeout: 5000 });
      // The run is blocked on the user, not running: the status line says so, with the warn color.
      const header = page.locator(".status-line");
      await header.filter({ hasText: "waiting for your approval" }).waitFor({ timeout: 10_000 }).catch(async () => { throw new Error(`the status line says "${await header.textContent()}" while an approval waits`); });
      const [mark, warn] = await header.evaluate((node) => [getComputedStyle(node, "::before").backgroundColor, (() => { const probe = document.createElement("span"); probe.style.color = "var(--fulcrum-warn)"; node.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; })()]);
      if (mark !== warn) throw new Error(`the header mark is ${mark}, not the warn color ${warn}`);
      await shoot(page, "connected-approval-1440-tokyo-night");
      await fake.start();
      // A stopped server (not a blip): the banner and the offline composer resize the scroll box while it waits.
      await fake.stop();
      await page.getByText(/connection lost|reconnecting/).first().waitFor({ timeout: 3000 });
      // A drop keeps the reader where they were and the draft editable, but blocks sending.
      const offlineField = page.locator('.dock textarea[aria-label="message"]');
      await offlineField.waitFor({ timeout: 3000 });
      if (await offlineField.evaluate((node) => (node as HTMLTextAreaElement).readOnly)) throw new Error("the outage made the draft read-only");
      if (!(await page.getByRole("button", { name: "send message" }).isDisabled())) throw new Error("sending stayed enabled while offline");
      await settle(page);
      await page.waitForTimeout(500);
      const kept = await page.locator(".scroll").evaluate((element) => {
        const box = element.getBoundingClientRect();
        const row = element.querySelector('[data-part="approval"][data-state="reconnecting"]')?.getBoundingClientRect();
        return { gap: element.scrollHeight - element.clientHeight - element.scrollTop, scrollTop: element.scrollTop, inView: !!row && row.bottom > box.top && row.top < box.bottom };
      });
      if (!(await page.locator(".scroll[data-stale=true]").count())) throw new Error("old view was not marked stale");
      const staleApproval = page.locator('[data-part="approval"][data-state="reconnecting"]');
      await staleApproval.getByRole("button", { name: "approve" }).waitFor();
      await staleApproval.getByRole("button", { name: "deny" }).waitFor();
      if (!(await staleApproval.getByRole("button", { name: "approve" }).isDisabled()) || !(await staleApproval.getByRole("button", { name: "deny" }).isDisabled())) throw new Error("reconnecting approval buttons were not disabled");
      await staleApproval.getByText(/decisions are disabled/).waitFor();
      await fake.start();
      // The client's retry backoff grows while the server is down; retry at once, as a user would.
      await page.locator(".notice").getByRole("button", { name: "retry now" }).click({ timeout: 2000 }).catch(() => {});
      await ready(page);
      await page.locator(".notice").waitFor({ state: "detached" });
      const reconnected = page.locator('[data-part="approval"]');
      await reconnected.getByRole("button", { name: "approve" }).waitFor({ timeout: 5000 });
      if (await reconnected.count() !== 1) throw new Error("duplicate approval rows after reconnect");
      await shoot(page, "approval-reconnected-1440");
      await page.setViewportSize({ width: 390, height: 844 });
      await shoot(page, "approval-reconnected-390");
      await page.setViewportSize({ width: 1440, height: 900 });
      await reconnected.getByRole("button", { name: "approve" }).click();
      const rebuilt = page.locator('[data-part="tool"]', { has: page.locator('[data-part="tool-approval"]') });
      await rebuilt.waitFor({ timeout: 5000 });
      if (await rebuilt.count() !== 1 || await page.locator('[data-part="approval"]').count()) throw new Error("approval did not fold once after the resumed command");
      if (await page.locator('[data-tone="danger"]').count()) throw new Error("reconnect showed an app error");
      if (fake.decisions.filter((decision) => decision.method === "approve" && decision.request_id === "approval-1").length !== 1) throw new Error("server did not receive exactly one resumed approval");
      // Reported after the reconnect, so a failure here does not leave the server stopped for later checks.
      if (kept.gap > 4 || !kept.inView) throw new Error(`the stop moved the view: ${Math.round(kept.gap)} px from the bottom at scrollTop ${Math.round(kept.scrollTop)}, pending approval in view: ${kept.inView}`);
    });
    await check("follows the bottom while the run streams", async () => {
      await settle(page);
      const gap = await page.locator(".scroll").evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
      if (gap > 4) throw new Error(`${Math.round(gap)} px from the bottom`);
    });
    await shoot(page, "connected-1440-tokyo-night");
    for (const theme of ["gruvbox-dark", "catppuccin-latte", "dracula"]) {
      await page.evaluate((name) => { document.documentElement.dataset.fulcrumTheme = name; }, theme);
      await settle(page);
      await shoot(page, `connected-1440-${theme}`);
    }
    await check("history start: the user prompt and highlighted code render when scrolled to", async () => {
      // Virtual rows mount only near the viewport, so read the start of the history from the top.
      await page.locator(".scroll").evaluate((element) => { element.scrollTop = 0; });
      await page.locator('[data-part="timeline"] [data-kind="user"]').first().waitFor();
      await page.locator('[data-part="timeline"] [data-part="md-code-block"] [class*="tok-"]').first().waitFor({ timeout: 10_000 });

      await page.locator('[data-part="jump-to-latest"]').waitFor({ state: "detached", timeout: 1000 }).catch(() => {});
    });
    await check("desktop layout, controls, and contrast in all 12 themes", () => auditThemes(page, "1440", 36));

    await check("a dropped socket shows 'connection lost', reconnects, and rebuilds without lost or duplicate rows", async () => {
      // Start with one current controller so this check also catches a late close releasing its replacement.
      await page.reload();
      await ready(page);
      const initial = page.locator('.scroll[data-run-ready="true"]');
      await initial.waitFor({ timeout: 10_000 });
      await page.locator('[data-part="timeline"] [data-id]').first().waitFor({ timeout: 10_000 });
      await settle(page);
      await page.locator(".dock textarea").fill("draft kept across disconnect");
      const historyRequests = fake.requests.filter(({ method }) => method === "session_history").length;
      await fake.stop();
      await page.getByText("connection lost: zeta serve stopped").waitFor({ timeout: 5000 });
      // The command names the port the page was connected to, not a default.
      const command = await page.locator(".notice .command code").textContent();
      if (command !== `zeta serve --ws ${fake.port} --ws-origin ${origin}`) throw new Error(`the banner command is "${command}"`);
      await Bun.sleep(2000); // a few quiet retries; the console listener fails the gate on any error
      await shoot(page, "state-lost-1440");
      if (!(await page.locator('[data-part="timeline"] [data-id]').count())) throw new Error("transcript hidden while offline");
      const draft = page.locator('.dock textarea[aria-label="message"]');
      await draft.waitFor({ timeout: 2000 });
      if (await page.locator(".status-line").count()) throw new Error("the stopped server shows again in the dock");
      if ((await draft.inputValue()) !== "draft kept across disconnect" || await draft.evaluate((node) => (node as HTMLTextAreaElement).readOnly)) throw new Error("the offline composer did not keep an editable draft");
      if (!(await page.getByRole("button", { name: "send message" }).isDisabled())) throw new Error("sending stayed enabled while offline");
      await fake.start();
      await page.getByRole("button", { name: "retry now" }).click();
      await ready(page);
      await page.locator(".notice").waitFor({ state: "detached" });
      try {
        // The replacement virtual timeline starts at the bottom, where an old user row need not be mounted.
        for (let attempt = 0; fake.requests.filter(({ method, replied }) => method === "session_history" && replied !== undefined).length <= historyRequests && attempt < 500; attempt++) await Bun.sleep(10);
        if (fake.requests.filter(({ method, replied }) => method === "session_history" && replied !== undefined).length <= historyRequests) throw new Error("server did not replay history");
        await page.locator('.scroll:not([data-stale]) [data-part="timeline"] [data-id]').first().waitFor({ timeout: 10_000 });
      } catch {
        const state = await page.locator(".badge, .notice, .panel").allTextContents();
        const recent = fake.requests.slice(-8).map(({ method, received, replied }) => `${method}:${replied === undefined ? "pending" : Math.round(replied - received) + "ms"}`);
        throw new Error(`transcript did not rebuild; page=${JSON.stringify(state)} requests=${recent.join(",")}`);
      }
      const ids = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-part="timeline"] [data-id]')].map((item) => item.dataset.id));
      if (new Set(ids).size !== ids.length) throw new Error("duplicate rows after reconnect");
      if (await page.locator('[data-part="approval"][data-state="pending"]').count()) throw new Error("a dropped approval came back as pending");
    });

    await check("keyboard: the settings popover and its theme picker work from the keyboard", async () => {
      fake.setLive(false);
      await fake.start();
      fake.setOpenDelay(200);
      await page.goto(`${origin}/?theme=tokyo-night&run=s-themes`);
      await page.getByRole("button", { name: "settings" }).focus();
      await page.waitForTimeout(250);
      if (!(await page.evaluate(() => document.activeElement?.textContent === "settings"))) throw new Error("opening the run stole focus from the settings button");
      fake.setOpenDelay(0);
      await page.locator('[data-run-ready="true"]').waitFor();
      await page.locator('[data-part="md-table"]').waitFor({ timeout: 5000 });
      await page.keyboard.press("Enter");
      await page.getByRole("dialog", { name: "settings" }).waitFor();
      await page.locator(".theme-button").focus();
      await page.keyboard.press("Enter");
      await page.getByRole("listbox", { name: "theme" }).waitFor();
      await shoot(page, "theme-picker-1440");
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      const theme = await page.evaluate(() => document.documentElement.dataset.fulcrumTheme);
      if (theme !== "one-dark") throw new Error(`theme is ${theme}`);
      if (!(await page.evaluate(() => document.activeElement?.classList.contains("theme-button")))) throw new Error("focus did not return to the picker");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Escape");
      if (await page.getByRole("listbox").count()) throw new Error("Escape did not close the picker");
      await page.keyboard.press("Escape");
      if (await page.getByRole("dialog", { name: "settings" }).count()) throw new Error("Escape did not close the settings popover");
      if (!(await page.evaluate(() => document.activeElement?.textContent === "settings"))) throw new Error("focus did not return to the settings button");
    });
    await check("model, YOLO, reconnect persistence, image queue, and image viewer", async () => {
      const footer = page.locator('.dock [data-part="composer"] .composer-tools');
      await footer.getByRole("button", { name: /model: (?:default \()?claude-opus-4-6/ }).click({ timeout: 5000 }).catch(() => { throw new Error("footer model picker did not open"); });
      await footer.getByRole("option", { name: "gpt-5.1-codex" }).click({ timeout: 5000 }).catch(() => { throw new Error("model option could not be selected"); });
      await footer.getByRole("button", { name: "model: gpt-5.1-codex" }).waitFor({ timeout: 5000 }).catch(() => { throw new Error("model change did not reload from zeta"); });
      if (fake.settings.model !== "gpt-5.1-codex") throw new Error("model change did not reach zeta");

      await footer.getByRole("button", { name: /^approval mode: Ask/ }).click({ timeout: 5000 }).catch(() => { throw new Error("Ask control could not open YOLO confirmation"); });
      await page.getByRole("button", { name: "allow" }).click();
      await page.locator(".topbar-yolo", { hasText: "YOLO" }).waitFor({ timeout: 5000 }).catch(() => { throw new Error("top bar YOLO indicator did not appear"); });
      await footer.locator(".approval-mode[data-yolo]", { hasText: "YOLO" }).waitFor({ timeout: 5000 }).catch(() => { throw new Error("footer YOLO control did not turn on"); });
      if (fake.settings.approval_mode !== "allow") throw new Error("YOLO mode did not reach zeta");
      await shoot(page, "yolo-1440");
      fake.drop();
      await page.getByText(/connection lost|reconnecting/).first().waitFor({ timeout: 3000 });
      await ready(page);
      await page.locator(".topbar-yolo", { hasText: "YOLO" }).waitFor({ timeout: 5000 });
      await footer.locator(".approval-mode[data-yolo]").waitFor({ timeout: 5000 });

      const input = page.locator('.dock [data-part="composer"] input[type="file"]');
      const image = { name: "pixel.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") };
      await input.setInputFiles(image);
      await page.getByRole("button", { name: "remove pixel.png" }).waitFor({ timeout: 5000 }).catch(() => { throw new Error("file chooser image did not queue"); });
      await page.getByRole("button", { name: "remove pixel.png" }).click();
      await page.locator('.dock [data-part="composer"] textarea').evaluate((field) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" }));
        field.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true }));
      });
      await page.getByRole("button", { name: "remove pasted.png" }).waitFor({ timeout: 5000 }).catch(() => { throw new Error("pasted image did not queue"); });
      await page.getByRole("button", { name: "remove pasted.png" }).click();
      await page.locator('.dock [data-part="composer"]').evaluate((composer) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", { type: "image/png" }));
        composer.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true }));
      });
      await page.getByRole("button", { name: "remove dropped.png" }).waitFor({ timeout: 5000 }).catch(() => { throw new Error("dropped image did not queue"); });
      await shoot(page, "queued-images-1440");
      await page.getByRole("button", { name: "remove dropped.png" }).click();
      await input.setInputFiles(Array.from({ length: 5 }, (_, index) => ({ ...image, name: `limit-${index}.png` })));
      await page.getByRole("alert").filter({ hasText: "up to 4 images" }).waitFor({ timeout: 5000 }).catch(() => { throw new Error("image count limit did not show its error"); });
      const limitRemoves = page.getByRole("button", { name: /^remove limit-/ });
      while (await limitRemoves.count()) await limitRemoves.first().click();
      await input.setInputFiles({ name: "large.png", mimeType: "image/png", buffer: Buffer.alloc(512 * 1024 + 1) });
      await page.getByRole("alert").filter({ hasText: "512 KiB" }).waitFor({ timeout: 5000 }).catch(() => { throw new Error("image byte limit did not show its error"); });

      await page.locator(".scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await settle(page);
      const openImage = page.getByRole("button", { name: "open image: contrast-preview.png" });
      await openImage.waitFor({ timeout: 5000 }).catch(() => { throw new Error("desktop output image was not rendered"); });
      await openImage.click();
      await page.getByRole("dialog", { name: "contrast-preview.png" }).waitFor({ timeout: 5000 }).catch(() => { throw new Error("desktop image viewer did not open"); });
      await shoot(page, "image-viewer-1440");
      await page.keyboard.press("Escape");
      if (!(await openImage.evaluate((element) => document.activeElement === element))) throw new Error("image viewer did not return focus");

      // A zeta without these requests answers "method not found": the footer then offers neither control.
      fake.setSettingsEnabled(false);
      fake.drop();
      await ready(page);
      await page.locator(".dock .model-picker").waitFor({ state: "detached", timeout: 5000 }).catch(() => { throw new Error("unsupported server kept the model picker"); });
      if (await page.getByRole("button", { name: /^approval mode/ }).count()) throw new Error("unsupported server kept approval controls");
      fake.setSettingsEnabled(true);
      fake.drop();
      await ready(page);
    });
    await check("a 400-row history opens in virtual mode and lands at the bottom", async () => {
      await page.goto(`${origin}/?theme=tokyo-night&run=s-long`);
      await page.locator('[data-part="timeline"][data-virtual="true"]').waitFor({ timeout: 10_000 });
      await page.getByText("frame 399 took").waitFor({ timeout: 5000 });
    });
    await check("composer: Enter sends, steer while running, a steer the turn dropped is resent, stop ends it, all with delivery ids", async () => {
      await page.goto(`${origin}/?theme=tokyo-night&run=s-themes`);
      await page.locator('[data-part="md-table"]').waitFor({ timeout: 5000 });
      await ready(page);
      const composer = page.locator('.dock [data-part="composer"]');
      const field = composer.locator("textarea");
      await field.click();
      await field.fill("run the focused tests");
      await page.keyboard.press("Enter");
      await composer.and(page.locator('[data-state="steerable"]')).waitFor({ timeout: 5000 });
      if (!(await field.evaluate((node) => document.activeElement === node))) throw new Error("focus left the field after send");
      if (await field.inputValue()) throw new Error("draft not cleared after send");
      await page.locator('[data-part="timeline"] [data-kind="user"]', { hasText: "run the focused tests" }).waitFor({ timeout: 3000 });
      const submit = composer.locator('[data-part="composer-submit"]');
      if ((await submit.textContent()) !== "steer") throw new Error(`action reads "${await submit.textContent()}" while running`);
      await field.fill("also check the windows path");
      await submit.click();
      await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".dock textarea")?.value === "", undefined, { timeout: 3000 });
      await shoot(page, "composer-running-1440-tokyo-night");
      // The fake turn has no tool call, so it ends with the steer still queued and drops it, as zeta does; the app
      // resends it as the next message, which starts a new turn.
      for (let i = 0; i < 100 && fake.sent.length < 3; i++) await Bun.sleep(100);
      await composer.and(page.locator('[data-state="steerable"]')).waitFor({ timeout: 5000 });
      // One message the user wrote is one row: the steer's row became the resent message, it was not added again.
      const steerRows = page.locator('[data-part="timeline"] [data-kind="user"]', { hasText: "also check the windows path" });
      await Bun.sleep(300);
      if ((await steerRows.count()) !== 1) throw new Error(`the resent steer shows in ${await steerRows.count()} rows`);
      await shoot(page, "composer-resent-steer-1440-tokyo-night");
      await composer.locator('[data-part="composer-stop"]').click();
      await composer.and(page.locator('[data-state="idle"]')).waitFor({ timeout: 5000 });
      // The user's own stop is a neutral row, not an error.
      await page.locator('[data-part="timeline"] [data-kind="stopped"]').first().waitFor({ timeout: 3000 });
      const sent = fake.sent.map((entry) => `${entry.method}:${entry.text}`);
      if (sent.join(",") !== "send:run the focused tests,steer:also check the windows path,send:also check the windows path") throw new Error(`server saw ${sent.join(", ")}`);
      const ids = fake.sent.map((entry) => entry.delivery_id);
      if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) throw new Error(`delivery ids ${ids.join(", ")}`);
      if (fake.aborts !== 1) throw new Error(`${fake.aborts} aborts`);
      await shoot(page, "composer-stopped-1440-tokyo-night");
    });
    await check("a steer that a stop drops is marked not delivered; focus stays in the field when stop goes away", async () => {
      const composer = page.locator('.dock [data-part="composer"]');
      const field = composer.locator("textarea");
      await field.fill("start another turn");
      await page.keyboard.press("Enter");
      await composer.and(page.locator('[data-state="steerable"]')).waitFor({ timeout: 5000 });
      // Steer is not a warning: neither the button nor the rail uses the warning color.
      const warnUsed = await composer.evaluate((node) => {
        const probe = document.createElement("i");
        probe.style.color = "var(--fulcrum-warn)";
        node.append(probe);
        const warn = getComputedStyle(probe).color;
        probe.remove();
        const submit = getComputedStyle(node.querySelector('[data-part="composer-submit"]')!);
        return [submit.backgroundColor, submit.borderTopColor, getComputedStyle(node).borderLeftColor].filter((color) => color === warn);
      });
      if (warnUsed.length) throw new Error("steer uses the warning color");
      const before = fake.sent.length;
      await field.fill("steer: keep it short");
      await page.keyboard.press("Enter");
      for (let i = 0; i < 30 && fake.sent.length === before; i++) await Bun.sleep(100);
      await page.locator('[data-part="timeline"] [data-kind="user"]', { hasText: "steer: keep it short" }).waitFor({ timeout: 3000 });
      await composer.locator('[data-part="composer-stop"]').focus();
      await page.keyboard.press("Enter");
      await composer.and(page.locator('[data-state="idle"]')).waitFor({ timeout: 5000 });
      await settle(page);
      await page.locator(".undelivered", { hasText: "not delivered" }).waitFor({ timeout: 3000 }).catch(() => { throw new Error("the dropped steer is not marked as not delivered"); });
      const marked = await page.locator('[data-part="timeline"] [data-kind="user"]', { hasText: "steer: keep it short" }).evaluate((row) => row.nextElementSibling?.classList.contains("undelivered") ?? false);
      if (!marked) throw new Error("the not-delivered mark is not on the steer's row");
      await Bun.sleep(300);
      if (fake.sent.filter((entry) => entry.text === "steer: keep it short").length !== 1) throw new Error("a steer the user stopped was resent");
      const active = await page.evaluate(() => document.activeElement?.tagName);
      if (active !== "TEXTAREA") throw new Error(`focus went to ${active} when the stop button went away`);
      await shoot(page, "composer-steer-dropped-1440-tokyo-night");
    });
    await check("the page never scrolls: after IME typing the document fits the viewport and the headers stay in view", async () => {
      // A tall run: the Timeline's hidden live region sits at the end of 400 rows.
      await page.goto(`${origin}/?theme=tokyo-night&run=s-long`);
      await page.locator('[data-part="timeline"][data-virtual="true"]').waitFor({ timeout: 10_000 });
      await ready(page);
      const field = page.locator(".dock textarea");
      await field.click();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.imeSetComposition", { text: "にほんご", selectionStart: 4, selectionEnd: 4 });
      await cdp.send("Input.insertText", { text: "日本語のテスト" });
      await page.keyboard.type(": hello");
      // The run read from its top: the hidden live region then sits furthest below the scroll box.
      await page.locator(".scroll").evaluate((element) => { element.scrollTop = 0; });
      await settle(page);
      const layout = await page.evaluate(() => ({
        height: document.scrollingElement!.scrollHeight,
        viewport: innerHeight,
        y: scrollY,
        tops: [".topbar", ".brand"].map((selector) => document.querySelector(selector)!.getBoundingClientRect().top),
        overflow: [getComputedStyle(document.documentElement).overflow, getComputedStyle(document.body).overflow],
      }));
      if (layout.height > layout.viewport) throw new Error(`the document is ${layout.height} px tall on a ${layout.viewport} px viewport`);
      if (layout.y !== 0 || layout.tops.some((top) => top < 0)) throw new Error(`the page scrolled: scrollY ${layout.y}, header tops ${layout.tops.join(", ")}`);
      if (layout.overflow.some((value) => value !== "hidden")) throw new Error(`html and body overflow are ${layout.overflow.join(", ")}`);
      await field.fill("");
    });
    await check("composer: the text and the buttons sit at even insets; 14 px text on desktop", async () => {
      const insets = await page.locator('.dock [data-part="composer"]').evaluate((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const field = node.querySelector("textarea")!;
        const fieldBox = field.getBoundingClientRect();
        const fieldStyle = getComputedStyle(field);
        const submit = node.querySelector('[data-part="composer-submit"]')!.getBoundingClientRect();
        return {
          left: fieldBox.left + parseFloat(fieldStyle.paddingLeft) - (box.left + parseFloat(style.borderLeftWidth)),
          top: fieldBox.top + parseFloat(fieldStyle.paddingTop) - (box.top + parseFloat(style.borderTopWidth)),
          right: box.right - parseFloat(style.borderRightWidth) - submit.right,
          bottom: box.bottom - parseFloat(style.borderBottomWidth) - submit.bottom,
          font: parseFloat(fieldStyle.fontSize),
        };
      });
      const sides = [insets.left, insets.top, insets.right, insets.bottom];
      if (Math.max(...sides) - Math.min(...sides) > 2) throw new Error(`insets left ${insets.left}, top ${insets.top}, right ${insets.right}, bottom ${insets.bottom}`);
      if (insets.font !== 14) throw new Error(`desktop field text is ${insets.font} px`);
    });
    await check("composer: layout, controls, and contrast in all 12 themes after a run", () => auditThemes(page, "1440 composer", 36));
    await check("a fresh zeta: the blank run focuses the composer; the first send creates the run; new run clears it", async () => {
      fake.setEmpty(true);
      await page.evaluate(() => { localStorage.removeItem("gamma-run"); localStorage.removeItem("gamma-model"); });
      await page.goto(`${origin}/?theme=tokyo-night`);
      await ready(page, 5000);
      await page.locator(".empty-run", { hasText: "start a conversation" }).waitFor({ timeout: 3000 });
      const focused = await page.evaluate(() => document.activeElement?.closest(".dock") !== null && document.activeElement?.tagName === "TEXTAREA");
      if (!focused) throw new Error(`focus is on ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 60))}, not the composer`);
      await shoot(page, "empty-1440-tokyo-night");
      await page.keyboard.type("hello from a new run");
      await page.keyboard.press("Enter");
      await page.waitForURL(/[?&]run=/, { timeout: 5000 });
      await page.locator('[data-part="timeline"] [data-kind="user"]', { hasText: "hello from a new run" }).waitFor({ timeout: 3000 });
      await page.locator(".empty-run").waitFor({ state: "detached", timeout: 3000 });
      await page.locator('.dock [data-part="composer"][data-state="idle"]').waitFor({ timeout: 10_000 });
      const oldRun = new URL(page.url()).searchParams.get("run");
      await page.getByRole("button", { name: "new run" }).click();
      await page.locator(".empty-run").waitFor({ timeout: 5000 });
      const draftRun = new URL(page.url()).searchParams.get("run");
      if (!draftRun?.startsWith("draft:") || draftRun === oldRun) throw new Error("new run did not get its own draft history entry");
      await auditThemes(page, "1440 new run", 36);
      fake.setEmpty(false);
    });
    if (errors.length) fail(`desktop console: ${errors.join("; ")}`);
    await context.close();

    await check("1024: the theme picker shows every theme name in full", async () => {
      const mid = await browser.newContext({ viewport: { width: 1024, height: 768 } });
      const tablet = await mid.newPage();
      const cut: string[] = [];
      for (const theme of themes) {
        await tablet.goto(`${origin}/?theme=${theme}`);
        await tablet.getByRole("button", { name: "settings" }).click();
        const name = tablet.locator(".theme-name");
        await name.waitFor({ timeout: 5000 });
        if (await name.evaluate((node) => node.scrollWidth > node.clientWidth + 0.5)) cut.push(theme);
      }
      await mid.close();
      if (cut.length) throw new Error(`cut: ${cut.join(", ")}`);
    });

    // Mobile: drawer, layout, contrast.
    fake.setLive(true);
    await fake.start();
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const mobile = await phone.newPage();
    const mobileErrors: string[] = [];
    mobile.on("pageerror", (error) => mobileErrors.push(error.message));
    await check("390: the run fills the width; settings, model, YOLO, images, and the viewer work", async () => {
      await mobile.goto(`${origin}/?theme=gruvbox-dark&run=s-themes`);
      await mobile.locator('[data-part="timeline"] [data-kind="user"]').first().waitFor({ timeout: 5000 });
      // A reopened, approved bash call is the live shell card: its command (from the approval row), its output without
      // zeta's raw "stdout:"/"stderr:" labels, and exit 0.
      const reopened = mobile.locator('[data-part="timeline"] [data-tool-view="shell"]', { hasText: "ls packages/react/src" });
      await reopened.waitFor({ timeout: 5000 }).catch(() => { throw new Error("the reopened bash call is not a shell card with its command"); });
      const card = await reopened.innerText();
      if (/\bstdout:|\bstderr:/.test(card) || !card.includes("themes.ts") || !card.includes("exit 0")) throw new Error(`the reopened bash card reads "${card.replace(/\s+/g, " ")}"`);
      await ready(mobile);
      await shoot(mobile, "connected-390-gruvbox-dark");
      await mobile.getByRole("button", { name: "settings" }).click();
      await mobile.getByRole("dialog", { name: "settings" }).waitFor();
      await auditThemes(mobile, "390 settings", 44);
      await mobile.keyboard.press("Escape");
      if (await mobile.getByRole("dialog").count()) throw new Error("Escape did not close the settings popover");
      await mobile.locator('[data-part="md-table"]').waitFor({ timeout: 5000 });
      await mobile.evaluate(() => { document.documentElement.dataset.fulcrumTheme = "solarized-light"; });
      await shoot(mobile, "connected-390-solarized-light");
      const footer = mobile.locator('.dock [data-part="composer"] .composer-tools');
      await footer.locator(".approval-mode").waitFor();
      await footer.getByRole("button", { name: /^model: / }).waitFor();
      for (const control of [footer.getByRole("button", { name: /^model: / }), footer.locator(".approval-mode")])
        if (await control.evaluate((node) => { const box = node.getBoundingClientRect(); return box.right > innerWidth || box.left < 0; })) throw new Error("a footer control is off screen at 390");
      await shoot(mobile, "yolo-390");
      await mobile.locator(".scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await settle(mobile);
      await mobile.waitForTimeout(300);
      const mobileImage = mobile.getByRole("button", { name: "open image: contrast-preview.png" });
      await mobileImage.waitFor({ timeout: 5000 }).catch(() => { throw new Error("mobile output image was not rendered"); });
      await mobileImage.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await mobileImage.click({ timeout: 5000 }).catch(() => { throw new Error("mobile output image could not be opened"); });
      await mobile.getByRole("dialog", { name: "contrast-preview.png" }).waitFor();
      await shoot(mobile, "image-viewer-390");
      await mobile.keyboard.press("Escape");
      await mobile.locator('.dock [data-part="composer"] input[type="file"]').setInputFiles({ name: "mobile.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
      await mobile.getByRole("button", { name: "remove mobile.png" }).waitFor();
      if (!(await mobile.locator('[data-part="attachment"] img').evaluate((node) => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0))) throw new Error("the queued image thumbnail did not load");
      await shoot(mobile, "queued-images-390");
    });
    await check("390: the field text is at least 16 px, so iOS does not zoom on focus", async () => {
      const size = await mobile.locator(".dock textarea").evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
      if (size < 16) throw new Error(`field text is ${size} px`);
    });
    await check("390 layout, 44 px targets, and contrast in all 12 themes", () => auditThemes(mobile, "390", 44));
    await check("390 connection state shows the command and fits", async () => {
      await fake.stop();
      await mobile.goto(`${origin}/?theme=catppuccin-latte`);
      await mobile.getByRole("heading", { name: /zeta serve is not running/ }).waitFor({ timeout: 5000 });
      await shoot(mobile, "state-not-running-390");
      await auditThemes(mobile, "390 not running", 44);
      await fake.start();
    });
    if (mobileErrors.length) fail(`mobile errors: ${mobileErrors.join("; ")}`);
    await phone.close();
  } finally {
    await browser.close();
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  vite.kill("SIGTERM");
  await fake.close();
}
for (const [theme, tokens] of tokenReport) console.log(`note ${theme}: syntax tokens under 4.5:1 (palette colors, not gated): ${[...tokens].join(", ")}`);
console.log(failures.length ? `\n${failures.length} failure(s)` : "\nweb gate passed");
console.log(`screenshots: ${shots}`);
process.exit(failures.length ? 1 : 0);
