import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium, webkit, type Page } from "playwright";
import { themes } from "@fulcrum/react";
import { ACTIVE, startFakeZeta } from "./fake-zeta";
import { completeSlashCatalog, defaultSlashCatalog } from "./fake-slash-catalog";

const root = new URL("..", import.meta.url).pathname;
const FRESH_REFUSAL = "this command needs an open run: send a message first";
const FRESH_REFUSAL_WITH_IMAGE = `${FRESH_REFUSAL}\nattachments stay queued for your next message.`;
const portText = process.env.WEB_COMMAND_GATE_PORT ?? "4195";
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
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
/** The sRGB bytes of one screen pixel and of a CSS color, read the same way so they compare. */
const pixel = async (page: Page, x: number, y: number) => {
  const png = (await page.screenshot({ clip: { x, y, width: 1, height: 1 } })).toString("base64");
  return page.evaluate(async (data) => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }, png);
};
const cssColor = (page: Page, value: string) => page.evaluate((color) => {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  context.fillStyle = "#000"; context.fillStyle = color; context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}, value);
const distance = (a: number[], b: number[]) => a.reduce((sum, part, index) => sum + Math.abs(part - b[index]!), 0);
const submit = async (page: Page, text: string) => {
  await field(page).fill(text);
  await field(page).press("Enter");
  if (text.startsWith("/") && (await field(page).inputValue()).trim() === text) await field(page).press("Enter");
};

