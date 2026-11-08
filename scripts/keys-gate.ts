import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import { KEY_DEFINITIONS, VIM_KEY_ROWS, browserUsesControlRForReload, keysReceipt } from "../src/keys";
import { ACTIVE, startFakeZeta } from "./fake-zeta";

const exclusions = ["/restart", "!shell", "$EDITOR"];
const receiptText = keysReceipt();
for (const exclusion of exclusions) if (!receiptText.includes(exclusion)) throw new Error(`keyboard help omits ${exclusion}`);
const vimTokens = VIM_KEY_ROWS.flatMap(({ vimTokens = [] }) => [...vimTokens]);
if (!vimTokens.includes("escape") || !vimTokens.includes("ctrl+r") || !vimTokens.includes("gg")) throw new Error("vim help omits a supported transition");

const browserCovered = new Set([
  "composer.submit", "composer.newline", "composer.stop-escape", "composer.stop-control-c", "composer.slash", "composer.skill",
  "suggestions.accept", "suggestions.move", "suggestions.close",
  "model.move", "model.edge", "model.choose", "model.typeahead", "model.close",
  "theme.open", "theme.move", "theme.choose", "theme.close", "dialog.trap", "dialog.close",
  "vim.browser-aliases", "browser.keys", "browser.paste", "browser.vim", "browser.precedence",
  "exclusion.restart", "exclusion.shell", "exclusion.editor",
]);
const expectedBrowserCoverage = KEY_DEFINITIONS.filter(({ vimTokens }) => !vimTokens?.length).map(({ id }) => id);
if (expectedBrowserCoverage.some((id) => !browserCovered.has(id)) || browserCovered.size !== expectedBrowserCoverage.length) throw new Error("browser key behavior coverage drifted from the declared table");

const root = new URL("..", import.meta.url).pathname;
const portText = process.env.WEB_KEYS_GATE_PORT ?? "4199";
if (!/^\d+$/.test(portText)) throw new Error("WEB_KEYS_GATE_PORT must be an integer");
const port = Number(portText);
if (port < 1 || port > 65_535 || port === 5190 || port === 8765) throw new Error("WEB_KEYS_GATE_PORT is outside the allowed disposable range");
const origin = `http://127.0.0.1:${port}`;
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-keys-gate-"));
const fake = await startFakeZeta({ origins: [origin], live: false });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: root,
  env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) },
  stdio: ["ignore", "pipe", "pipe"],
});
const logs: string[] = [];
vite.stdout?.on("data", (data) => logs.push(String(data)));
vite.stderr?.on("data", (data) => logs.push(String(data)));
const errors: string[] = [];
const field = (page: Page) => page.getByRole("combobox", { name: "message" });
const submit = async (page: Page, text: string) => {
  await field(page).fill(text);
  await field(page).press("Enter");
  if ((await field(page).inputValue()).trim() === text) await field(page).press("Enter");
};
const activeText = async (page: Page, listName: string) => {
  const list = page.getByRole("listbox", { name: listName });
  const id = await list.getAttribute("aria-activedescendant");
  return id ? page.locator(`[id="${id}"]`).innerText() : "";
};
const expect = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

async function browserReloadConvention(name: string, browserType: BrowserType) {
  const browser = await browserType.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let loads = 0;
    page.on("load", () => loads++);
    await page.goto("data:text/html,<textarea autofocus>gamma</textarea>");
    await page.locator("textarea").focus();
    await page.keyboard.press("Control+r");
    await page.waitForTimeout(300);
    const reloaded = loads > 1;
    if (process.platform === "darwin") expect(!reloaded, `${name} ctrl+r unexpectedly reloaded on macOS`);
    console.log(`ok   ${name} ctrl+r browser convention observed (${reloaded ? "reload" : "not reload"})`);
  } finally { await browser.close(); }
}

