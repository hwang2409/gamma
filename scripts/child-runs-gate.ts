import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import { CHILD_HOLD, startFakeZeta } from "./fake-zeta";

const source = new URL("..", import.meta.url).pathname;
const port = Number(process.env.CHILD_RUNS_GATE_PORT ?? 4215);
if (!Number.isInteger(port) || port < 1 || port > 65_535 || port === 5190 || port === 8765) throw new Error("CHILD_RUNS_GATE_PORT is outside the allowed disposable range");
const origin = `http://127.0.0.1:${port}`;
const screenshots = process.env.CHILD_RUNS_SCREENSHOT_DIR;
const childRequests = (fake: Awaited<ReturnType<typeof startFakeZeta>>, method: string) => fake.requests.filter((request) => request.method === method);

async function waitForApp(page: Page) {
  await page.getByRole("button", { name: /^children / }).waitFor({ timeout: 15_000 }).catch(async () => {
    throw new Error(`expected negotiated child catalog button; body=${(await page.locator("body").innerText()).slice(0, 2500)}`);
  });
}

async function run(name: "chromium" | "webkit", engine: BrowserType) {
  const fake = await startFakeZeta({ origins: [origin], live: false });
  const home = await mkdtemp(join(tmpdir(), `gamma-child-runs-${name}-`));
  const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: source,
    env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: home, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log: string[] = [];
  vite.stdout?.on("data", (value) => log.push(String(value)));
  vite.stderr?.on("data", (value) => log.push(String(value)));
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (vite.exitCode !== null) throw new Error(`${name}: vite exited ${vite.exitCode}: ${log.join("")}`);
      if (await fetch(origin).then((response) => response.ok, () => false)) break;
      if (attempt === 199) throw new Error(`${name}: vite did not start: ${log.join("")}`);
      await Bun.sleep(100);
    }
    const browser = await engine.launch();
    try {
      const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await desktop.newPage();
      await page.goto(`${origin}/?run=${encodeURIComponent(CHILD_HOLD)}`);
      await waitForApp(page);
      if (screenshots) await page.screenshot({ path: join(screenshots, `${name}-before.png`), fullPage: true });
      if (childRequests(fake, "child_run_send").length !== 0) throw new Error(`${name}: opening the owner sent a child follow-up`);

      const children = page.getByRole("button", { name: /^children / });
      await children.click();
      const drawer = page.getByRole("dialog", { name: "children" });
      await drawer.waitFor();
      const bounds = await drawer.boundingBox();
      if (!bounds || bounds.width < 400 || bounds.width > 450) throw new Error(`${name}: desktop drawer width was ${bounds?.width}`);
      const childRow = drawer.getByRole("button", { name: /reviewer/ });
      await childRow.click();
      await page.waitForURL((url) => url.searchParams.get("child") === "root:2");
      await page.getByText("saved child transcript is available").waitFor();
      await page.getByText("check the reconnect evidence").waitFor();
      await page.getByText("saved transcript", { exact: true }).waitFor();
      const history = childRequests(fake, "child_run_history");
      if (history.length !== 2 || history[0]?.params.before !== null || history[1]?.params.before !== 1) throw new Error(`${name}: saved history did not page newest then older: ${JSON.stringify(history)}`);
      if (await page.locator(".dock").count()) throw new Error(`${name}: owner dock remained in the child view`);
      if (childRequests(fake, "child_run_send").length !== 0) throw new Error(`${name}: route/history load sent a child follow-up`);

      const field = page.getByRole("textbox", { name: "child follow-up" });
      await field.fill("first follow-up");
      await field.press("Shift+Enter");
      if (childRequests(fake, "child_run_send").length !== 0) throw new Error(`${name}: Shift+Enter sent a child follow-up`);
      await field.press("Enter");
      await page.getByText("accepted", { exact: true }).waitFor();
      if (childRequests(fake, "child_run_send").length !== 1) throw new Error(`${name}: Enter did not send exactly once`);
      await field.fill("second follow-up");
      await page.getByRole("button", { name: "send", exact: true }).click();
      await page.waitForFunction(() => (document.querySelector('[aria-label="child follow-up"]') as HTMLTextAreaElement | null)?.value === "");
      if (childRequests(fake, "child_run_send").length !== 2) throw new Error(`${name}: click did not send exactly once`);
      if (childRequests(fake, "child_run_list").length < 3) throw new Error(`${name}: accepted sends did not create later catalog refreshes`);
      if (screenshots) await page.screenshot({ path: join(screenshots, `${name}-after.png`), fullPage: true });

      await page.getByRole("button", { name: "back to parent run" }).click();
      await page.waitForURL((url) => !url.searchParams.has("child"));
      await page.waitForFunction(() => document.activeElement?.classList.contains("children-button"), undefined, { timeout: 2_000 }).catch(async () => { throw new Error(`${name}: catalog opener focus was ${await page.evaluate(() => document.activeElement?.outerHTML)}`); });
      const subagent = page.locator('[data-part="sub-agent"]', { hasText: "reviewer" });
      await subagent.click();
      await page.waitForURL((url) => url.searchParams.get("child") === "root:2");
      await page.getByRole("button", { name: "back to parent run" }).click();
      await page.waitForURL((url) => !url.searchParams.has("child"));
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-part") === "sub-agent", undefined, { timeout: 2_000 }).catch(async () => { throw new Error(`${name}: contextual opener focus was ${await page.evaluate(() => document.activeElement?.outerHTML)}`); });
      await desktop.close();

      const direct = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const directPage = await direct.newPage();
      await directPage.goto(`${origin}/?run=${encodeURIComponent(CHILD_HOLD)}&child=${encodeURIComponent("root:2")}`);
      await directPage.getByText("saved child transcript is available").waitFor({ timeout: 15_000 });
      await directPage.getByRole("button", { name: "back to parent run" }).click();
      await directPage.waitForURL((url) => !url.searchParams.has("child"));
      if (await directPage.getByText("saved transcript", { exact: true }).count()) throw new Error(`${name}: direct-link back did not replace the child route`);
      await direct.close();

      const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const mobilePage = await mobile.newPage();
      await mobilePage.goto(`${origin}/?run=${encodeURIComponent(CHILD_HOLD)}`);
      await waitForApp(mobilePage);
      const mobileButton = mobilePage.getByRole("button", { name: /^children / });
      await mobileButton.click();
      const sheet = mobilePage.getByRole("dialog", { name: "children" });
      const sheetBounds = await sheet.boundingBox();
      if (!sheetBounds || Math.abs(sheetBounds.x) > 0.5 || Math.abs(sheetBounds.width - 390) > 0.5) throw new Error(`${name}: mobile catalog was not a full-width sheet: ${JSON.stringify(sheetBounds)}`);
      const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) throw new Error(`${name}: mobile page overflowed by ${overflow}px`);
      await mobilePage.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });
      await mobilePage.waitForFunction(() => document.activeElement?.classList.contains("children-button"));
      await mobile.close();
    } finally {
      await browser.close();
    }
  } finally {
    vite.kill("SIGTERM");
    await Promise.race([new Promise<void>((resolve) => vite.once("exit", () => resolve())), Bun.sleep(2_000)]);
    await fake.close();
    await rm(home, { recursive: true, force: true });
  }
}

if (screenshots) await mkdir(screenshots, { recursive: true });
await run("chromium", chromium);
await run("webkit", webkit);
console.log("child runs gate: chromium and webkit passed at 1440px and 390px");