/** Rows inside the list's scrollport, the active row, and points just inside its top and bottom edges. */
const measureList = (page: Page) => page.getByRole("listbox", { name: "command suggestions" }).evaluate((node) => {
  const box = node.getBoundingClientRect();
  const composerField = document.querySelector('[data-part="composer-field"]')!.getBoundingClientRect();
  const top = box.top + node.clientTop, bottom = top + node.clientHeight;
  const all = [...node.querySelectorAll('[role="option"]')].map((option) => option.getBoundingClientRect());
  const rows = all.filter((row) => row.bottom > top + 0.5 && row.top < bottom - 0.5);
  const active = document.getElementById(document.querySelector('textarea[aria-label="message"]')!.getAttribute("aria-activedescendant") ?? "")?.getBoundingClientRect();
  const x = Math.floor(box.right) - 6;
  return {
    gap: composerField.top - box.bottom, overflowing: node.scrollHeight > node.clientHeight + 1, rows: rows.length,
    moreAbove: node.scrollTop > 0.5, moreBelow: node.scrollTop + node.clientHeight < node.scrollHeight - 0.5,
    clipped: rows.filter((row) => row.top < top - 0.5 || row.bottom > bottom + 0.5).map((row) => [Math.round(row.top - top), Math.round(row.bottom - bottom)]),
    activeHidden: !active || active.top < top - 0.5 || active.bottom > bottom + 0.5,
    topRow: rows[0] ? { x: Math.floor(rows[0].left + rows[0].width / 2), y: Math.floor(rows[0].top + rows[0].height / 2) } : null,
    edge: { x, y: Math.floor(bottom) - 3 }, edgeMid: { x, y: Math.floor(bottom - all[0]!.height / 2) },
    topEdge: { x, y: Math.ceil(top) + 2 }, topMid: { x, y: Math.floor(top + all[0]!.height / 2) },
    background: getComputedStyle(node).backgroundColor,
  };
});
const settle = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const openList = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.mouse.move(0, 0);
  await field(page).fill("");
  await field(page).fill("/");
  await page.getByRole("listbox", { name: "command suggestions" }).waitFor();
  await settle(page);
};
const closeList = async (page: Page) => { await page.mouse.move(0, 0); await field(page).press("Escape"); await field(page).fill(""); };
async function listGeometry(page: Page) {
  try {
    await openList(page);
    const listbox = page.getByRole("listbox", { name: "command suggestions" });
    const atTop = await measureList(page);
    if (atTop.gap < 4) throw new Error(`command list touches the composer field: gap ${atTop.gap}px`);
    if (!atTop.overflowing) throw new Error("the default catalog no longer overflows the command list");
    if (atTop.clipped.length) throw new Error(`the command list cuts ${atTop.clipped.length} visible row(s) at its edge: ${JSON.stringify(atTop)}`);
    const background = await cssColor(page, atTop.background);
    const moreBelow = distance(await pixel(page, atTop.edge.x, atTop.edge.y), background);
    if (moreBelow < 12) throw new Error(`the command list shows no boundary for rows below its edge (distance ${moreBelow})`);
    for (let index = 0; index <= atTop.rows; index++) await field(page).press("ArrowDown");
    await settle(page);
    const moved = await measureList(page);
    if (moved.activeHidden || moved.clipped.length) throw new Error(`keyboard moved the active row out of view: ${JSON.stringify(moved)}`);
    await listbox.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await settle(page);
    const atEnd = await measureList(page);
    if (atEnd.clipped.length) throw new Error(`the scrolled command list cuts ${atEnd.clipped.length} row(s)`);
    const endEdge = distance(await pixel(page, atEnd.edge.x, atEnd.edge.y), background);
    if (endEdge > 6) throw new Error(`the command list still marks rows below after the last row (distance ${endEdge})`);
  } finally { await closeList(page); }
}
/** The "more rows" shade must paint over the rows: the active and hovered rows fill their whole box, so a shade under them is hidden. */
async function listShades(page: Page, name: string) {
  try {
    await openList(page);
    const listbox = page.getByRole("listbox", { name: "command suggestions" });
    const atTop = await measureList(page);
    for (let index = 0; index <= atTop.rows; index++) await field(page).press("ArrowDown");
    await settle(page);
    const arrowed = await measureList(page);
    if (!arrowed.moreBelow) throw new Error(`${name} the catalog has no rows below the arrowed list: ${JSON.stringify(arrowed)}`);
    const below = distance(await pixel(page, arrowed.edge.x, arrowed.edge.y), await pixel(page, arrowed.edgeMid.x, arrowed.edgeMid.y));
    await page.screenshot({ path: join(shots, `${name}-list-arrowed-bottom-shade.png`), clip: await listbox.boundingBox() ?? undefined });
    if (below < 12) throw new Error(`${name} the bottom shade is hidden by the active edge row after ${atTop.rows + 1} ArrowDown (distance ${below})`);
    await listbox.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await settle(page);
    const atEnd = await measureList(page);
    if (!atEnd.moreAbove || !atEnd.topRow) throw new Error(`${name} the scrolled list has no rows above: ${JSON.stringify(atEnd)}`);
    await page.mouse.move(atEnd.topRow.x, atEnd.topRow.y);
    await settle(page);
    const above = distance(await pixel(page, atEnd.topEdge.x, atEnd.topEdge.y), await pixel(page, atEnd.topMid.x, atEnd.topMid.y));
    await page.screenshot({ path: join(shots, `${name}-list-hovered-top-shade.png`), clip: await listbox.boundingBox() ?? undefined });
    if (above < 12) throw new Error(`${name} the top shade is hidden by the hovered edge row after scrolling (distance ${above})`);
  } finally { await closeList(page); }
}
/** A wheel or trackpad scroll comes to rest on a row boundary, as the keyboard does. */
async function listWheel(page: Page, name: string) {
  try {
    await openList(page);
    const box = (await page.getByRole("listbox", { name: "command suggestions" }).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(600);
    await settle(page);
    const rested = await measureList(page);
    if (!rested.moreAbove) throw new Error(`${name} the wheel did not scroll the list: ${JSON.stringify(rested)}`);
    if (rested.clipped.length) throw new Error(`${name} a wheel scroll left ${rested.clipped.length} half row(s): ${JSON.stringify(rested.clipped)}`);
  } finally { await closeList(page); }
}

try {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (vite.exitCode !== null) throw new Error(`vite exited ${vite.exitCode}`);
    if (await fetch(origin).then((response) => response.ok, () => false)) break;
    await Bun.sleep(100);
  }
  // CI installs only chromium; on macOS the list's paint order is also checked in webkit.
  if (process.platform === "darwin") {
    const safari = await webkit.launch();
    try {
      const other = await safari.newPage({ viewport: { width: 1440, height: 900 } });
      other.on("pageerror", (error) => errors.push(`webkit: ${error.message}`));
      await other.goto(`${origin}/?run=${ACTIVE}`);
      await waitReady(other);
      await check("webkit edge shades stay visible over the active and the hovered edge row", () => listShades(other, "webkit"));
      await check("webkit free wheel scrolling rests on whole rows", () => listWheel(other, "webkit"));
    } finally { await safari.close(); }
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("console", (message) => { if (message.type() === "error" && !/WebSocket connection|Failed to load resource/.test(message.text())) errors.push(message.text()); });
    page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await waitReady(page);
    await page.waitForLoadState("networkidle");

    await check("a fresh run's command refusal names the prerequisite and keeps the image queued", async () => {
      const image = join(gammaHome, "fresh.png");
      await writeFile(image, PIXEL);
      await page.locator('input[type="file"]').setInputFiles(image);
      await page.getByLabel("remove fresh.png").waitFor({ timeout: 5_000 });
      try {
        const start = fake.requests.length;
        await submit(page, "/status");
        const receipt = page.locator(".command-receipt-text");
        await receipt.waitFor({ timeout: 5_000 });
        await page.setViewportSize({ width: 390, height: 844 });
        const fit = await receipt.evaluate((node) => ({ clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, width: node.clientWidth, lineHeight: getComputedStyle(node).lineHeight, text: (node as HTMLElement).innerText }));
        await page.screenshot({ path: join(shots, "fresh-refusal-390.png") });
        await page.setViewportSize({ width: 1440, height: 900 });
        if (fit.scrollHeight > fit.clientHeight) throw new Error(`at 390px the fresh refusal hides part of its text: ${JSON.stringify(fit)}`);
        const copy = await receipt.innerText();
        if (copy !== FRESH_REFUSAL_WITH_IMAGE) throw new Error(`fresh refusal copy was ${JSON.stringify(copy)}`);
        if (fake.requests.slice(start).some((request) => ["new_session", "slash_run", "send", "send_images"].includes(request.method))) throw new Error("fresh attached slash reached zeta");
        if (await page.locator('[data-part="attachment"]').count() !== 1) throw new Error("fresh refusal dropped the attachment");
        if (!await field(page).evaluate((node) => node === document.activeElement)) throw new Error("fresh refusal moved focus out of the composer");
        await page.getByRole("button", { name: "dismiss command result" }).click();
        await page.locator(".command-receipt").waitFor({ state: "detached", timeout: 5_000 });
        if (await page.locator('[data-part="attachment"]').count() !== 1) throw new Error("dismissing the refusal dropped the attachment");
      } finally {
        if (await page.getByRole("button", { name: "dismiss command result" }).count()) await page.getByRole("button", { name: "dismiss command result" }).click();
        if (await page.getByLabel("remove fresh.png").count()) await page.getByLabel("remove fresh.png").click();
        await field(page).fill("");
      }
    });

    await check("a fresh run runs gamma's own commands, which need no zeta session", async () => {
      const start = fake.requests.length;
      await submit(page, "/keys");
      const receipt = page.locator(".command-receipt-text");
      await receipt.waitFor({ timeout: 5_000 });
      const shown = await receipt.innerText();
      if (!shown.includes("browser precedence and terminal-only exclusions")) throw new Error(`fresh /keys answered ${JSON.stringify(shown.slice(0, 120))}`);
      if (fake.requests.slice(start).some((request) => ["new_session", "slash_run", "send"].includes(request.method))) throw new Error("fresh /keys reached zeta");
      if ((await field(page).inputValue()).trim() !== "") throw new Error("fresh /keys left its draft in the composer");
      await page.getByRole("button", { name: "dismiss command result" }).click();
      await page.locator(".command-receipt").waitFor({ state: "detached", timeout: 5_000 });
    });

    await check("fresh draft blocks slash but double slash starts a direct turn", async () => {
      const start = fake.requests.length;
      await submit(page, "/status");
      await page.getByText(FRESH_REFUSAL, { exact: true }).waitFor();
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

    await check("preparation rejection and timeout stay with the originating run and retain attachments", async () => {
      const image = join(gammaHome, "prepare.png");
      await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
      await page.locator('input[type="file"]').setInputFiles(image);
      await page.getByLabel("remove prepare.png").waitFor({ timeout: 5_000 });
      for (const message of ["slash rejected", "request timed out"]) {
        fake.failNext("slash_run", message);
        await submit(page, "/status");
        const receipt = page.locator('.command-receipt[data-tone="error"] .command-receipt-text');
        await receipt.getByText(message, { exact: false }).waitFor({ timeout: 5_000 });
        await receipt.getByText("attachments are still attached and were not sent.", { exact: false }).waitFor();
        if ((await field(page).inputValue()).trim() !== "/status") throw new Error(`${message} did not retain the command draft`);
      }
      await page.getByRole("button", { name: "new run" }).click();
      if (await page.locator(".command-receipt").count()) throw new Error("preparation receipt leaked into another run");
      await page.goBack();
      await page.locator('.command-receipt[data-tone="error"] .command-receipt-text', { hasText: "request timed out" }).waitFor({ timeout: 5_000 });
      await page.getByLabel("remove prepare.png").click();
      await field(page).fill("");
    });

    await check("model output identity refreshes settings", async () => {
      if (await page.getByRole("button", { name: "dismiss command result" }).count()) await page.getByRole("button", { name: "dismiss command result" }).click();
      const modelSettings = requests("session_settings").length;
      await submit(page, "/model claude-sonnet-5");
      await page.locator(".command-receipt-text", { hasText: "model: claude-sonnet-5" }).waitFor();
      if (requests("session_settings").length !== modelSettings + 1) throw new Error("/model output identity did not trigger one settings refresh");
      await page.getByRole("button", { name: "model: claude-sonnet-5" }).waitFor();
      await page.getByRole("button", { name: "dismiss command result" }).click();
      const currentRun = new URL(page.url()).searchParams.get("run");
      if (!currentRun) throw new Error("model identity check lost the current run id");
      fake.setSettings(currentRun, { model: "gpt-5.1-codex", approval_mode: "ask", plan_mode: false });
    });

    await check("vim output identity reads status and synchronizes the composer", async () => {
      if (await page.getByRole("button", { name: "dismiss command result" }).count()) await page.getByRole("button", { name: "dismiss command result" }).click();
      const vimStatus = requests("status").length;
      await submit(page, "/vim on");
      await page.locator(".command-receipt-text", { hasText: "vim mode: on" }).waitFor();
      if (requests("status").length !== vimStatus + 1) throw new Error("/vim output identity did not trigger one status read");
      await page.locator(".vim-mode").waitFor();
      await page.getByRole("button", { name: "dismiss command result" }).click();
      await submit(page, "/vim off");
      await page.locator(".command-receipt-text", { hasText: "vim mode: off" }).waitFor();
      if (await page.locator(".vim-mode").count()) throw new Error("/vim off identity did not synchronize the composer mode");
      await page.getByRole("button", { name: "dismiss command result" }).click();
      await page.locator(".command-receipt").waitFor({ state: "detached" });
    });

    await check("shared registry frames keep runnable and unavailable commands distinct", async () => {
      if (defaultSlashCatalog.length !== 18 || completeSlashCatalog.length !== 40 || completeSlashCatalog.filter((entry) => entry.unavailable === "requires_tui").length !== 22) throw new Error("fake slash catalogs drifted from Zeta 3e1f48a39cc5a08e4814b91d0ecaa44dba17e489");
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
      for (const [command, output] of [["/accounts", "no accounts"], ["/model", "model: gpt-5.1-codex (open Settings to switch)"], ["/vim off", "vim mode: off"]] as const) {
        const start = fake.requests.length;
        await field(page).fill(command);
        await field(page).press("Escape");
        await field(page).press("Enter");
        await page.locator(".command-receipt-text", { hasText: output }).waitFor({ timeout: 10_000 }).catch(async () => { throw new Error(`${command} showed no receipt ${JSON.stringify(output)}; value=${JSON.stringify(await field(page).inputValue())}`); });
        await page.getByRole("button", { name: "dismiss command result" }).click();
        await page.locator(".command-receipt").waitFor({ state: "detached" });
        const calls = fake.requests.slice(start);
        const slash = calls.filter((request) => request.method === "slash_run");
        if (slash.length !== 1 || slash[0]?.params.text !== command) throw new Error(`${command} sent wrong requests: ${JSON.stringify(calls)}`);
      }
      await receipt("/approve", "approval · no matching request");
      await submit(page, "/help");
      const help = page.locator(".command-receipt-text");
      await help.getByText("built-in commands:", { exact: false }).waitFor().catch(async () => { throw new Error(`/help showed no built-in list; receipt=${JSON.stringify(await help.innerText().catch(() => "missing"))}`); });
      if ((await help.innerText()).includes("/approve")) throw new Error("serve help exposed a TUI-only command");
    });

    await check("client-only actions use gamma controls and protocol requests", async () => {
      const commandReceipt = async (command: string, text: string) => {
        await submit(page, command);
        await page.locator(".command-receipt-text", { hasText: text }).waitFor({ timeout: 10_000 });
        await page.getByRole("button", { name: "dismiss command result" }).click();
      };
      await commandReceipt("/name gamma proof", "session name: gamma proof");
      if (!requests("rename_session").some((request) => request.params.name === "gamma proof")) throw new Error("/name did not call rename_session");
      await page.getByRole("heading", { name: "gamma proof" }).waitFor();
      await commandReceipt("/theme github-light", "theme: github-light");
      if (await page.evaluate(() => document.documentElement.dataset.fulcrumTheme) !== "github-light") throw new Error("/theme did not change the theme");
      await commandReceipt("/keys", "enter");
      const hint = await page.locator('[data-part="composer-hint"]').innerText();
      if (!hint.includes("enter to send") || !hint.includes("shift+enter for a new line")) throw new Error(`composer hint drifted from /keys: ${hint}`);
      const chooser = page.waitForEvent("filechooser");
      await submit(page, "/paste");
      await chooser;
      await page.locator(".command-receipt-text", { hasText: "choose images to attach" }).waitFor();
      await page.getByRole("button", { name: "dismiss command result" }).click();
      await commandReceipt("/restart", "gamma reconnects on its own");
      await submit(page, "/permissions");
      await page.getByRole("dialog", { name: "session permissions" }).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog", { name: "session permissions" }).waitFor({ state: "detached" });
      await commandReceipt("/tree", "experiment");
      const before = fake.requests.length;
      await commandReceipt("/tree 2", "switched to branch 2");
      const branch = fake.requests.slice(before);
      if (!branch.some((request) => request.method === "switch_branch" && request.params.head_id === "head-experiment") || !branch.some((request) => request.method === "session_history") || !branch.some((request) => request.method === "status")) throw new Error(`tree switch did not resync and replay: ${JSON.stringify(branch)}`);
    });

    await check("plan output refreshes settings and model input stays opaque", async () => {
      fake.setSettings(ACTIVE, { model: "gpt-5.1-codex", approval_mode: "ask", plan_mode: false });
      const settingsBefore = requests("session_settings").length;
      await submit(page, "/plan");
      await page.locator(".command-receipt-text", { hasText: "plan mode: on" }).waitFor();
      if (await page.locator(".plan-chip", { hasText: "plan" }).count() !== 1) throw new Error("/plan output identity did not refresh the plan indicator on");
      if (requests("session_settings").length !== settingsBefore + 1) throw new Error("/plan output identity did not refresh settings exactly once");
      await page.getByRole("button", { name: "dismiss command result" }).click();
      for (const [command, output, chip] of [["/plan off", "plan mode: off", false], ["/plan on", "plan mode: on", true], ["/plan toggle", "plan mode: off", false]] as const) {
        await submit(page, command);
        await page.locator(".command-receipt-text", { hasText: output }).waitFor();
        if ((await page.locator(".plan-chip").count() > 0) !== chip) throw new Error(`${command} left the wrong plan chip state`);
        await page.getByRole("button", { name: "dismiss command result" }).click();
      }
      const before = fake.requests.length;
      await submit(page, "/plan write a proof");
      for (let attempt = 0; attempt < 100 && !fake.requests.slice(before).some((request) => request.method === "send"); attempt++) await Bun.sleep(25);
      const calls = fake.requests.slice(before);
      const sent = calls.find((request) => request.method === "send");
      const refreshed = calls.some((request) => request.method === "session_settings");
      if (await page.getByRole("button", { name: "stop" }).count()) await page.getByRole("button", { name: "stop" }).click();
      for (let attempt = 0; attempt < 200 && fake.running; attempt++) await Bun.sleep(25);
      await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 });
      if (typeof sent?.params.input_id !== "string" || "text" in (sent?.params ?? {})) throw new Error(`plan prompt was not opaque: ${JSON.stringify(calls)}`);
      if (!refreshed) throw new Error("plan prompt model-input identity did not refresh settings before delivery");
    });

    await check("implement model-input identity refreshes the plan indicator off", async () => {
      if (await page.getByRole("button", { name: "dismiss command result" }).count()) await page.getByRole("button", { name: "dismiss command result" }).click();
      fake.setSettings(ACTIVE, { model: "gpt-5.1-codex", approval_mode: "ask", plan_mode: false });
      await submit(page, "/plan on");
      await page.locator(".command-receipt-text", { hasText: "plan mode: on" }).waitFor();
      const planWasOn = await page.locator(".plan-chip", { hasText: "plan" }).count() === 1;
      await page.getByRole("button", { name: "dismiss command result" }).click();
      const implement = fake.requests.length;
      const implementSettings = requests("session_settings").length;
      await submit(page, "/implement");
      for (let attempt = 0; attempt < 100 && !fake.requests.slice(implement).some((request) => request.method === "send"); attempt++) await Bun.sleep(25);
      const implementation = fake.requests.slice(implement);
      if (!implementation.some((request) => request.method === "send" && typeof request.params.input_id === "string") || implementation.some((request) => request.method === "send" && "text" in request.params)) throw new Error("/implement was not opaque");
      if (planWasOn && await page.locator(".plan-chip").count()) throw new Error("/implement model-input identity did not refresh the plan indicator off");
      if (requests("session_settings").length !== implementSettings + 1) throw new Error("/implement model-input identity did not refresh settings exactly once");
      if (await page.getByRole("button", { name: "stop" }).count()) await page.getByRole("button", { name: "stop" }).click();
      for (let attempt = 0; attempt < 200 && fake.running; attempt++) await Bun.sleep(25);
      await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 });
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
      await page.setViewportSize({ width: 390, height: 844 });
      await field(page).fill("/"); await listbox.waitFor();
      const mobile = await listbox.locator('[role="option"]').evaluateAll((nodes) => nodes.map((node) => {
        const row = node.getBoundingClientRect();
        const description = node.querySelector<HTMLElement>(".command-description")!;
        return { height: row.height, clipped: description.scrollWidth > description.clientWidth, ellipsis: getComputedStyle(description).textOverflow, label: node.getAttribute("aria-label"), description: description.innerText };
      }).sort((a, b) => Number(b.clipped) - Number(a.clipped))[0]);
      if (!mobile || mobile.height > 56 || !mobile.clipped || mobile.ellipsis !== "ellipsis" || !mobile.label?.includes(mobile.description)) throw new Error(`mobile command row is not one accessible row: ${JSON.stringify(mobile)}`);
      await page.setViewportSize({ width: 1440, height: 900 });
      await field(page).fill("/st"); await listbox.waitFor();
      const imeRequests = fake.requests.length;
      await field(page).evaluate((node) => node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
      await field(page).dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
      if (await field(page).inputValue() !== "/st" || fake.requests.length !== imeRequests) throw new Error("ime enter accepted or submitted a completion");
      await field(page).evaluate((node) => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
      await field(page).press("Escape");
    });

    await check("desktop command list sits apart from the field, shows whole rows, and marks rows beyond its edge", () => listGeometry(page));
    await check("chromium edge shades stay visible over the active and the hovered edge row", () => listShades(page, "chromium"));
    await check("chromium free wheel scrolling rests on whole rows", () => listWheel(page, "chromium"));
    await check("without round() support the command list stays bounded", async () => {
      await field(page).fill("/");
      const listbox = page.getByRole("listbox", { name: "command suggestions" });
      await listbox.waitFor();
      // An engine without round() skips the @supports block, and a max-height that uses round() with var() computes to none.
      const unsupported = await listbox.evaluate((node) => {
        const strip = (rules: CSSRuleList) => {
          for (let index = rules.length - 1; index >= 0; index--) {
            const rule = rules[index]!;
            if (rule instanceof CSSSupportsRule && rule.conditionText.includes("round(")) { (rule.parentRule as CSSGroupingRule | null ?? rule.parentStyleSheet!).deleteRule(index); continue; }
            if (rule instanceof CSSStyleRule && rule.style.maxHeight.includes("round(")) rule.style.removeProperty("max-height");
            if ("cssRules" in rule) strip((rule as CSSGroupingRule).cssRules);
          }
        };
        for (const sheet of document.styleSheets) { try { strip(sheet.cssRules); } catch {} }
        const row = node.querySelector('[role="option"]')!.getBoundingClientRect().height;
        return { height: node.clientHeight, row, maxHeight: getComputedStyle(node).maxHeight };
      });
      await field(page).press("Escape");
      await field(page).fill("");
      await page.reload();
      await waitReady(page);
      if (unsupported.maxHeight === "none" || unsupported.height > 6 * unsupported.row + 1) throw new Error(`without round() the command list grows unbounded: ${JSON.stringify(unsupported)}`);
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
            hoverDecoration: getComputedStyle(hovered).textDecorationLine,
          };
        });
        if (audit.activeIndex !== 1 || audit.hoveredSelected || !audit.activeBar || audit.activeBar.width < 3 || audit.barContrast < 3 || audit.hoveredBar || audit.sameBackground || audit.textContrast < 4.5 || audit.hoverDecoration !== "none") throw new Error(`${theme} at ${width}px: ${JSON.stringify(audit)}`);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => { delete document.documentElement.dataset.fulcrumTheme; });
      await field(page).press("Escape");
      await field(page).fill("");
    });

    await check("error receipts carry a text label and keyboard dismiss returns focus to the composer", async () => {
      await submit(page, "/does-not-exist");
      await page.locator('.command-receipt[data-tone="error"] .command-receipt-label', { hasText: "error" }).waitFor({ timeout: 5_000 }).catch(() => { throw new Error("error receipt has no text label"); });
      const liveRegion = await page.locator('.command-receipt[data-tone="error"]').evaluate((receipt) => ({ receiptRole: receipt.getAttribute("role"), textRole: receipt.querySelector(".command-receipt-text")?.getAttribute("role"), dismissRole: receipt.querySelector("button")?.getAttribute("role") }));
      if (liveRegion.receiptRole || liveRegion.textRole !== "alert" || liveRegion.dismissRole) throw new Error(`receipt live region includes the wrong node: ${JSON.stringify(liveRegion)}`);
      const dismiss = page.getByRole("button", { name: "dismiss command result" });
      await dismiss.focus();
      await dismiss.press("Enter");
      await page.locator(".command-receipt").waitFor({ state: "detached", timeout: 5_000 });
      if (!(await field(page).evaluate((node) => node === document.activeElement))) throw new Error(`dismiss left focus on ${await page.evaluate(() => document.activeElement?.tagName)}`);
      await submit(page, "/mcp");
      const quiet = page.locator('.command-receipt[data-tone="quiet"]');
      await quiet.waitFor();
      const quietLiveRegion = await quiet.evaluate((receipt) => ({ receiptRole: receipt.getAttribute("role"), textRole: receipt.querySelector(".command-receipt-text")?.getAttribute("role"), dismissInside: Boolean(receipt.querySelector('.command-receipt-text button')) }));
      if (quietLiveRegion.receiptRole || quietLiveRegion.textRole !== "status" || quietLiveRegion.dismissInside) throw new Error(`quiet receipt live region includes the wrong node: ${JSON.stringify(quietLiveRegion)}`);
      if (await page.locator(".command-receipt .command-receipt-label").count()) throw new Error("quiet receipt shows the error label");
      await page.getByRole("button", { name: "dismiss command result" }).click();
      await field(page).fill("");
    });

    await check("an identical replacement receipt starts at the top", async () => {
      fake.setLongStatus(true);
      await submit(page, "/status");
      const receiptText = page.locator(".command-receipt-text");
      await receiptText.getByText("status detail 80", { exact: false }).waitFor();
      await receiptText.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      const before = requests("slash_run").length;
      await submit(page, "/status");
      for (let attempt = 0; attempt < 100 && requests("slash_run").length === before; attempt++) await Bun.sleep(25);
      await page.waitForTimeout(50);
      if (await receiptText.evaluate((node) => node.scrollTop) !== 0) throw new Error("same-text receipt kept its old scroll position");
      fake.setLongStatus(false);
      await page.getByRole("button", { name: "dismiss command result" }).click();
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
      const dismiss = page.getByRole("button", { name: "dismiss command result" });
      await dismiss.focus();
      await dismiss.press("Enter");
    });

    await check("opaque model input sends once without exposing its id", async () => {
      const start = fake.requests.length;
      await submit(page, "/review");
      for (let attempt = 0; attempt < 100 && !fake.requests.slice(start).some((request) => request.method === "send"); attempt++) await Bun.sleep(50);
      const calls = fake.requests.slice(start);
      const sends = calls.filter((request) => request.method === "send");
      if (calls.filter((request) => request.method === "slash_run").length !== 1 || sends.length !== 1) throw new Error(`expected one prepare and one send, got ${calls.map((call) => call.method)}`);
      if (sends[0]?.params.input_id !== "opaque-review-input" || "text" in (sends[0]?.params ?? {})) throw new Error("opaque send used the wrong shape");
      // The fake records the delivery after it logs the request, so wait for the recorded user row text.
      for (let attempt = 0; attempt < 100 && fake.sent.at(-1)?.text !== "/review"; attempt++) await Bun.sleep(50);
      if (fake.sent.at(-1)?.text !== "/review") throw new Error(`opaque send did not keep its display text for the user row: ${JSON.stringify(fake.sent.at(-1))}`);
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
      if ((await retry.innerText()).trim() !== "edit and retry") throw new Error(`command retry label was ${JSON.stringify(await retry.innerText())}`);
      const before = fake.requests.length;
      await retry.click();
      await page.waitForTimeout(500);
      const textSends = fake.requests.slice(start).filter((request) => request.method === "send" && "text" in request.params);
      if (textSends.length) throw new Error(`retry sent slash text: ${JSON.stringify(textSends.map((request) => request.params.text))}`);
      if (fake.requests.slice(before).some((request) => ["send", "steer", "send_images", "slash_run"].includes(request.method))) throw new Error("retry reached zeta without the user submitting");
      if ((await field(page).inputValue()).trim() !== "/review fail this turn") throw new Error(`retry did not restore the command draft: ${JSON.stringify(await field(page).inputValue())}`);
      await field(page).fill("");
    });

    await check("ordinary retry resends immediately while literal slash retry round-trips through the draft", async () => {
      const retry = page.locator(".turn-retry");
      await submit(page, "//fail this turn");
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".turn-retry")?.innerText.trim() === "edit and retry", undefined, { timeout: 15_000 }).catch(async () => { throw new Error(`literal retry label was ${JSON.stringify(await retry.innerText())}; sent=${JSON.stringify(fake.sent.slice(-4))}`); });
      await retry.click();
      if ((await field(page).inputValue()).trim() !== "//fail this turn") throw new Error(`literal retry restored ${JSON.stringify(await field(page).inputValue())}`);
      const resubmit = fake.requests.length;
      await field(page).press("Enter");
      for (let attempt = 0; attempt < 100 && !fake.requests.slice(resubmit).some((request) => request.method === "send"); attempt++) await Bun.sleep(25);
      const calls = fake.requests.slice(resubmit);
      if (calls.filter((request) => request.method === "send" && request.params.text === "/fail this turn").length !== 1 || calls.some((request) => request.method === "slash_run")) throw new Error(`literal retry used wrong flow: ${JSON.stringify(calls)}`);
      for (let attempt = 0; attempt < 100 && !fake.running; attempt++) await Bun.sleep(25);
      for (let attempt = 0; attempt < 600 && fake.running; attempt++) await Bun.sleep(25);
      if (fake.running) throw new Error("literal retry turn did not finish");
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".turn-retry")?.innerText.trim() === "edit and retry", undefined, { timeout: 15_000 });

      await submit(page, "fail this turn");
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".turn-retry")?.innerText.trim() === "retry", undefined, { timeout: 15_000 }).catch(async () => { throw new Error(`ordinary retry label was ${JSON.stringify(await retry.innerText())}`); });
      const ordinaryStart = requests("send").length;
      await retry.click();
      for (let attempt = 0; attempt < 100 && requests("send").length === ordinaryStart; attempt++) await Bun.sleep(25);
      if (requests("send").length !== ordinaryStart + 1) throw new Error("ordinary retry did not immediately send once");
      for (let attempt = 0; attempt < 600 && fake.running; attempt++) await Bun.sleep(25);
      if (fake.running) throw new Error("ordinary retry turn did not finish");
    });

    await field(page).waitFor();
    await check("active commands use server busy routing and keep opaque input local", async () => {
      await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 }).catch(async () => { throw new Error(`composer did not become idle; text: ${await page.locator("body").innerText()}`); });
      await submit(page, "start a turn");
      await page.getByPlaceholder("steer the running turn").waitFor({ timeout: 10_000 }).catch(() => { throw new Error(`turn did not start; requests: ${fake.requests.slice(-8).map((request) => request.method).join(",")}`); });
      const busyImage = join(gammaHome, "busy-plan.png");
      await writeFile(busyImage, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
      await page.locator('input[type="file"]').setInputFiles(busyImage);
      await page.getByLabel("remove busy-plan.png").waitFor();
      const settingsBefore = requests("session_settings").length;
      const before = { slash: requests("slash_run").length, send: requests("send").length, steer: requests("steer").length };
      await field(page).fill("/plan");
      await field(page).press("Escape");
      await field(page).press("Enter");
      await page.locator(".command-receipt-text", { hasText: "until this turn ends" }).waitFor({ timeout: 5_000 }).catch(async () => { throw new Error(`active command receipt missing; url=${page.url()}; value=${JSON.stringify(await field(page).inputValue())}; requests=${fake.requests.slice(-8).map((request) => request.method).join(",")}; body=${await page.locator("body").innerText()}; html=${(await page.locator("body").innerHTML()).slice(0, 5000)}`); });
      const composerMessage = page.locator('[data-part="composer-message"]');
      for (let attempt = 0; attempt < 80 && /^(steering|sending)$/.test(await composerMessage.innerText()); attempt++) await Bun.sleep(25);
      const shown = { receipts: await page.locator(".command-receipt-text").allInnerTexts(), composer: await composerMessage.innerText() };
      if (shown.receipts.length !== 1 || shown.composer.trim()) throw new Error(`one busy refusal showed two messages: ${JSON.stringify(shown)}`);
      const busy = page.locator(".command-receipt");
      if (!shown.receipts[0]!.startsWith("/plan waits until this turn ends; your draft is kept") || await busy.getAttribute("data-tone") !== "quiet") throw new Error(`busy refusal does not name the command as a quiet wait: ${JSON.stringify({ text: shown.receipts[0], tone: await busy.getAttribute("data-tone") })}`);
      if (requests("slash_run").length !== before.slash + 1 || requests("send").length !== before.send || requests("steer").length !== before.steer) throw new Error("active plan did not stop at slash_run");
      if (requests("session_settings").length !== settingsBefore) throw new Error("busy plan refreshed settings");
      if ((await field(page).inputValue()).trim() !== "/plan") throw new Error("active turn lost the slash draft");
      if (await page.locator('[data-part="attachment"]').count() !== 1) throw new Error("busy plan lost its attachment");
      await page.locator(".command-receipt-text", { hasText: "attachments are still attached and were not sent." }).waitFor();
      await field(page).fill("");
      const opaque = { send: requests("send").length, steer: requests("steer").length };
      await submit(page, "/review");
      for (let attempt = 0; attempt < 100 && requests("send").length === opaque.send && requests("steer").length === opaque.steer && !await page.locator(".command-receipt-text", { hasText: "this command sends a message; it waits until the turn ends" }).count(); attempt++) await Bun.sleep(25);
      if (requests("send").length !== opaque.send || requests("steer").length !== opaque.steer) throw new Error("active opaque command reached send or steer");
      await page.locator(".command-receipt-text", { hasText: "this command sends a message; it waits until the turn ends" }).waitFor();
      if ((await field(page).inputValue()).trim() !== "/review") throw new Error("active opaque command lost its draft");
    });

    if (await page.getByRole("button", { name: "stop" }).count()) await page.getByRole("button", { name: "stop" }).click();
    for (let attempt = 0; attempt < 200 && fake.running; attempt++) await Bun.sleep(25);
    await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 });
    if (await page.getByLabel("remove busy-plan.png").count()) await page.getByLabel("remove busy-plan.png").click();
    await field(page).fill("");

    await check("an active turn offers only commands it can run", async () => {
      const wordDelay = process.env.FAKE_ZETA_WORD_MS;
      try {
        process.env.FAKE_ZETA_WORD_MS = "300";
        await submit(page, "hold this turn");
        await page.getByPlaceholder("steer the running turn").waitFor({ timeout: 10_000 });
        const listbox = page.getByRole("listbox", { name: "command suggestions" });
        // Zeta ee6a82d6 server/slash_commands.py:516-536 refuses skills and prompt macros while a turn runs; "/g" matches only the greet skill.
        await field(page).fill("/g");
        await page.waitForTimeout(300);
        if (await listbox.count() || await field(page).getAttribute("aria-expanded") !== "false") throw new Error("an active turn opened a menu whose every choice is refused");
        if (await field(page).inputValue() !== "/g") throw new Error("the refused-only menu changed the draft");
        await field(page).fill("/h");
        await listbox.waitFor({ timeout: 5_000 });
        const offered = await listbox.locator(".command-name").allInnerTexts();
        if (offered.join(",") !== "/help") throw new Error(`an active turn offered ${offered.join(",")}`);
        await field(page).press("Escape");
        await field(page).fill("");
        await page.getByRole("button", { name: "stop" }).click();
        for (let attempt = 0; attempt < 200 && fake.running; attempt++) await Bun.sleep(25);
        await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 });
        await field(page).fill("/g");
        await listbox.waitFor({ timeout: 5_000 }).catch(() => { throw new Error("an idle run no longer offers the greet skill"); });
        await field(page).press("Escape");
      } finally {
        if (wordDelay === undefined) delete process.env.FAKE_ZETA_WORD_MS; else process.env.FAKE_ZETA_WORD_MS = wordDelay;
        if (await page.getByRole("button", { name: "stop" }).count()) await page.getByRole("button", { name: "stop" }).click();
        for (let attempt = 0; attempt < 200 && fake.running; attempt++) await Bun.sleep(25);
        await field(page).fill("");
      }
    });

    await check("a stopped turn has a neutral shell while a failed turn keeps the danger rail", async () => {
      await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 });
      await submit(page, "fail this turn");
      await page.locator('[data-part="timeline"] [data-kind="error"]').last().waitFor({ timeout: 10_000 });
      for (let attempt = 0; attempt < 200 && fake.running; attempt++) await Bun.sleep(25);
      await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 });
      const stopped = await page.locator('[data-part="timeline"] [data-kind="stopped"]').count();
      await submit(page, "then stop this turn");
      await page.getByRole("button", { name: "stop" }).click({ timeout: 10_000 });
      for (let attempt = 0; attempt < 200 && await page.locator('[data-part="timeline"] [data-kind="stopped"]').count() === stopped; attempt++) await Bun.sleep(25);
      await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 });
      await page.screenshot({ path: join(shots, "stopped-and-failed-1440.png") });
      const shells = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--fulcrum-danger)";
        document.querySelector('[data-part="timeline"]')!.append(probe);
        const danger = getComputedStyle(probe).color;
        probe.remove();
        const shell = (kind: string) => { const row = [...document.querySelectorAll(`[data-part="timeline"] [data-kind="${kind}"]`)].at(-1); if (!row) return null; const style = getComputedStyle(row.parentElement!); return { top: style.borderTopColor, left: style.borderLeftColor, text: getComputedStyle(row).color }; };
        return { danger, stopped: shell("stopped"), error: shell("error") };
      });
      if (!shells.stopped || !shells.error) throw new Error(`missing rows: ${JSON.stringify(shells)}`);
      if (shells.error.left !== shells.danger) throw new Error(`a failed turn lost its danger rail: ${JSON.stringify(shells)}`);
      if ([shells.stopped.top, shells.stopped.left, shells.stopped.text].includes(shells.danger)) throw new Error(`a stopped turn uses the danger color: ${JSON.stringify(shells)}`);
    });

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
      await page.goto(`${origin}/?run=s-themes`);
      await waitReady(page);
      await page.getByText("approved", { exact: true }).waitFor({ timeout: 10_000 }).catch(async () => { throw new Error(`ordinary approval wording missing; body=${await page.locator("body").innerText()}`); });
      if (await page.getByText("always allowed for this session", { exact: true }).count()) throw new Error("ordinary approval used the session-wide wording");
      fake.setLive(true);
      await page.goto(`${origin}/?run=${ACTIVE}`);
      await waitReady(page);
      await page.getByRole("button", { name: "always allow", exact: true }).waitFor({ timeout: 15_000 });
      await submit(page, "/always approval-1");
      await page.getByText("approval · always allowed", { exact: false }).waitFor({ timeout: 10_000 });
      await page.waitForFunction(() => document.querySelector('[data-part="approval-actions"]') === null, undefined, { timeout: 10_000 }).catch(() => {});
      await page.getByText("always allowed for this session", { exact: true }).waitFor({ timeout: 5_000 }).catch(async () => { throw new Error(`always-allowed decided wording missing; approval=${await page.locator(".gamma-approval").evaluateAll((nodes) => nodes.map((node) => node.outerHTML).join(" | "))}`); });
      const decision = fake.decisions.at(-1);
      if (decision?.method !== "approve" || decision.scope !== "always_tool" || "always" in decision) throw new Error(`wrong decision: ${JSON.stringify(decision)}`);
    });

    await check("new opens an immediate draft run", async () => {
      const before = page.url();
      await submit(page, "/new");
      await page.waitForURL((url) => url.toString() !== before && url.searchParams.get("run")?.startsWith("draft:"), { timeout: 10_000 });
      await page.getByPlaceholder("message zeta").waitFor();
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