async function exerciseHandlers(page: Page) {
  await page.goto(`${origin}/?run=${ACTIVE}`);
  await field(page).waitFor({ timeout: 15_000 });
  await page.waitForLoadState("networkidle");

  await field(page).fill("first\nsecond");
  await field(page).press("Shift+Enter");
  expect((await field(page).inputValue()).endsWith("\n"), "shift+enter did not insert a new line");
  await field(page).fill("");

  await field(page).fill("/");
  const suggestions = page.getByRole("listbox", { name: "command suggestions" });
  await suggestions.waitFor();
  const firstSuggestion = await field(page).getAttribute("aria-activedescendant");
  await field(page).press("ArrowDown");
  expect(await field(page).getAttribute("aria-activedescendant") !== firstSuggestion, "arrow down did not move the command suggestion");
  await field(page).press("ArrowUp");
  expect(await field(page).getAttribute("aria-activedescendant") === firstSuggestion, "arrow up did not restore the command suggestion");
  await field(page).press("Home");
  await field(page).press("End");
  expect(await field(page).getAttribute("aria-activedescendant") === firstSuggestion, "home/end incorrectly changed command suggestions");
  await field(page).press("Escape");
  expect(await suggestions.count() === 0, "escape did not close command suggestions");

  await field(page).fill("$");
  await suggestions.waitFor();
  await field(page).press("Tab");
  expect((await field(page).inputValue()).startsWith("$"), "tab did not accept a skill suggestion");
  await field(page).fill("/");
  await suggestions.waitFor();
  await field(page).press("Enter");
  expect((await field(page).inputValue()).startsWith("/"), "enter did not accept a command suggestion");
  await field(page).fill("");

  const modelButton = page.locator('button[aria-label^="model:"]');
  await modelButton.click();
  const modelList = page.getByRole("listbox", { name: "model" });
  await modelList.waitFor();
  const firstModel = await modelList.getAttribute("aria-activedescendant");
  await modelList.press("ArrowDown");
  expect(await modelList.getAttribute("aria-activedescendant") !== firstModel, "arrow down did not move the model option");
  await modelList.press("Home");
  expect((await modelList.getAttribute("aria-activedescendant"))?.endsWith("-0"), "home did not select the first model");
  await modelList.press("End");
  expect(!(await modelList.getAttribute("aria-activedescendant"))?.endsWith("-0"), "end did not select the last model");
  const modelLabels = await modelList.getByRole("option").allTextContents();
  const typed = modelLabels.find((label) => label && !label.startsWith("default"));
  if (!typed) throw new Error("model gate has no named model for typeahead");
  await modelList.press(typed[0]!);
  expect((await activeText(page, "model")).toLowerCase().startsWith(typed[0]!.toLowerCase()), "model typeahead did not jump to a match");
  await modelList.press("Enter");
  expect(await modelList.count() === 0, "enter did not choose and close the model menu");
  await modelButton.click();
  await modelList.press("Escape");
  expect(await modelList.count() === 0 && await modelButton.evaluate((node) => node === document.activeElement), "escape did not close the model menu and restore focus");

  await page.getByRole("button", { name: "settings" }).click();
  const themeButton = page.locator(".theme-button");
  await themeButton.focus();
  await themeButton.press("ArrowDown");
  const themeList = page.getByRole("listbox", { name: "theme" });
  await themeList.waitFor();
  await themeList.press("End");
  expect(!(await themeList.getAttribute("aria-activedescendant"))?.endsWith("-0"), "end did not select the last theme");
  await themeList.press("Home");
  expect((await themeList.getAttribute("aria-activedescendant"))?.endsWith("-0"), "home did not select the first theme");
  await themeList.press("ArrowDown");
  await themeList.press(" ");
  expect(await themeList.count() === 0, "space did not choose and close the theme menu");
  await themeButton.press("ArrowUp");
  await themeList.press("Tab");
  expect(await themeList.count() === 0, "tab did not close the theme menu");
  await themeButton.focus();
  await themeButton.press("ArrowDown");
  await themeList.press("Escape");
  expect(await themeList.count() === 0 && await themeButton.evaluate((node) => node === document.activeElement), "escape did not close the theme menu and restore focus");

  const image = join(gammaHome, "keys.png");
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await page.locator('input[type="file"]').setInputFiles(image);
  await page.getByRole("button", { name: "open image: keys.png" }).click();
  const dialog = page.getByRole("dialog", { name: "file inspector" });
  await dialog.waitFor();
  const close = dialog.getByRole("button", { name: "close" });
  const download = dialog.getByRole("link", { name: "download" });
  expect(await close.evaluate((node) => node === document.activeElement), "dialog did not focus its close action");
  await close.press("Tab");
  expect(await download.evaluate((node) => node === document.activeElement), "tab escaped the dialog instead of wrapping");
  await download.press("Shift+Tab");
  expect(await close.evaluate((node) => node === document.activeElement), "shift+tab escaped the dialog instead of wrapping");
  await close.press("Escape");
  expect(await dialog.count() === 0, "escape did not close the dialog");
  await page.getByLabel("remove keys.png").click();

  await field(page).fill("send with enter");
  await field(page).press("Enter");
  await page.getByRole("button", { name: "stop" }).waitFor({ timeout: 10_000 });
  await field(page).press("Escape");
  await page.getByRole("button", { name: "stop" }).waitFor({ state: "detached", timeout: 10_000 });

  await field(page).fill("start again");
  await field(page).press("Enter");
  await page.getByRole("button", { name: "stop" }).waitFor({ timeout: 10_000 });
  await field(page).fill("");
  await field(page).press("Control+c");
  await page.getByRole("button", { name: "stop" }).waitFor({ state: "detached", timeout: 10_000 });

  await submit(page, "/vim on");
  await page.locator(".command-receipt-text", { hasText: "vim mode: on" }).waitFor();
  await page.getByRole("button", { name: "dismiss command result" }).click();
  await field(page).fill("abc");
  await field(page).press("Escape");
  await field(page).press("Backspace");
  expect(await field(page).evaluate((node: HTMLTextAreaElement) => node.selectionStart) === 1, "backspace did not map to vim h");
  await field(page).press("Delete");
  expect(await field(page).inputValue() === "ac", "delete did not map to vim x");
  await field(page).press("u");
  expect(await field(page).inputValue() === "abc", "vim undo did not restore the draft");
  if (browserUsesControlRForReload(process.platform)) {
    await page.evaluate(() => {
      localStorage.setItem("gamma-ctrl-r-prevent-default-called", "false");
      const preventDefault = Event.prototype.preventDefault;
      Event.prototype.preventDefault = function () {
        if (this instanceof KeyboardEvent && this.ctrlKey && this.key.toLowerCase() === "r") localStorage.setItem("gamma-ctrl-r-prevent-default-called", "true");
        preventDefault.call(this);
      };
    });
    await field(page).press("Control+r");
    await page.waitForTimeout(300);
    await field(page).waitFor();
    expect(await page.evaluate(() => localStorage.getItem("gamma-ctrl-r-prevent-default-called")) === "false", "the composer called preventDefault for the browser's ctrl+r convention");
  } else {
    await field(page).press("Control+r");
    expect(await field(page).inputValue() === "ac", "ctrl+r did not redo when the browser leaves it available");
  }
  await submit(page, "/vim off");
  await page.locator(".command-receipt-text", { hasText: "vim mode: off" }).waitFor();
  await page.getByRole("button", { name: "dismiss command result" }).click();

  const chooser = page.waitForEvent("filechooser");
  await submit(page, "/paste");
  await chooser;
  await page.locator(".command-receipt-text", { hasText: "choose images to attach" }).waitFor();
  await page.getByRole("button", { name: "dismiss command result" }).click();
}

