import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { chromium } from "playwright";
import { startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.WEB_GATE_PORT ?? 4187);
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.WEB_SHOTS ?? join(process.env.HOME ?? ".", ".zeta/scratch/gamma/polish");
await mkdir(shots, { recursive: true });
// A private gamma host, so the gate never touches a running one.
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-gate-"));
const fake = await startFakeZeta({ origins: [origin] });
fake.setSettingsEnabled(true);
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin }, stdio: "ignore" });
const rows: Array<[string, string]> = [];
const check = async (name: string, run: () => Promise<void>) => { try { await run(); rows.push([name, "pass"]); } catch (error) { rows.push([name, `fail: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`]); } };
try {
  for (let i = 0; i < 300 && !(await fetch(origin).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const page = await context.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    page.on("console", (message) => { if (message.type() === "error" && !/WebSocket connection/.test(message.text())) throw new Error(message.text()); });
    await page.goto(origin);
    await page.locator('.dock [data-part="composer"]').waitFor();
    await check("single-run blank state has no session browser", async () => {
      if (await page.locator("button.session, [data-part=session-list], .session-list").count()) throw new Error("session browser is visible");
      if (await page.locator(".brand-name").textContent() !== "gamma") throw new Error("missing gamma branding");
      if (await page.title() !== "gamma") throw new Error("wrong blank title");
      await page.getByRole("textbox", { name: "message" }).focus();
    });
    await check("first send creates and remembers one run", async () => {
      const field = page.getByRole("textbox", { name: "message" });
      await field.fill("polish gate text"); await field.press("Enter");
      await page.waitForURL(/[?&]run=/); await page.locator('[data-part="timeline"] [data-kind="user"]', { hasText: "polish gate text" }).waitFor();
      if (!(await page.locator(".brand-name").textContent())?.includes("gamma")) throw new Error("brand changed");
      await page.reload(); await page.locator('[data-part="timeline"] [data-kind="user"]', { hasText: "polish gate text" }).waitFor();
    });
    await check("new run clears the current run", async () => {
      await page.getByRole("button", { name: "new run" }).click();
      await page.locator(".empty-run").waitFor();
      if (new URL(page.url()).searchParams.has("run")) throw new Error("run remains in url");
    });
    await check("composer attaches, removes, and sends images", async () => {
      const composer = page.locator('.dock [data-part="composer"]');
      const file = { name: "button.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex") };
      await composer.locator('input[type=file]').setInputFiles(file);
      await page.getByRole("button", { name: "remove button.png" }).waitFor();
      await page.getByRole("button", { name: "remove button.png" }).click();
      const pasted = await page.evaluate(() => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array([137,80,78,71])], "paste.png", { type: "image/png" })); document.querySelector('[data-part="composer"]')!.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer })); return true; });
      if (!pasted) throw new Error("paste did not dispatch");
      await page.getByRole("button", { name: "remove paste.png" }).waitFor();
      await page.getByRole("textbox", { name: "message" }).fill("image turn");
      await page.getByRole("button", { name: "send message" }).click();
      await page.locator('[data-part="timeline"] [data-kind="user"]', { hasText: "image turn" }).waitFor();
    });
    await check("vim insert, normal delete/change/undo, and normal enter", async () => {
      await page.getByRole("button", { name: "new run" }).click();
      const field = page.getByRole("textbox", { name: "message" });
      await field.click(); await page.keyboard.type("one two"); await field.press("Escape"); await field.press("d"); await field.press("d");
      if (await field.inputValue() !== "") throw new Error("dd did not delete line");
      await field.press("i"); await page.keyboard.type("hello world"); await field.press("Escape"); await field.press("c"); await field.press("w"); await page.keyboard.type("there"); await field.press("Escape"); await field.press("u");
      if (await field.inputValue() !== "hello world") throw new Error("u did not undo cw");
      await field.press("Enter"); await page.waitForURL(/[?&]run=/); await page.locator('[data-part="timeline"] [data-kind="user"]', { hasText: "hello world" }).waitFor();
    });
    await check("vim toggle off restores plain composer", async () => {
      await page.getByRole("button", { name: "settings" }).click();
      await page.getByRole("button", { name: /vim keys/ }).click();
      const field = page.getByRole("textbox", { name: "message" }); await field.fill("plain"); await field.press("Escape");
      if (await page.locator(".vim-mode").count()) throw new Error("vim indicator remains enabled");
    });
    await check("status line and approval focus are present", async () => {
      await page.goto(`${origin}/?run=s-reconnect`);
      await page.locator(".status-line").waitFor();
      const text = await page.locator(".status-line").textContent();
      if (!text?.match(/ready|thinking|running|waiting|reconnecting|error|connecting/)) throw new Error(`unknown status: ${text}`);
      if ((await page.locator("body").textContent())?.toLowerCase().includes("fulcrum")) throw new Error("fulcrum is visible in ui");
    });
    for (const [width, label] of [[1440, "1440"], [390, "390"]] as const) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["tokyo-night", "catppuccin-latte"]) {
        await page.evaluate((value) => { document.documentElement.dataset.fulcrumTheme = value; }, theme);
        await page.screenshot({ path: join(shots, `polish-${label}-${theme}.png`), fullPage: true });
      }
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error(`${width}px horizontal overflow`);
    }
  } finally { await browser.close(); }
} finally { vite.kill("SIGTERM"); await fake.close(); }
for (const [name, result] of rows) console.log(`${result === "pass" ? "ok  " : "FAIL"} ${name}${result === "pass" ? "" : `: ${result}`}`);
process.exit(rows.some(([, result]) => result !== "pass") || rows.length === 0 ? 1 : 0);
