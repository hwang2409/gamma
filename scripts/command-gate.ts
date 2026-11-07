import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium, type Page } from "playwright";
import { themes } from "@fulcrum/react";
import { ACTIVE, startFakeZeta } from "./fake-zeta";
import { completeSlashCatalog, defaultSlashCatalog } from "./fake-slash-catalog";

const root = new URL("..", import.meta.url).pathname;
const portText = process.env.WEB_COMMAND_GATE_PORT ?? "4187";
if (!/^\d+$/.test(portText)) throw new Error("WEB_COMMAND_GATE_PORT must be an integer");
const port = Number(portText);
if (port < 1 || port > 65_535 || port === 5190 || port === 8765) throw new Error("WEB_COMMAND_GATE_PORT is outside the allowed disposable range");
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.WEB_SHOTS ?? join(root, "gate-artifacts", "commands");
await mkdir(shots, { recursive: true });
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-command-gate-"));
const fake = await startFakeZeta({ origins: [origin], live: false });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) }, stdio: ["ignore", "pipe", "pipe"] });
const failures: string[] = [];
const errors: string[] = [];
const check = async (name: string, run: () => Promise<void>) => {
  try { if (vite.exitCode !== null) throw new Error(`vite exited ${vite.exitCode}`); await run(); if (vite.exitCode !== null) throw new Error(`vite exited ${vite.exitCode}`); console.log(`ok   ${name}`); }
  catch (error) { const message = `${name}: ${error instanceof Error ? error.message.split("\n")[0] : error}`; failures.push(message); console.log(`FAIL ${message}`); }
};
const requests = (method: string) => fake.requests.filter((request) => request.method === method);
const field = (page: Page) => page.locator('textarea[aria-label="message"]');
const waitReady = (page: Page) => page.locator('.dock form[data-part="composer"]').waitFor({ timeout: 15_000 });
const submit = async (page: Page, text: string) => {
  await field(page).fill(text);
  await field(page).press("Enter");
  if (text.startsWith("/") && (await field(page).inputValue()).trim() === text) await field(page).press("Enter");
};