async function mobileKeysJourney(browserType: BrowserType, name: string) {
  const browser = await browserType.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on("pageerror", (error) => errors.push(`${name} page error: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error" && !/WebSocket connection|Failed to load resource/.test(message.text())) errors.push(`${name} console: ${message.text()}`); });
    page.on("response", (response) => { if (response.status() >= 400 && response.url().includes("/@fs")) errors.push(`${name} ${response.status()} ${response.url()}`); });
    await page.goto(`${origin}/?run=${ACTIVE}`);
    await field(page).waitFor({ timeout: 15_000 });
    await submit(page, "/keys");
    const receipt = page.locator(".command-receipt-text", { hasText: "browser precedence and terminal-only exclusions" });
    await receipt.waitFor();
    const bounds = await receipt.evaluate((node) => ({ clientHeight: node.clientHeight, scrollHeight: node.scrollHeight }));
    expect(bounds.scrollHeight > bounds.clientHeight, `${name} /keys receipt is not bounded at 390px`);
    for (let index = 0; index < 20 && !await receipt.evaluate((node) => node === document.activeElement); index++) await page.keyboard.press("Shift+Tab");
    expect(await receipt.evaluate((node) => node === document.activeElement), `${name} keyboard did not reach the scrollable /keys receipt`);
    await page.keyboard.press("End");
    await page.waitForTimeout(100);
    for (let index = 0; index < 20 && !await receipt.evaluate((node) => node.scrollTop > 0); index++) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(10);
    }
    expect(await receipt.evaluate((node) => node.scrollTop > 0), `${name} keyboard could not scroll the /keys receipt`);
    const dismiss = page.getByRole("button", { name: "dismiss command result" });
    for (let index = 0; index < 8 && !await dismiss.evaluate((node) => node === document.activeElement); index++) {
      await page.keyboard.press(name === "webkit" ? "Alt+Tab" : "Tab");
    }
    expect(await dismiss.evaluate((node) => node === document.activeElement), `${name} keyboard did not reach dismiss from the receipt`);
    await page.keyboard.press("Enter");
    await receipt.waitFor({ state: "detached" });
    expect(await field(page).evaluate((node) => node === document.activeElement), `${name} dismiss did not return focus to the composer`);
    console.log(`ok   ${name} 390px keyboard-only /keys journey`);
  } finally { await browser.close(); }
}

try {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (vite.exitCode !== null) throw new Error(`vite exited ${vite.exitCode}: ${logs.join("").slice(-3000)}`);
    if (await fetch(origin).then((response) => response.ok, () => false)) break;
    await Bun.sleep(100);
    if (attempt === 299) throw new Error(`vite did not start: ${logs.join("").slice(-3000)}`);
  }
  const browser = await chromium.launch({ headless: true });
  try { await exerciseHandlers(await browser.newPage({ viewport: { width: 1024, height: 800 } })); }
  finally { await browser.close(); }
  await browserReloadConvention("chromium", chromium);
  await mobileKeysJourney(chromium, "chromium");
  if (process.platform === "darwin") {
    await browserReloadConvention("webkit", webkit);
    await mobileKeysJourney(webkit, "webkit");
  }
  if (errors.length) throw new Error(errors.join(" | "));
} finally {
  vite.kill("SIGTERM");
  await fake.close();
  await rm(gammaHome, { recursive: true, force: true });
}

console.log(`keys gate passed: ${KEY_DEFINITIONS.length} rows, ${vimTokens.length} tested vim transitions`);
