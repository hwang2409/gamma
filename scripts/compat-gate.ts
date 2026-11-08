// Compatibility gate: gamma against servers that lack parity features. The invariant for every row: an unsupported
// action is hidden or answered by a local retained receipt, and a slash-led draft is never sent as plain text.
// Each row reconfigures one fake zeta and reloads, so the capabilities come from a fresh hello.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium, type Page } from "playwright";
import { themes } from "@fulcrum/react";
import { ACTIVE, startFakeZeta } from "./fake-zeta";
import { defaultSlashCatalog } from "./fake-slash-catalog";

const root = new URL("..", import.meta.url).pathname;
const portText = process.env.WEB_COMPAT_GATE_PORT ?? "4213";
if (!/^\d+$/.test(portText)) throw new Error("WEB_COMPAT_GATE_PORT must be an integer");
const port = Number(portText);
if (port < 1 || port > 65_535 || port === 5190 || port === 8765) throw new Error("WEB_COMPAT_GATE_PORT is outside the allowed disposable range");
const origin = `http://127.0.0.1:${port}`;
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-compat-gate-"));
const fake = await startFakeZeta({ origins: [origin], live: false });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) }, stdio: ["ignore", "pipe", "pipe"] });
const failures: string[] = [];
const errors: string[] = [];
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const UNAVAILABLE = "not available in this server version";
// Zeta 8389c6e docs/serve-protocol.md:1405-1418 lists runnable rows; the menu shows the same rows (src/commands.ts completions).
const RUNNABLE = defaultSlashCatalog.filter((entry) => entry.unavailable === null).length;
const SLASH_DRAFT_METHODS = new Set(["send", "send_images", "steer"]);