try {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (vite.exitCode !== null) throw new Error(`vite exited ${vite.exitCode}`);
    if (await fetch(origin).then((response) => response.ok, () => false)) break;
    await Bun.sleep(100);
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("console", (message) => { if (message.type() === "error" && !/WebSocket connection/.test(message.text())) errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await waitReady(page);
    await page.waitForLoadState("networkidle");

    await check("fresh draft blocks slash but double slash starts a direct turn", async () => {
      const start = fake.requests.length;
      await submit(page, "/status");
      await page.getByText("not available in this server version", { exact: true }).waitFor();
      if (fake.requests.slice(start).some((request) => ["new_session", "slash_run", "send"].includes(request.method))) throw new Error("fresh slash reached zeta");
      if ((await field(page).inputValue()).trim() !== "/status") throw new Error("fresh slash did not retain its draft");
      await field(page).fill("");
      const direct = fake.requests.length;
      await submit(page, "//status");
      for (let attempt = 0; attempt < 100 && !fake.requests.slice(direct).some((request) => request.method === "send"); attempt++) await Bun.sleep(50);
      const calls = fake.requests.slice(direct);
      if (calls.filter((request) => request.method === "new_session").length !== 1 || calls.filter((request) => request.method === "send" && request.params.text === "/status").length !== 1 || calls.some((request) => request.method === "slash_run")) throw new Error(`wrong escaped slash flow: ${calls.map((call) => call.method).join(",")}`);
      if (await page.getByRole("button", { name: "stop" }).count()) await page.getByRole("button", { name: "stop" }).click();
    });
    await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 });

    await check("attached slash keeps its attachment and explains it", async () => {
      const image = join(gammaHome, "one.png");
      await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
      await page.locator('input[type="file"]').setInputFiles(image);
      await page.locator('[data-part="attachment"]').waitFor({ timeout: 5_000 }).catch(() => { throw new Error("attachment did not render"); });
      const start = fake.requests.length;
      await submit(page, "/status");
      await page.getByText("attachments are still attached and were not sent.", { exact: false }).waitFor({ timeout: 5_000 }).catch(() => { throw new Error(`attachment receipt missing; requests: ${fake.requests.slice(start).map((request) => request.method).join(",")}`); });
      const calls = fake.requests.slice(start);
      if (calls.filter((request) => request.method === "slash_run").length !== 1) throw new Error("attached slash did not call slash_run exactly once");
      if (requests("slash_list").length < 1) throw new Error("attached command catalog never called slash_list");
      if (calls.some((request) => request.method === "send_images")) throw new Error("slash command called send_images");
      if (await page.locator('[data-part="attachment"]').count() !== 1) throw new Error("slash command cleared its attachment");
      await page.getByLabel("remove one.png").click();
    });

    await check("shared registry frames keep runnable and unavailable commands distinct", async () => {
      if (defaultSlashCatalog.length !== 15 || completeSlashCatalog.length !== 39 || completeSlashCatalog.filter((entry) => entry.unavailable === "requires_tui").length !== 24) throw new Error("fake slash catalogs drifted from Zeta 2ff56774");
      if (defaultSlashCatalog.some((entry) => ["approve", "always", "deny", "restart", "permissions"].includes(entry.name))) throw new Error("default catalog exposed TUI-only commands");
      // Each receipt is dismissed before the next command, so an earlier receipt cannot satisfy the next wait.
      const receipt = async (command: string, text: string) => {
        await submit(page, command);
        await page.locator(".command-receipt-text", { hasText: text }).waitFor({ timeout: 10_000 }).catch(async () => { throw new Error(`${command} showed no receipt "${text}"; value=${JSON.stringify(await field(page).inputValue())}`); });
        await page.getByRole("button", { name: "dismiss command result" }).click();
        await page.locator(".command-receipt").waitFor({ state: "detached" });
      };
      await receipt("/mcp", "mcp: 0 mounted, 0 failed");
      await receipt("/mcp status", "mcp: 0 mounted, 0 failed");
      await receipt("/legacy-output", "legacy output");
      await receipt("/approve", "/approve is not available in gamma yet");
      await submit(page, "/help");
      const help = page.locator(".command-receipt-text");
      await help.getByText("built-in commands:", { exact: false }).waitFor();
      if ((await help.innerText()).includes("/approve")) throw new Error("serve help exposed a TUI-only command");
    });

    await check("listbox keyboard, pointer, ime, focus, and placement", async () => {
      await field(page).fill("/st");
      const listbox = page.getByRole("listbox", { name: "command suggestions" });
      await listbox.waitFor();
      const option = page.getByRole("option", { name: /\/status/ });
      const box = await listbox.boundingBox();
      const composer = await page.locator('[data-part="composer-field"]').boundingBox();
      if (!box || !composer || box.y + box.height > composer.y + 1) throw new Error("listbox overlaps the composer field");
      await field(page).press("ArrowDown"); await field(page).press("ArrowUp"); await field(page).press("Tab");
      if (await field(page).inputValue() !== "/status ") throw new Error("tab did not accept the active option");
      await field(page).fill("/st"); await listbox.waitFor();
      await option.click();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      const pointerValue = await field(page).inputValue();
      const pointerFocus = await field(page).evaluate((node) => node === document.activeElement);
      if (pointerValue !== "/status " || !pointerFocus) throw new Error(`pointer acceptance has value ${JSON.stringify(pointerValue)} and focus ${pointerFocus}`);
      await field(page).fill("/st"); await listbox.waitFor();
      const imeRequests = fake.requests.length;
      await field(page).evaluate((node) => node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
      await field(page).dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
      if (await field(page).inputValue() !== "/st" || fake.requests.length !== imeRequests) throw new Error("ime enter accepted or submitted a completion");
      await field(page).evaluate((node) => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
      await field(page).press("Escape");
    });

    await check("one escape closes the menu after one-shot input; modified tab and enter never accept", async () => {
      const listbox = page.getByRole("listbox", { name: "command suggestions" });
      await field(page).fill("");
      await field(page).focus();
      await page.keyboard.insertText("/st");
      await listbox.waitFor();
      await field(page).press("Escape");
      await page.waitForTimeout(300);
      if (await field(page).getAttribute("aria-expanded") !== "false") throw new Error("first escape after one-shot input left the menu open");
      for (const key of ["Shift+Enter", "Shift+Tab"]) {
        await field(page).fill(""); await field(page).fill("/st"); await listbox.waitFor();
        await field(page).press(key);
        const value = await field(page).inputValue();
        if (value.startsWith("/status")) throw new Error(`${key} accepted the active command: ${JSON.stringify(value)}`);
        if (key === "Shift+Tab" && await field(page).evaluate((node) => node === document.activeElement)) throw new Error("shift+tab did not move focus back");
        await field(page).focus();
      }
      await field(page).fill("");
    });

    await check("active option has a visible accent bar distinct from hover in every theme", async () => {
      const fixShots = process.env.WEB_FIX_SHOTS ?? shots;
      await mkdir(fixShots, { recursive: true });
      await field(page).fill("/");
      await page.getByRole("listbox", { name: "command suggestions" }).waitFor();
      await field(page).press("ArrowDown");
      await page.locator('[role="option"][aria-selected="true"]').nth(0).waitFor();
      for (const width of [1440, 390]) for (const theme of themes) {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
        await page.evaluate((name) => { document.documentElement.dataset.fulcrumTheme = name; }, theme);
        await page.getByRole("option").nth(2).hover();
        await page.screenshot({ path: join(fixShots, `menu-${theme}-${width}.png`) });
        const audit = await page.evaluate(() => {
          // Computed colors may be color(srgb …) or oklch(…); a canvas pixel resolves any of them to sRGB bytes.
          const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
          const parse = (value: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = "#000"; context.fillStyle = value; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
          const luminance = (rgb: number[]) => { const parts = rgb.map((part) => { const channel = part / 255; return channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; }); return .2126 * parts[0]! + .7152 * parts[1]! + .0722 * parts[2]!; };
          const ratio = (a: string, b: string) => { const x = luminance(parse(a)), y = luminance(parse(b)); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
          const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
          const active = options.find((option) => option.getAttribute("aria-selected") === "true")!;
          const hovered = options[2]!;
          const bar = (element: HTMLElement) => { const shadow = getComputedStyle(element).boxShadow; const match = shadow.match(/^(.*\)) (\d+(?:\.\d+)?)px 0px 0px (?:0px )?inset$/); return match ? { color: match[1]!, width: Number(match[2]) } : null; };
          const listboxBackground = getComputedStyle(document.querySelector('[role="listbox"]')!).backgroundColor;
          const activeBar = bar(active);
          return {
            activeIndex: options.indexOf(active), activeBar, hoveredBar: bar(hovered), hoveredSelected: hovered.getAttribute("aria-selected") === "true",
            barContrast: activeBar ? ratio(activeBar.color, getComputedStyle(active).backgroundColor) : 0,
            sameBackground: getComputedStyle(active).backgroundColor === getComputedStyle(hovered).backgroundColor,
            fillContrast: ratio(getComputedStyle(active).backgroundColor, listboxBackground),
            textContrast: Math.min(...[...active.querySelectorAll("span")].map((span) => ratio(getComputedStyle(span).color, getComputedStyle(active).backgroundColor))),
          };
        });
        if (audit.activeIndex !== 1 || audit.hoveredSelected || !audit.activeBar || audit.activeBar.width < 3 || audit.barContrast < 3 || audit.hoveredBar || audit.sameBackground || audit.textContrast < 4.5) throw new Error(`${theme} at ${width}px: ${JSON.stringify(audit)}`);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => { delete document.documentElement.dataset.fulcrumTheme; });
      await field(page).press("Escape");
      await field(page).fill("");
    });

    await check("error receipts carry a text label and keyboard dismiss returns focus to the composer", async () => {
      await submit(page, "/does-not-exist");
      await page.locator('.command-receipt[data-tone="error"] .command-receipt-label', { hasText: "error" }).waitFor({ timeout: 5_000 }).catch(() => { throw new Error("error receipt has no text label"); });
      const dismiss = page.getByRole("button", { name: "dismiss command result" });
      await dismiss.focus();
      await dismiss.press("Enter");
      await page.locator(".command-receipt").waitFor({ state: "detached", timeout: 5_000 });
      if (!(await field(page).evaluate((node) => node === document.activeElement))) throw new Error(`dismiss left focus on ${await page.evaluate(() => document.activeElement?.tagName)}`);
      await submit(page, "/mcp");
      await page.locator('.command-receipt[data-tone="quiet"]').waitFor();
      if (await page.locator(".command-receipt .command-receipt-label").count()) throw new Error("quiet receipt shows the error label");
      await page.getByRole("button", { name: "dismiss command result" }).click();
      await field(page).fill("");
    });

    await check("long receipt and listbox fit every theme without squeezing the transcript", async () => {
      fake.setLongStatus(true);
      await submit(page, "/status");
      await page.locator(".command-receipt-text", { hasText: "status detail 80" }).waitFor();
      await field(page).fill("/"); await page.getByRole("listbox", { name: "command suggestions" }).waitFor();
      for (const width of [1440, 1024, 390]) for (const theme of themes) {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : width === 1024 ? 800 : 844 });
        await page.evaluate((name) => { document.documentElement.dataset.fulcrumTheme = name; }, theme);
        await page.screenshot({ path: join(shots, `${theme}-${width}.png`) });
        const audit = await page.evaluate((narrow) => {
          const visible = (element: Element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
          const unnamed = [...document.querySelectorAll('button,input,textarea,[role="option"]')].filter((element) => visible(element) && !(element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || element.textContent?.trim()));
          const targets = [...document.querySelectorAll('.command-receipt button,[role="option"]')].filter((element) => { if (!visible(element)) return false; const box = element.getBoundingClientRect(); const minimum = narrow ? 44 : 36; return box.width < minimum || box.height < minimum; });
          const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
          const luminance = (rgb: number[]) => { const parts = rgb.map((part) => { const channel = part / 255; return channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; }); return .2126 * parts[0]! + .7152 * parts[1]! + .0722 * parts[2]!; };
          const contrast = [...document.querySelectorAll('.command-receipt,[role="listbox"]')].filter(visible).map((element) => { const style = getComputedStyle(element); const foreground = luminance(parse(style.color)); const background = luminance(parse(style.backgroundColor)); return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05); });
          const listbox = document.querySelector('[role="listbox"]')?.getBoundingClientRect();
          const composer = document.querySelector('[data-part="composer-field"]')?.getBoundingClientRect();
          const transcript = [...document.querySelectorAll('.scroll')].map((element) => element.getBoundingClientRect()).find((box) => box.width > 0 && box.height > 0);
          return { overflow: document.documentElement.scrollWidth > innerWidth + 1, unnamed: unnamed.length, targets: targets.map((element) => element.textContent?.trim() || element.getAttribute("aria-label")), contrast, overlap: !!listbox && !!composer && listbox.bottom > composer.top + 1, transcriptHeight: transcript?.height ?? 0 };
        }, width === 390);
        const minimumTranscript = width === 390 ? 140 : 180;
        if (audit.overflow || audit.unnamed || audit.targets.length || audit.contrast.some((ratio) => ratio < 4.5) || audit.overlap || audit.transcriptHeight < minimumTranscript) throw new Error(`${theme} at ${width}px failed audit: ${JSON.stringify(audit)}`);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      fake.setLongStatus(false);
      await field(page).press("Escape");
      await page.getByRole("button", { name: "dismiss command result" }).click();
    });

    await check("opaque model input sends once without exposing its id", async () => {
      const start = fake.requests.length;
      await submit(page, "/review");
      for (let attempt = 0; attempt < 100 && !fake.requests.slice(start).some((request) => request.method === "send"); attempt++) await Bun.sleep(50);
      const calls = fake.requests.slice(start);
      const sends = calls.filter((request) => request.method === "send");
      if (calls.filter((request) => request.method === "slash_run").length !== 1 || sends.length !== 1) throw new Error(`expected one prepare and one send, got ${calls.map((call) => call.method)}`);
      if (sends[0]?.params.input_id !== "opaque-review-input" || "text" in (sends[0]?.params ?? {})) throw new Error("opaque send used the wrong shape");
      if (fake.sent.at(-1)?.text !== "/review") throw new Error("opaque send did not keep its display text for the user row");
      if ((await page.locator("body").innerText()).includes("opaque-review-input")) throw new Error("opaque id reached visible text");
      await page.getByRole("button", { name: "stop" }).waitFor({ timeout: 15_000 });
    });

    if (await page.getByRole("button", { name: "stop" }).count()) await page.getByRole("button", { name: "stop" }).click();
    await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 });

    await check("opaque input keeps an attachment and explains it", async () => {
      const image = join(gammaHome, "opaque.png");
      await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
      await page.locator('input[type="file"]').setInputFiles(image);
      await page.locator('[data-part="attachment"]').waitFor({ timeout: 5_000 }).catch(() => { throw new Error("opaque attachment did not render"); });
      const start = fake.requests.length;
      await submit(page, "/review");
      for (let attempt = 0; attempt < 100 && !fake.requests.slice(start).some((request) => request.method === "send"); attempt++) await Bun.sleep(50);
      const calls = fake.requests.slice(start);
      if (calls.filter((request) => request.method === "send").length !== 1 || calls.some((request) => request.method === "send_images")) throw new Error("attached opaque input used the wrong delivery path");
      await page.getByText("attachments are still attached and were not sent.", { exact: true }).waitFor({ timeout: 15_000 }).catch(async () => { throw new Error(`opaque attachment receipt missing; body=${await page.locator("body").innerText()}`); });
      if (await page.locator('[data-part="attachment"]').count() !== 1) throw new Error("opaque input cleared its attachment");
      await page.getByRole("button", { name: "stop" }).waitFor({ timeout: 10_000 }).catch(() => { throw new Error("opaque attachment turn did not stay active"); });
    });
    if (await page.getByRole("button", { name: "stop" }).count()) await page.getByRole("button", { name: "stop" }).click();
    await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 });
    await page.getByLabel("remove opaque.png").click();

    await check("dollar text bypasses slash preparation", async () => {
      const start = fake.requests.length;
      await submit(page, "$review");
      for (let attempt = 0; attempt < 100 && !fake.requests.slice(start).some((request) => request.method === "send"); attempt++) await Bun.sleep(50);
      const calls = fake.requests.slice(start);
      if (calls.filter((request) => request.method === "send" && request.params.text === "$review").length !== 1 || calls.some((request) => request.method === "slash_run" || request.method === "input_prepare")) throw new Error(`dollar text took command preparation: ${calls.map((call) => call.method).join(",")}`);
      await page.getByRole("button", { name: "stop" }).waitFor();
    });
    await page.getByRole("button", { name: "stop" }).click();
    await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 });

    await check("retry after a failed opaque turn restores the command instead of sending its text", async () => {
      await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 });
      const start = fake.requests.length;
      await submit(page, "/review fail this turn");
      const retry = page.locator(".turn-retry");
      await retry.waitFor({ timeout: 15_000 }).catch(async () => { throw new Error(`failed opaque turn showed no retry; body=${await page.locator("body").innerText()}`); });
      const before = fake.requests.length;
      await retry.click();
      await page.waitForTimeout(500);
      const textSends = fake.requests.slice(start).filter((request) => request.method === "send" && "text" in request.params);
      if (textSends.length) throw new Error(`retry sent slash text: ${JSON.stringify(textSends.map((request) => request.params.text))}`);
      if (fake.requests.slice(before).some((request) => ["send", "steer", "send_images", "slash_run"].includes(request.method))) throw new Error("retry reached zeta without the user submitting");
      if ((await field(page).inputValue()).trim() !== "/review fail this turn") throw new Error(`retry did not restore the command draft: ${JSON.stringify(await field(page).inputValue())}`);
      await field(page).fill("");
    });

    await field(page).waitFor();
    await check("active turn blocks slash_run and retains the slash draft", async () => {
      await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 }).catch(async () => { throw new Error(`composer did not become idle; text: ${await page.locator("body").innerText()}`); });
      await submit(page, "start a turn");
      await page.getByPlaceholder("steer the running turn").waitFor({ timeout: 10_000 }).catch(() => { throw new Error(`turn did not start; requests: ${fake.requests.slice(-8).map((request) => request.method).join(",")}`); });
      await page.waitForTimeout(300);
      await page.getByPlaceholder("steer the running turn").waitFor({ timeout: 10_000 });
      const before = { slash: requests("slash_run").length, send: requests("send").length, steer: requests("steer").length };
      await submit(page, "/review");
      await page.getByText("commands are unavailable while a turn is active", { exact: true }).waitFor({ timeout: 5_000 }).catch(async () => { throw new Error(`active command receipt missing; value=${JSON.stringify(await field(page).inputValue())}; requests=${fake.requests.slice(-8).map((request) => request.method).join(",")}; body=${await page.locator("body").innerText()}`); });
      if (requests("slash_run").length !== before.slash || requests("send").length !== before.send || requests("steer").length !== before.steer) throw new Error("active command reached zeta");
      if ((await field(page).inputValue()).trim() !== "/review") throw new Error("active turn lost the slash draft");
    });

    if (await page.getByRole("button", { name: "stop" }).count()) await page.getByRole("button", { name: "stop" }).click();
    await page.waitForTimeout(100);
    await check("unknown and malformed commands are dismissible error receipts", async () => {
      await submit(page, "/does-not-exist");
      await page.getByText("unknown command: /does-not-exist", { exact: true }).waitFor();
      await page.getByRole("button", { name: "dismiss command result" }).click();
      await submit(page, "/malformed");
      await page.getByText("invalid response from server", { exact: true }).waitFor();
      await page.getByRole("button", { name: "dismiss command result" }).click();
      if (await page.getByText("invalid response from server", { exact: true }).count()) throw new Error("receipt did not dismiss");
    });

    await check("missing model input feature blocks slash_run", async () => {
      fake.setModelInputIds(false);
      await page.reload();
      await waitReady(page);
      const start = fake.requests.length;
      await submit(page, "/review");
      await page.getByText("not available in this server version", { exact: true }).waitFor();
      if (fake.requests.slice(start).some((request) => request.method === "slash_run" || request.method === "send")) throw new Error("downgrade path reached slash_run or send");
      if ((await field(page).inputValue()).trim() !== "/review") throw new Error("downgrade path lost its draft");
      fake.setModelInputIds(true);
    });

    await check("approve always reaches zeta with persistence", async () => {
      fake.setLive(true);
      await page.goto(`${origin}/?run=${ACTIVE}`);
      await page.getByRole("button", { name: "always allow" }).waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: "always allow" }).click();
      await page.waitForFunction(() => document.querySelector('[data-part="approval-actions"]') === null, undefined, { timeout: 10_000 }).catch(() => {});
      const decision = fake.decisions.at(-1);
      if (decision?.method !== "approve" || decision.scope !== "always_tool" || "always" in decision) throw new Error(`wrong decision: ${JSON.stringify(decision)}`);
    });

    if (errors.length) failures.push(...errors.map((error) => `browser error: ${error}`));
  } finally { await browser.close(); }
} finally {
  vite.kill("SIGTERM");
  await fake.close();
  await rm(gammaHome, { recursive: true, force: true });
}
if (failures.length) throw new AggregateError(failures, `${failures.length} command gate failure(s)`);
console.log("command gate passed");
