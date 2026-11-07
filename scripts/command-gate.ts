import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium, type Page } from "playwright";
import { themes } from "@fulcrum/react";
import { ACTIVE, startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.COMMAND_GATE_PORT ?? 4187);
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.WEB_SHOTS ?? join(root, "gate-artifacts", "commands");
await mkdir(shots, { recursive: true });
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-command-gate-"));
const fake = await startFakeZeta({ origins: [origin], live: false });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) }, stdio: ["ignore", "pipe", "pipe"] });
const failures: string[] = [];
const errors: string[] = [];
const check = async (name: string, run: () => Promise<void>) => {
  try { await run(); console.log(`ok   ${name}`); }
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

    await check("fresh draft prepares slash before any send", async () => {
      const start = fake.requests.length;
      await submit(page, "/status");
      await page.getByText("fake status", { exact: false }).waitFor();
      const methods = fake.requests.slice(start).map((request) => request.method);
      if (methods.indexOf("new_session") < 0 || methods.indexOf("slash_run") < methods.indexOf("new_session")) throw new Error(`wrong order: ${methods.join(",")}`);
      if (methods.includes("send") || methods.includes("send_images")) throw new Error(`command reached delivery: ${methods.join(",")}`);
      if (await field(page).inputValue()) throw new Error("successful output command kept its draft");
    });
    await page.waitForTimeout(500);
    await waitReady(page);

    await check("attached slash keeps its attachment and explains it", async () => {
      const image = join(gammaHome, "one.png");
      await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
      await page.locator('input[type="file"]').setInputFiles(image);
      await page.locator('[data-part="attachment"]').waitFor({ timeout: 5_000 }).catch(() => { throw new Error("attachment did not render"); });
      const start = fake.requests.length;
      await submit(page, "/status");
      await page.getByText("attachments were not sent", { exact: false }).waitFor({ timeout: 5_000 }).catch(() => { throw new Error(`attachment receipt missing; requests: ${fake.requests.slice(start).map((request) => request.method).join(",")}`); });
      if (fake.requests.slice(start).some((request) => request.method === "send_images")) throw new Error("slash command called send_images");
      if (await page.locator('[data-part="attachment"]').count() !== 1) throw new Error("slash command cleared its attachment");
      await page.getByLabel("remove one.png").click();
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
      await field(page).evaluate((node) => node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
      await field(page).dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
      if (await field(page).inputValue() !== "/st") throw new Error("ime enter accepted a completion");
      await field(page).evaluate((node) => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
      await field(page).press("Escape");
    });

    await check("receipt and listbox fit every theme and narrow widths", async () => {
      await field(page).fill("/"); await page.getByRole("listbox", { name: "command suggestions" }).waitFor();
      for (const theme of themes) {
        await page.evaluate((name) => { document.documentElement.dataset.fulcrumTheme = name; }, theme);
        await page.screenshot({ path: join(shots, `${theme}-1440.png`) });
      }
      for (const width of [1024, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({ path: join(shots, `tokyo-night-${width}.png`) });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        if (overflow) throw new Error(`${width}px view scrolls sideways`);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await check("opaque model input sends once without exposing its id", async () => {
      const start = fake.requests.length;
      await submit(page, "/review");
      for (let attempt = 0; attempt < 100 && !fake.requests.slice(start).some((request) => request.method === "send"); attempt++) await Bun.sleep(50);
      const calls = fake.requests.slice(start);
      const sends = calls.filter((request) => request.method === "send");
      if (calls.filter((request) => request.method === "slash_run").length !== 1 || sends.length !== 1) throw new Error(`expected one prepare and one send, got ${calls.map((call) => call.method)}`);
      if (sends[0]?.params.input_id !== "opaque-review-input" || "text" in (sends[0]?.params ?? {})) throw new Error("opaque send used the wrong shape");
      if (fake.sent.at(-1)?.text !== "$review") throw new Error("opaque send did not keep its display text for the user row");
      if ((await page.locator("body").innerText()).includes("opaque-review-input")) throw new Error("opaque id reached visible text");
      await page.getByRole("button", { name: "stop" }).waitFor({ timeout: 15_000 });
    });

    if (await page.getByRole("button", { name: "stop" }).count()) await page.getByRole("button", { name: "stop" }).click();
    await field(page).waitFor();
    await check("active turn blocks slash_run and retains the slash draft", async () => {
      await page.getByPlaceholder("message zeta").waitFor({ timeout: 10_000 }).catch(async () => { throw new Error(`composer did not become idle; text: ${await page.locator("body").innerText()}`); });
      await submit(page, "start a turn");
      await page.getByPlaceholder("steer the running turn").waitFor({ timeout: 10_000 }).catch(() => { throw new Error(`turn did not start; requests: ${fake.requests.slice(-8).map((request) => request.method).join(",")}`); });
      await page.waitForTimeout(300);
      await page.getByPlaceholder("steer the running turn").waitFor({ timeout: 10_000 });
      const before = requests("slash_run").length;
      await submit(page, "/status");
      await page.getByText("commands are unavailable while a turn is active", { exact: true }).waitFor({ timeout: 5_000 }).catch(async () => { throw new Error(`active command receipt missing; value=${JSON.stringify(await field(page).inputValue())}; requests=${fake.requests.slice(-8).map((request) => request.method).join(",")}; body=${await page.locator("body").innerText()}`); });
      if (requests("slash_run").length !== before) throw new Error("active turn called slash_run");
      if ((await field(page).inputValue()).trim() !== "/status") throw new Error("active turn lost the slash draft");
    });

    if (await page.getByRole("button", { name: "stop" }).count()) await page.getByRole("button", { name: "stop" }).click();
    await page.waitForTimeout(100);
    await check("unknown command is a dismissible error receipt", async () => {
      await submit(page, "/does-not-exist");
      await page.getByText("unknown command: /does-not-exist", { exact: true }).waitFor();
      await page.getByRole("button", { name: "dismiss command result" }).click();
      if (await page.getByText("unknown command: /does-not-exist", { exact: true }).count()) throw new Error("receipt did not dismiss");
    });

    await check("approve always reaches zeta with persistence", async () => {
      fake.setLive(true);
      await page.goto(`${origin}/?run=${ACTIVE}`);
      await page.getByRole("button", { name: "approve always" }).waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: "approve always" }).click();
      await page.waitForFunction(() => document.querySelector('[data-part="approval-actions"]') === null, undefined, { timeout: 10_000 }).catch(() => {});
      const decision = fake.decisions.at(-1);
      if (decision?.method !== "approve" || decision.always !== true) throw new Error(`wrong decision: ${JSON.stringify(decision)}`);
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