const field = (page: Page) => page.locator('textarea[aria-label="message"]');
const menu = (page: Page) => page.getByRole("listbox", { name: "command suggestions" });
const receipt = (page: Page) => page.locator(".command-receipt-text");
const permissions = (page: Page) => page.locator(".permissions-trigger");
const until = async (condition: () => boolean | Promise<boolean>, timeout: number, label: string) => {
  for (const end = Date.now() + timeout; !(await condition()); await Bun.sleep(25)) if (Date.now() > end) throw new Error(`timed out after ${timeout}ms: ${label}`);
};
const check = async (name: string, run: () => Promise<void>) => {
  try { if (vite.exitCode !== null) throw new Error(`vite exited ${vite.exitCode}`); await run(); console.log(`ok   ${name}`); }
  catch (error) { const message = `${name}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`; failures.push(message); console.log(`FAIL ${message}`); }
};
const since = (start: number) => fake.requests.slice(start);
/** Names a wait in its timeout, so a failure says which step stalled. */
const labeled = <T,>(label: string, wait: Promise<T>) => wait.catch((error: Error) => { throw new Error(`${label}: ${error.message.split("\n")[0]}`); });
/** No slash-led text reached the model: every send/steer since `start` carries neither a `/` draft nor an unnegotiated input id. */
const assertNoSlashSend = (start: number, opaqueAllowed: boolean) => {
  for (const request of since(start)) {
    if (!SLASH_DRAFT_METHODS.has(request.method)) continue;
    const text = typeof request.params.text === "string" ? request.params.text : "";
    if (text.trimStart().startsWith("/")) throw new Error(`a slash draft was sent as plain text: ${JSON.stringify(request.params)}`);
    if ("input_id" in request.params && !opaqueAllowed) throw new Error(`an opaque input was sent without model_input_ids: ${JSON.stringify(request.params)}`);
  }
};
const assertNotCalled = (start: number, methods: readonly string[]) => {
  const called = since(start).filter((request) => methods.includes(request.method)).map((request) => request.method);
  if (called.length) throw new Error(`gamma called unadvertised ${[...new Set(called)].join(", ")}`);
};
const submit = async (page: Page, text: string) => {
  await field(page).fill(text);
  await field(page).press("Escape");
  await field(page).press("Enter");
};
const dismiss = async (page: Page) => {
  const button = page.getByRole("button", { name: "dismiss command result" });
  if (await button.count()) { await button.click(); await page.locator(".command-receipt").waitFor({ state: "detached", timeout: 5_000 }); }
};
/** Submits a slash draft and returns its receipt; the draft must stay in the composer when `retained`. */
const slashReceipt = async (page: Page, text: string, retained: boolean) => {
  await dismiss(page);
  await submit(page, text);
  await receipt(page).waitFor({ timeout: 10_000 });
  const shown = await receipt(page).innerText();
  const value = (await field(page).inputValue()).trim();
  if (retained && value !== text) throw new Error(`${text} lost its draft (composer holds ${JSON.stringify(value)}; receipt ${JSON.stringify(shown)})`);
  return shown;
};
/** Opens the active run on a fresh hello and waits until the run is attached, not the fresh-draft stand-in. */
const openRun = async (page: Page) => {
  const start = fake.requests.length;
  await page.goto(`${origin}/?run=${ACTIVE}`);
  await field(page).waitFor({ timeout: 15_000 });
  await until(() => since(start).some((request) => request.method === "session_history" && request.replied !== undefined), 15_000, "session_history replied")
    .catch(async (error) => { throw new Error(`${error.message}; saw ${since(start).map((request) => request.method).join(",")}; errors ${errors.join(" | ")}; body ${(await page.locator("body").innerText()).slice(0, 300)}`); });
  await page.locator('.status-line[data-state="ready"]').waitFor({ timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  return start;
};
/**
 * Rows the `/` menu offers. `expected` retypes `/` until the menu opens, as a user would if the first keystroke raced
 * the run's attach; otherwise it gives a menu time to wrongly appear.
 */
const menuRows = async (page: Page, expected: boolean) => {
  for (let attempt = 0; attempt < (expected ? 20 : 1); attempt++) {
    await field(page).fill("");
    await field(page).fill("/");
    if (!expected) await Bun.sleep(500);
    else if (await menu(page).getByRole("option").first().waitFor({ timeout: 500 }).then(() => true, () => false)) break;
  }
  const rows = await menu(page).count() ? await menu(page).getByRole("option").count() : 0;
  await field(page).fill("");
  return rows;
};
const assertLocalActions = async (page: Page) => {
  const keys = await slashReceipt(page, "/keys", false);
  if (!keys.includes("browser precedence and terminal-only exclusions")) throw new Error(`/keys answered ${JSON.stringify(keys.slice(0, 120))}`);
  await dismiss(page);
  const before = await page.evaluate(() => document.documentElement.dataset.fulcrumTheme);
  const next = themes.find((theme) => theme !== before)!;
  await slashReceipt(page, `/theme ${next}`, false);
  if (await page.evaluate(() => document.documentElement.dataset.fulcrumTheme) !== next) throw new Error(`/theme ${next} did not change the theme`);
  await dismiss(page);
};
const resetServer = () => {
  fake.setServerShape();
  fake.setModelInputIds(true);
  fake.setSessionGrantsEnabled(true);
  fake.overrideResult("slash_list", null);
  fake.overrideResult("slash_run", null);
};

try {
  for (let attempt = 0; attempt < 200 && !(await fetch(origin).then((response) => response.ok, () => false)); attempt++) {
    if (vite.exitCode !== null) throw new Error(`vite exited ${vite.exitCode}`);
    await Bun.sleep(100);
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("console", (message) => { if (message.type() === "error" && !/WebSocket connection|Failed to load resource/.test(message.text())) errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    // Records whether the permissions control or command menu ever rendered, so a control that flashes before the hello settles still fails.
    await page.addInitScript(() => {
      const seen = ((globalThis as unknown as { __compatSeen: Record<string, boolean> }).__compatSeen = { permissions: false, menu: false });
      new MutationObserver(() => {
        if (document.querySelector(".permissions-trigger")) seen.permissions = true;
        if (document.querySelector('[role="listbox"][aria-label="command suggestions"]')) seen.menu = true;
      }).observe(document, { subtree: true, childList: true });
    });
    const seen = () => page.evaluate(() => (globalThis as unknown as { __compatSeen: { permissions: boolean; menu: boolean } }).__compatSeen);

    await check("full server: additive hello, slash_list, and slash_run fields are harmless; legacy kind text is a local error", async () => {
      resetServer();
      // Future requests (zeta z1-z8 names) and additive hello keys; gamma must neither call nor trip on them.
      fake.setServerShape({ addRequests: ["input_prepare", "path_complete", "child_run_list", "run_work_list"], helloFields: { notices: ["fake startup notice"], future_capability_block: { version: 9 } } });
      // Zeta #1066 adds runs_while_busy to slash_list rows; an unknown future value and extra keys must keep every row.
      fake.overrideResult("slash_list", () => ({ commands: defaultSlashCatalog.map((entry, index) => ({ ...entry, runs_while_busy: index % 2 ? "a-future-value" : true, future_badge: { tone: "new" } })), notices: [], next_cursor: "future" }));
      const start = await openRun(page);
      const rows = await menuRows(page, true);
      if (rows !== RUNNABLE) throw new Error(`menu showed ${rows} rows for ${RUNNABLE} runnable catalog rows`);
      await permissions(page).waitFor({ timeout: 10_000 });
      // Pre-#835 zeta answered mcp with kind "text"; fulcrum 69eb643a parses it as malformed.
      fake.overrideResult("slash_run", (params) => String(params.text).startsWith("/mcp") ? { kind: "text", text: "LEGACY_MCP_TEXT mcp: 0 mounted" } : { kind: "output", text: "fake status\nready", format: "markdown", future: [1] });
      const legacy = await slashReceipt(page, "/mcp status", true);
      if (legacy !== "invalid response from server") throw new Error(`legacy kind text showed ${JSON.stringify(legacy)}`);
      if ((await page.locator("body").innerText()).includes("LEGACY_MCP_TEXT")) throw new Error("legacy kind text reached the page");
      await dismiss(page);
      await field(page).fill("");
      const status = await slashReceipt(page, "/status", false);
      if (status !== "fake status\nready") throw new Error(`additive kind output showed ${JSON.stringify(status)}`);
      await dismiss(page);
      assertNoSlashSend(start, true);
      assertNotCalled(start, ["input_prepare", "path_complete", "child_run_list", "run_work_list"]);
    });

    await check("server without slash methods: no menu, slash drafts retained locally, gamma's own commands still run", async () => {
      resetServer();
      fake.setServerShape({ omitRequests: ["slash_list", "slash_run"] });
      const start = await openRun(page);
      if (await menuRows(page, false) || (await seen()).menu) throw new Error("command menu rendered without slash_list");
      for (const draft of ["/status", "/review the change", "/plan write it"]) {
        const shown = await slashReceipt(page, draft, true);
        if (shown !== UNAVAILABLE) throw new Error(`${draft} showed ${JSON.stringify(shown)}`);
      }
      await field(page).fill("");
      await assertLocalActions(page);
      assertNoSlashSend(start, false);
      assertNotCalled(start, ["slash_list", "slash_run"]);
    });

    await check("server without model_input_ids: menu stays, commands that need it are retained and never sent", async () => {
      resetServer();
      fake.setModelInputIds(false);
      const start = await openRun(page);
      const rows = await menuRows(page, true);
      if (rows !== RUNNABLE) throw new Error(`menu showed ${rows} of ${RUNNABLE} rows without model_input_ids`);
      const shown = await slashReceipt(page, "/review the change", true);
      if (shown !== UNAVAILABLE) throw new Error(`/review showed ${JSON.stringify(shown)}`);
      await field(page).fill("");
      await assertLocalActions(page);
      assertNoSlashSend(start, false);
      assertNotCalled(start, ["slash_run"]);
    });

    await check("server without session_grants: no permissions control at any point, /permissions names the missing server support", async () => {
      resetServer();
      fake.setSessionGrantsEnabled(false);
      const start = await openRun(page);
      await Bun.sleep(500);
      if ((await seen()).permissions || await permissions(page).count()) throw new Error("permissions control rendered without session_grants");
      const shown = await slashReceipt(page, "/permissions", true);
      if (shown !== "permissions need a newer zeta server") throw new Error(`/permissions showed ${JSON.stringify(shown)}`);
      await dismiss(page);
      await field(page).fill("");
      assertNoSlashSend(start, true);
      assertNotCalled(start, ["session_grants", "revoke_session_grants"]);
    });

    await check("protocol 1.0 hello: no features, no menu, no permissions; slash drafts retained; plain text still sends", async () => {
      resetServer();
      // shortcut: the fake still answers session_history so the run opens; a real 1.0 server rejects fulcrum's 1.2 hello (next row).
      fake.setServerShape({ protocol: "1.0", omitRequests: ["slash_list", "slash_run", "session_grants", "revoke_session_grants", "model_catalog", "session_settings", "set_settings", "send_images", "rename_session", "session_tree", "switch_branch"] });
      const start = await openRun(page);
      await Bun.sleep(500);
      if (await menuRows(page, false) || (await seen()).menu) throw new Error("command menu rendered on protocol 1.0");
      if ((await seen()).permissions || await permissions(page).count()) throw new Error("permissions control rendered on protocol 1.0");
      const shown = await slashReceipt(page, "/status", true);
      if (shown !== UNAVAILABLE) throw new Error(`/status showed ${JSON.stringify(shown)}`);
      await field(page).fill("");
      await assertLocalActions(page);
      await dismiss(page);
      const sent = fake.requests.length;
      await submit(page, "plain words still reach the model");
      await until(() => since(sent).some((request) => request.method === "send" && request.params.text === "plain words still reach the model"), 10_000, "plain text send");
      await labeled("the plain send settles", page.locator('form[data-part="composer"]:not([data-pending])').waitFor({ timeout: 20_000 }));
      assertNoSlashSend(start, false);
      assertNotCalled(start, ["slash_list", "slash_run", "session_grants", "revoke_session_grants"]);
    });

    await check("protocol mismatch (-32002): incompatible state, nothing sent", async () => {
      resetServer();
      fake.setMode("incompatible");
      try {
        const start = fake.requests.length;
        await page.goto(`${origin}/?run=${ACTIVE}`);
        await page.getByText("unsupported protocol version", { exact: true }).first().waitFor({ timeout: 15_000 });
        if (since(start).some((request) => request.method !== "hello")) throw new Error(`gamma sent ${since(start).map((request) => request.method).join(", ")} after a refused hello`);
      } finally { fake.setMode("ok"); }
    });

    await check("reconnect to a server with fewer capabilities, then back: controls follow the new hello, draft and attachment stay", async () => {
      resetServer();
      await openRun(page);
      const rows = await menuRows(page, true);
      await permissions(page).waitFor({ timeout: 10_000 });
      if (rows !== RUNNABLE) throw new Error(`full server menu showed ${rows} of ${RUNNABLE} rows`);
      const image = join(gammaHome, "compat.png");
      await writeFile(image, PIXEL);
      await page.locator('input[type="file"]').setInputFiles(image);
      await page.getByLabel("remove compat.png").waitFor({ timeout: 5_000 });
      const draft = "/status after the server changed";
      await field(page).fill(draft);
      await field(page).press("Escape");

      fake.setServerShape({ omitRequests: ["slash_list", "slash_run"] });
      fake.setModelInputIds(false);
      fake.setSessionGrantsEnabled(false);
      const start = fake.requests.length;
      fake.drop();
      await until(() => since(start).some((request) => request.method === "session_history" && request.replied !== undefined), 20_000, "reconnect session_history replied");
      await labeled("run ready after the downgrade", page.locator('.status-line[data-state="ready"]').waitFor({ timeout: 15_000 }));
      await until(async () => !(await permissions(page).count()), 5_000, "permissions control removed after the downgrade");
      if ((await field(page).inputValue()) !== draft) throw new Error(`reconnect changed the draft to ${JSON.stringify(await field(page).inputValue())}`);
      if (await page.locator('[data-part="attachment"]').count() !== 1) throw new Error("reconnect dropped the queued attachment");
      await field(page).press("Enter");
      await receipt(page).waitFor({ timeout: 10_000 }).catch(async () => { throw new Error(`downgraded /status showed no receipt; composer ${JSON.stringify(await field(page).inputValue())}; status ${await page.locator(".status-line").getAttribute("data-state").catch(() => "none")}; requests ${since(start).map((request) => request.method).join(",")}; body ${(await page.locator("body").innerText()).slice(-600)}`); });
      const shown = await receipt(page).innerText();
      if (!shown.startsWith(UNAVAILABLE)) throw new Error(`downgraded /status showed ${JSON.stringify(shown)}`);
      if ((await field(page).inputValue()).trim() !== draft) throw new Error("downgraded /status lost its draft");
      if (await page.locator('[data-part="attachment"]').count() !== 1) throw new Error("downgraded /status dropped the attachment");
      await dismiss(page);
      const kept = await field(page).inputValue();
      await field(page).fill("/");
      await Bun.sleep(300);
      if (await menu(page).count()) throw new Error("stale command menu after reconnecting without slash_list");
      await field(page).fill(kept);
      await field(page).press("Escape");
      assertNoSlashSend(start, false);
      assertNotCalled(start, ["slash_list", "slash_run", "session_grants", "revoke_session_grants"]);

      resetServer();
      const back = fake.requests.length;
      fake.drop();
      await until(() => since(back).some((request) => request.method === "session_history" && request.replied !== undefined), 20_000, "second reconnect session_history replied");
      await labeled("permissions control returns after the upgrade", permissions(page).waitFor({ timeout: 10_000 }));
      if ((await field(page).inputValue()) !== draft) throw new Error("upgrade reconnect changed the draft");
      if (await page.locator('[data-part="attachment"]').count() !== 1) throw new Error("upgrade reconnect dropped the attachment");
      await field(page).fill("/");
      await labeled("command menu returns after the upgrade", menu(page).waitFor({ timeout: 10_000 }));
      await field(page).fill("");
      await page.getByLabel("remove compat.png").click();
      assertNoSlashSend(back, true);
    });

    if (errors.length) failures.push(...errors.map((error) => `browser error: ${error}`));
  } finally { await browser.close(); }
} finally {
  vite.kill("SIGTERM");
  await fake.close();
  await rm(gammaHome, { recursive: true, force: true });
}
if (failures.length) { console.log(`\ncompat gate: ${failures.length} failed`); process.exit(1); }
console.log("\ncompat gate: all rows passed");
