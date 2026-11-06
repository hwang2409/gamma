// Polish gate for gamma's single run against the fake zeta (scripts/fake-zeta.ts). It checks the blank run, the first
// send, new run, image attach (thumbnails that really load), vim keys, the one-home rule for problems (a failed turn
// shows once, on its transcript row, and the composer is not left "sending"), then takes the real states at 1440 and
// 390 px in a dark and a light theme: empty run with the composer focused, two attached images, vim NORMAL, the
// settings popover, an approval wait in Ask mode, and a streamed reply with a tool card.
// Screenshots go to $WEB_SHOTS (default ~/.zeta/scratch/gamma/polish), named ux-<state>-<width>-<theme>.png.
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { ACTIVE, startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.WEB_GATE_PORT ?? 4187);
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.WEB_SHOTS ?? join(process.env.HOME ?? ".", ".zeta/scratch/gamma/polish");
const THEMES = ["tokyo-night", "catppuccin-latte"] as const;
await mkdir(shots, { recursive: true });
// A private gamma host, so the gate never touches a running one.
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-gate-"));
// No live turn until the approval states ask for one: a turn running elsewhere makes zeta refuse to open other runs.
const fake = await startFakeZeta({ origins: [origin], live: false });
fake.setSettingsEnabled(true);
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin }, stdio: "ignore" });
const rows: Array<[string, string]> = [];
const check = async (name: string, run: () => Promise<void>) => { try { await run(); rows.push([name, "pass"]); } catch (error) { rows.push([name, `fail: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`]); } };
const ready = (page: Page) => page.locator('.dock form[data-part="composer"]').waitFor({ timeout: 10_000 });
const settle = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const field = (page: Page) => page.getByRole("textbox", { name: "message" });
const userRow = (page: Page, text: string) => page.locator('[data-part="timeline"] [data-kind="user"]', { hasText: text });
/** A real png: a colored disc on white, so a thumbnail that loads is visible. */
async function png(browser: Browser, color: string) {
  const maker = await browser.newPage({ viewport: { width: 160, height: 160 } });
  await maker.setContent(`<body style="margin:0;background:#fff"><div style="margin:20px;width:120px;height:120px;border-radius:50%;background:${color}"></div></body>`);
  const buffer = await maker.screenshot();
  await maker.close();
  return buffer;
}
/** The loaded state of each queued thumbnail: a broken image has no natural width. */
const thumbnails = (page: Page) => page.locator('.dock [data-part="attachment"] img').evaluateAll((images) => images.map((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0));
async function both(page: Page, state: string, width: number) {
  for (const theme of THEMES) {
    await page.evaluate((value) => { document.documentElement.dataset.fulcrumTheme = value; }, theme);
    await settle(page);
    await page.screenshot({ path: join(shots, `ux-${state}-${width}-${theme}.png`) });
  }
}

try {
  for (let i = 0; i < 300 && !(await fetch(origin).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
  const browser = await chromium.launch();
  try {
    const red = await png(browser, "#d11");
    const blue = await png(browser, "#15d");
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("dialog", (dialog) => void dialog.accept());
    page.on("console", (message) => { if (message.type() === "error" && !/WebSocket connection/.test(message.text())) errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await ready(page);
    await check("single-run blank state: gamma branding, no session browser, no busy or error panel", async () => {
      if (await page.locator("button.session, [data-part=session-list], .session-list").count()) throw new Error("session browser is visible");
      if (await page.locator(".brand-name").textContent() !== "gamma") throw new Error("missing gamma branding");
      if (await page.title() !== "gamma") throw new Error("wrong blank title");
      if (await page.locator(".panel, [role=alert]").count()) throw new Error(`startup shows "${await page.locator(".panel, [role=alert]").first().textContent()}"`);
      if ((await page.locator("body").textContent())?.toLowerCase().includes("fulcrum")) throw new Error("fulcrum is visible in ui");
    });
    await check("the blank run's footer has the model picker and Ask, and YOLO picked there reaches the new run", async () => {
      const footer = page.locator('.dock [data-part="composer"] .composer-tools');
      const model = footer.getByRole("button", { name: /^model: / });
      await model.waitFor({ timeout: 5000 });
      await model.click();
      await footer.getByRole("option", { name: "claude-sonnet-5" }).click();
      if (await model.getAttribute("aria-label") !== "model: claude-sonnet-5") throw new Error("catalog model was not picked on the blank run");
      await footer.getByRole("button", { name: /^approval mode: Ask/ }).click();
      await page.getByRole("button", { name: "allow" }).click();
      await page.locator(".topbar-yolo", { hasText: "YOLO" }).waitFor();
      await field(page).fill("polish gate text");
      await field(page).press("Enter");
      await page.waitForURL(/[?&]run=/);
      await userRow(page, "polish gate text").waitFor();
      if (fake.settings.model !== "claude-sonnet-5" || fake.settings.approval_mode !== "allow") throw new Error(`the new run is ${fake.settings.model}/${fake.settings.approval_mode}`);
      await footer.locator(".approval-mode[data-yolo]").waitFor();
      await page.reload();
      await userRow(page, "polish gate text").waitFor();
      await page.locator(".topbar-yolo", { hasText: "YOLO" }).waitFor();
      // Back to Ask for the states below.
      await footer.getByRole("button", { name: /^approval mode: YOLO/ }).click();
      await footer.getByRole("button", { name: /^approval mode: Ask/ }).waitFor();
      if (fake.settings.approval_mode !== "ask") throw new Error("Ask did not reach zeta");
    });
    await check("new run clears the current run and its YOLO mark", async () => {
      await page.locator('.dock [data-part="composer"][data-state="idle"]').waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "new run" }).click();
      await page.locator(".empty-run").waitFor();
      if (new URL(page.url()).searchParams.has("run")) throw new Error("run remains in url");
      if (await page.locator(".topbar-yolo").count()) throw new Error("YOLO mark stayed on the blank run");
    });
    await check("composer attaches real images with loaded thumbnails, removes, pastes, and sends them", async () => {
      const composer = page.locator('.dock [data-part="composer"]');
      await composer.locator("input[type=file]").setInputFiles([{ name: "red.png", mimeType: "image/png", buffer: red }, { name: "blue.png", mimeType: "image/png", buffer: blue }]);
      await page.getByRole("button", { name: "remove blue.png" }).waitFor();
      const loaded = await thumbnails(page);
      if (loaded.length !== 2 || loaded.includes(false)) throw new Error(`thumbnails loaded: ${loaded.join(", ")}`);
      await page.getByRole("button", { name: "remove blue.png" }).click();
      await page.getByRole("button", { name: "remove red.png" }).click();
      await field(page).evaluate((node, bytes) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(bytes)], "paste.png", { type: "image/png" }));
        node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
      }, [...red]);
      await page.getByRole("button", { name: "remove paste.png" }).waitFor();
      if ((await thumbnails(page)).includes(false)) throw new Error("the pasted thumbnail did not load");
      await field(page).fill("image turn");
      await page.getByRole("button", { name: "send message" }).click();
      await userRow(page, "image turn").waitFor();
      const sent = fake.imageSends.at(-1) as { text?: string; images?: Array<{ name: string; data: string }> } | undefined;
      if (sent?.text !== "image turn" || sent.images?.[0]?.name !== "paste.png" || Buffer.from(sent.images[0].data, "base64").length !== red.length) throw new Error("send_images did not carry the pasted image");
    });
    await check("a failed turn shows once, on its transcript row with retry; the status line and composer stay calm", async () => {
      await page.locator('.dock [data-part="composer"][data-state="idle"]').waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "new run" }).click();
      await field(page).fill("fail this turn");
      await field(page).press("Enter");
      const failed = page.locator('[data-part="timeline"] [data-kind="error"]');
      await failed.waitFor({ timeout: 10_000 });
      await page.locator('.status-line[data-state="ready"]').waitFor({ timeout: 5000 });
      const composer = page.locator('.dock [data-part="composer"]');
      if (await composer.getAttribute("data-pending")) throw new Error("the composer is still sending after the error");
      if ((await composer.locator('[data-part="composer-message"]').textContent())?.trim()) throw new Error("the composer repeats the error");
      const seen = ((await page.locator("body").innerText()).match(/overloaded \(529\)/g) ?? []).length;
      if (seen !== 1) throw new Error(`the error shows ${seen} times`);
      await page.screenshot({ path: join(shots, "ux-turn-error-1440.png") });
      // The one action: retry sends the prompt again; only the newest error row offers it.
      await page.locator(".turn-retry").click();
      await failed.nth(1).waitFor({ timeout: 10_000 });
      if ((await page.locator(".turn-retry").count()) !== 1) throw new Error("more than one retry is offered");
      if (fake.sent.filter((entry) => entry.text === "fail this turn").length !== 2) throw new Error("retry did not send the prompt again");
    });
    await check("vim insert, normal delete/change/undo, and normal enter", async () => {
      await page.getByRole("button", { name: "new run" }).click();
      const input = field(page);
      await input.click(); await page.keyboard.type("one two"); await input.press("Escape"); await input.press("d"); await input.press("d");
      if (await input.inputValue() !== "") throw new Error("dd did not delete line");
      await input.press("i"); await page.keyboard.type("hello world"); await input.press("Escape"); await input.press("c"); await input.press("w"); await page.keyboard.type("there"); await input.press("Escape"); await input.press("u");
      if (await input.inputValue() !== "hello world") throw new Error("u did not undo cw");
      await input.press("Enter"); await page.waitForURL(/[?&]run=/); await userRow(page, "hello world").waitFor();
      // zeta opens another run only when no turn runs, so the states below wait for this one to end.
      await page.locator('.dock [data-part="composer"][data-state="idle"]').waitFor({ timeout: 15_000 });
    });
    await check("vim toggle off restores the plain composer, and on again", async () => {
      await page.getByRole("button", { name: "settings" }).click();
      await page.getByRole("button", { name: /vim keys/ }).click();
      await page.keyboard.press("Escape");
      await field(page).fill("plain"); await field(page).press("Escape");
      if (await page.locator(".vim-mode").count()) throw new Error("vim indicator remains enabled");
      await page.getByRole("button", { name: "settings" }).click();
      await page.getByRole("button", { name: /vim keys/ }).click();
      await page.keyboard.press("Escape");
      await page.locator(".vim-mode").waitFor();
      await field(page).fill("");
    });
    if (errors.length) rows.push(["desktop console", `fail: ${errors.join("; ")}`]);
    await context.close();

    // The real states, at each width, in a dark and a light theme.
    for (const width of [1440, 390]) {
      const states = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, ...(width === 390 ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
      const view = await states.newPage();
      view.on("dialog", (dialog) => void dialog.accept());
      await check(`${width}: empty new run with the composer focused`, async () => {
        await view.goto(origin);
        await ready(view);
        await view.locator(".empty-run").waitFor();
        if (!(await view.evaluate(() => document.activeElement?.tagName === "TEXTAREA"))) throw new Error("the composer is not focused");
        if (await view.locator(".panel, [role=alert]").count()) throw new Error("startup shows a panel");
        await both(view, "empty", width);
      });
      await check(`${width}: composer with two attached images`, async () => {
        await view.locator('.dock [data-part="composer"] input[type=file]').setInputFiles([{ name: "red.png", mimeType: "image/png", buffer: red }, { name: "blue.png", mimeType: "image/png", buffer: blue }]);
        await view.getByRole("button", { name: "remove blue.png" }).waitFor();
        await field(view).fill("what differs between these two?");
        const loaded = await thumbnails(view);
        if (loaded.length !== 2 || loaded.includes(false)) throw new Error(`thumbnails loaded: ${loaded.join(", ")}`);
        await both(view, "two-images", width);
        await view.getByRole("button", { name: "remove blue.png" }).click();
        await view.getByRole("button", { name: "remove red.png" }).click();
      });
      await check(`${width}: vim NORMAL mode`, async () => {
        await field(view).fill("fix the flaky reconnect test");
        await field(view).focus();
        await field(view).press("Escape");
        await view.locator('.vim-mode[data-mode="normal"]').waitFor();
        await both(view, "vim-normal", width);
        await field(view).press("i");
        await field(view).fill("");
      });
      await check(`${width}: settings popover open`, async () => {
        await view.getByRole("button", { name: "settings" }).click();
        await view.getByRole("dialog", { name: "settings" }).waitFor();
        await both(view, "settings", width);
        await view.keyboard.press("Escape");
      });
      await check(`${width}: an approval wait in Ask mode`, async () => {
        fake.setLive(false); fake.setLive(true); // a fresh live turn on the server's run
        await view.goto(`${origin}/?run=${ACTIVE}`);
        const approval = view.locator('[data-part="approval"][data-state="pending"]');
        await approval.waitFor({ timeout: 15_000 });
        await view.locator('.status-line[data-state="approval"]').waitFor({ timeout: 5000 });
        await view.locator(".dock .approval-mode:not([data-yolo])", { hasText: "Ask" }).waitFor();
        await approval.scrollIntoViewIfNeeded();
        // Stop and steer join the footer while the turn runs: every control still sits inside the composer.
        const outside = await view.locator('.dock [data-part="composer"]').evaluate((composer) => {
          const box = composer.getBoundingClientRect();
          return [...composer.querySelectorAll(".composer-tools > *")].filter((node) => { const own = node.getBoundingClientRect(); return own.width && (own.left < box.left || own.right > box.right); }).map((node) => node.textContent);
        });
        if (outside.length) throw new Error(`footer controls outside the composer: ${outside.join(", ")}`);
        await both(view, "approval", width);
      });
      await check(`${width}: a streamed reply with a tool card`, async () => {
        await view.locator('[data-part="approval"][data-state="pending"]').getByRole("button", { name: "approve" }).click();
        await view.getByText("20 of 20").waitFor({ timeout: 15_000 });
        await view.locator('.status-line[data-state="ready"]').waitFor({ timeout: 10_000 });
        if (!(await view.locator('[data-part="timeline"] [data-part="tool"]').count())) throw new Error("no tool card");
        await view.locator(".scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
        await both(view, "reply-tool", width);
        fake.setLive(false);
      });
      if (await view.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) rows.push([`${width} layout`, "fail: horizontal overflow"]);
      await states.close();
    }
  } finally { await browser.close(); }
} finally { vite.kill("SIGTERM"); await fake.close(); }
for (const [name, result] of rows) console.log(`${result === "pass" ? "ok  " : "FAIL"} ${name}${result === "pass" ? "" : `: ${result}`}`);
console.log(`screenshots: ${shots}`);
process.exit(rows.some(([, result]) => result !== "pass") || rows.length === 0 ? 1 : 0);
