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
  await page.getByRole("button", { name: /^children(?: |$)/ }).waitFor({ timeout: 15_000 }).catch(async () => {
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
      fake.setChildCatalogRows(101);
      const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await desktop.newPage();
      await page.goto(`${origin}/?run=${encodeURIComponent(CHILD_HOLD)}`);
      await waitForApp(page);
      if (screenshots) await page.screenshot({ path: join(screenshots, `${name}-before.png`), fullPage: true });
      if (childRequests(fake, "child_run_send").length !== 0) throw new Error(`${name}: opening the owner sent a child follow-up`);

      const children = page.getByRole("button", { name: /^children(?: |$)/ });
      if (await children.innerText() !== "children") throw new Error(`${name}: unopened catalog exposed a count`);
      await children.click();
      const drawer = page.getByRole("dialog", { name: "children" });
      await drawer.waitFor();
      const bounds = await drawer.boundingBox();
      if (!bounds || bounds.width < 400 || bounds.width > 450) throw new Error(`${name}: desktop drawer width was ${bounds?.width}`);
      await drawer.getByRole("button", { name: "load more" }).click();
      await drawer.getByRole("button", { name: /worker 100/ }).waitFor();
      const childRow = drawer.getByRole("button", { name: /reviewer/ });
      await childRow.click();
      await page.waitForURL((url) => url.searchParams.get("child") === "root:2");
      await page.getByText("saved child transcript is available").waitFor();
      await page.getByText("check the reconnect evidence").waitFor();
      await page.getByText("saved transcript", { exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.classList.contains("child-identity"));
      const history = childRequests(fake, "child_run_history");
      if (history.length !== 2 || history[0]?.params.before !== null || history[1]?.params.before !== 1) throw new Error(`${name}: saved history did not page newest then older: ${JSON.stringify(history)}`);
      if (await page.locator(".dock").count()) throw new Error(`${name}: owner dock remained in the child view`);
      if (childRequests(fake, "child_run_send").length !== 0) throw new Error(`${name}: route/history load sent a child follow-up`);

      const field = page.getByRole("textbox", { name: "child follow-up" });
      await field.fill("first follow-up");
      await field.press("Shift+Enter");
      if (childRequests(fake, "child_run_send").length !== 0) throw new Error(`${name}: Shift+Enter sent a child follow-up`);
      await field.press("Enter");
      await page.waitForFunction(() => (document.querySelector('[aria-label="child follow-up"]') as HTMLTextAreaElement | null)?.value === "");
      if (childRequests(fake, "child_run_send").length !== 1) throw new Error(`${name}: Enter did not send exactly once`);
      if (await page.getByText("accepted", { exact: true }).count()) throw new Error(`${name}: child view left a bare accepted receipt`);
      if ((await page.locator(".child-identity").innerText()).toLowerCase().includes("reviewer reviewer")) throw new Error(`${name}: child identity repeated its agent type`);
      await field.fill("second follow-up");
      if (screenshots) await page.screenshot({ path: join(screenshots, `${name}-after.png`), fullPage: true });
      await page.getByRole("button", { name: "send", exact: true }).click();
      await page.waitForFunction(() => (document.querySelector('[aria-label="child follow-up"]') as HTMLTextAreaElement | null)?.value === "");
      if (childRequests(fake, "child_run_send").length !== 2) throw new Error(`${name}: click did not send exactly once`);
      if (childRequests(fake, "child_run_list").length < 3) throw new Error(`${name}: accepted sends did not create later catalog refreshes`);

      await field.focus();
      await page.keyboard.press("Escape");
      await page.waitForURL((url) => !url.searchParams.has("child"));
      await page.waitForFunction(() => document.activeElement?.classList.contains("children-button"), undefined, { timeout: 2_000 }).catch(async () => { throw new Error(`${name}: catalog opener focus was ${await page.evaluate(() => document.activeElement?.outerHTML)}`); });
      const subagent = page.locator('[data-part="sub-agent"]', { hasText: "reviewer" });
      await subagent.click();
      await page.waitForURL((url) => url.searchParams.get("child") === "root:2");
      await page.getByRole("button", { name: "back to parent run" }).click();
      await page.waitForURL((url) => !url.searchParams.has("child"));
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-part") === "sub-agent" || document.activeElement?.classList.contains("children-button"), undefined, { timeout: 2_000 }).catch(async () => { throw new Error(`${name}: contextual fallback focus was ${await page.evaluate(() => document.activeElement?.outerHTML)}`); });
      await subagent.focus();
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => url.searchParams.get("child") === "root:2");
      await page.getByRole("button", { name: "back to parent run" }).click();
      await page.waitForURL((url) => !url.searchParams.has("child"));
      await desktop.close();

      const direct = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const directPage = await direct.newPage();
      await directPage.goto(`${origin}/?run=${encodeURIComponent(CHILD_HOLD)}&child=${encodeURIComponent("root:2")}`);
      await directPage.getByText("saved child transcript is available").waitFor({ timeout: 15_000 });
      await directPage.getByRole("button", { name: "back to parent run" }).click();
      await directPage.waitForURL((url) => !url.searchParams.has("child"));
      if (await directPage.getByText("saved transcript", { exact: true }).count()) throw new Error(`${name}: direct-link back did not replace the child route`);
      await direct.close();

      const draftProof = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const draftPage = await draftProof.newPage();
      await draftPage.goto(`${origin}/?run=${encodeURIComponent(CHILD_HOLD)}&child=${encodeURIComponent("root:2")}`);
      const draftField = draftPage.getByRole("textbox", { name: "child follow-up" });
      await draftField.waitFor({ timeout: 15_000 });
      const sendsBeforeDraftProof = childRequests(fake, "child_run_send").length;
      await draftField.fill("draft stays with this child");
      await draftPage.reload();
      await draftPage.getByRole("textbox", { name: "child follow-up" }).waitFor({ timeout: 15_000 });
      if (await draftPage.getByRole("textbox", { name: "child follow-up" }).inputValue() !== "draft stays with this child") throw new Error(`${name}: reload lost the child draft`);
      if (childRequests(fake, "child_run_send").length !== sendsBeforeDraftProof) throw new Error(`${name}: reload sent the child draft`);

      await draftPage.goto(`${origin}/?run=${encodeURIComponent(CHILD_HOLD)}&child=${encodeURIComponent("root:extra:1")}`);
      const otherChildField = draftPage.getByRole("textbox", { name: "child follow-up" });
      await otherChildField.waitFor({ timeout: 15_000 });
      if (await otherChildField.inputValue()) throw new Error(`${name}: another child restored the first child's draft`);
      await draftPage.goBack();
      await draftPage.getByRole("textbox", { name: "child follow-up" }).waitFor({ timeout: 15_000 });
      if (await draftPage.getByRole("textbox", { name: "child follow-up" }).inputValue() !== "draft stays with this child") throw new Error(`${name}: returning from another child lost the pair draft`);

      await draftPage.goto(`${origin}/?run=${encodeURIComponent("s-themes")}`);
      await draftPage.waitForURL((url) => url.searchParams.get("run") === "s-themes" && !url.searchParams.has("child"));
      await draftPage.locator(".run-title h1").waitFor({ timeout: 15_000 });
      await draftPage.goBack();
      await draftPage.getByRole("textbox", { name: "child follow-up" }).waitFor({ timeout: 15_000 });
      if (await draftPage.getByRole("textbox", { name: "child follow-up" }).inputValue() !== "draft stays with this child") throw new Error(`${name}: run switch lost the pair draft`);
      if (childRequests(fake, "child_run_send").length !== sendsBeforeDraftProof) throw new Error(`${name}: run switch sent the child draft`);

      const historiesBeforeReconnect = childRequests(fake, "child_run_history").length;
      fake.drop();
      for (let attempt = 0; childRequests(fake, "child_run_history").length === historiesBeforeReconnect && attempt < 150; attempt++) await Bun.sleep(100);
      if (childRequests(fake, "child_run_history").length === historiesBeforeReconnect) throw new Error(`${name}: reconnect did not reopen child history`);
      await draftPage.getByRole("textbox", { name: "child follow-up" }).waitFor({ timeout: 15_000 });
      if (await draftPage.getByRole("textbox", { name: "child follow-up" }).inputValue() !== "draft stays with this child") throw new Error(`${name}: reconnect lost the pair draft`);
      if (childRequests(fake, "child_run_send").length !== sendsBeforeDraftProof) throw new Error(`${name}: reconnect sent the child draft`);
      await draftProof.close();

      fake.setChildRunHistoryEnabled(false);
      const listBeforeNoHistory = childRequests(fake, "child_run_list").length;
      const historyBeforeNoHistory = childRequests(fake, "child_run_history").length;
      const noHistory = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const noHistoryPage = await noHistory.newPage();
      await noHistoryPage.goto(`${origin}/?run=${encodeURIComponent(CHILD_HOLD)}&child=${encodeURIComponent("root:2")}`);
      await noHistoryPage.getByText("transcript view needs a newer zeta server").waitFor({ timeout: 15_000 });
      await noHistoryPage.getByRole("heading", { name: /reviewer/ }).waitFor();
      if (childRequests(fake, "child_run_list").length <= listBeforeNoHistory) throw new Error(`${name}: history-unavailable deep link did not load child metadata`);
      if (childRequests(fake, "child_run_history").length !== historyBeforeNoHistory) throw new Error(`${name}: history-unavailable deep link requested child history`);
      await noHistory.close();
      fake.setChildRunHistoryEnabled(true);

      fake.staleChildHistoryFor(5);
      const stale = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const stalePage = await stale.newPage();
      await stalePage.goto(`${origin}/?run=${encodeURIComponent(CHILD_HOLD)}&child=${encodeURIComponent("root:2")}`);
      await stalePage.getByText("history kept changing", { exact: true }).waitFor({ timeout: 15_000 });
      await stalePage.getByRole("button", { name: "try again" }).waitFor();
      await stale.close();
      fake.staleChildHistoryFor(0);

      const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const mobilePage = await mobile.newPage();
      await mobilePage.goto(`${origin}/?run=${encodeURIComponent(CHILD_HOLD)}`);
      await waitForApp(mobilePage);
      if (screenshots) await mobilePage.screenshot({ path: join(screenshots, `${name}-mobile-before.png`), fullPage: true });
      const mobileButton = mobilePage.getByRole("button", { name: /^children(?: |$)/ });
      const mobileButtonSize = await mobileButton.evaluate((button) => ({ client: button.clientWidth, scroll: button.scrollWidth, text: button.textContent }));
      if (mobileButtonSize.text !== "children" || mobileButtonSize.scroll > mobileButtonSize.client) throw new Error(`${name}: mobile children control was clipped: ${JSON.stringify(mobileButtonSize)}`);
      const mobileTitle = await mobilePage.locator(".run-title h1").evaluate((title) => ({ client: title.clientWidth, text: title.textContent }));
      if (!mobileTitle.text?.includes("child hold notification") || mobileTitle.client < 160) throw new Error(`${name}: mobile run title did not keep a readable row: ${JSON.stringify(mobileTitle)}`);
      await mobileButton.click();
      const sheet = mobilePage.getByRole("dialog", { name: "children" });
      const sheetBounds = await sheet.boundingBox();
      if (!sheetBounds || Math.abs(sheetBounds.x) > 0.5 || Math.abs(sheetBounds.width - 390) > 0.5) throw new Error(`${name}: mobile catalog was not a full-width sheet: ${JSON.stringify(sheetBounds)}`);
      const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) throw new Error(`${name}: mobile page overflowed by ${overflow}px`);
      await mobilePage.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });
      await mobilePage.waitForFunction(() => document.activeElement?.classList.contains("children-button"));
      await mobileButton.click();
      await sheet.waitFor();
      await sheet.getByRole("button", { name: /reviewer/ }).click();
      await mobilePage.waitForURL((url) => url.searchParams.get("child") === "root:2");
      await mobilePage.getByText("saved child transcript is available").waitFor();
      const identityBounds = await mobilePage.locator(".child-identity").boundingBox();
      const statusBounds = await mobilePage.locator(".child-meta").boundingBox();
      if (!identityBounds || !statusBounds || Math.abs(identityBounds.x - statusBounds.x) > 0.5) throw new Error(`${name}: mobile status did not start under the child title`);
      if (screenshots) await mobilePage.screenshot({ path: join(screenshots, `${name}-mobile-after.png`), fullPage: true });
      await mobilePage.getByRole("button", { name: "back to parent run" }).click();
      await mobilePage.waitForURL((url) => !url.searchParams.has("child"));
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
