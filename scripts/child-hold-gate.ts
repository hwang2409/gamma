import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import { CHILD_HOLD, startFakeZeta } from "./fake-zeta";

const source = process.env.GAMMA_PROOF_APP ?? new URL("..", import.meta.url).pathname;
const portText = process.env.CHILD_HOLD_GATE_PORT ?? "4214";
if (!/^\d+$/.test(portText)) throw new Error("CHILD_HOLD_GATE_PORT must be an integer");
const port = Number(portText);
if (port < 1 || port > 65_535 || port === 5190 || port === 8765) throw new Error("CHILD_HOLD_GATE_PORT is outside the allowed disposable range");
const origin = `http://127.0.0.1:${port}`;
const screenshotDir = process.env.CHILD_HOLD_SCREENSHOT_DIR;

const localLabel = (iso: string) => {
  const date = new Date(iso);
  const now = new Date();
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) return clock;
  const day = `${date.toLocaleString("en-US", { month: "short" })} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? `${day}, ${clock}` : `${day}, ${date.getFullYear()}, ${clock}`;
};

const historyIso = "2099-01-07T09:30:00.000Z";
const liveIso = "2099-01-08T10:45:00.000Z";
const expected = () => [
  `child worker waits until ${localLabel(historyIso)} · rate limit`,
  `child reviewer waits until ${localLabel(liveIso)} · subscription limit`,
];
const rows = (page: Page) => page.locator('[data-part="notification"][data-kind="child-hold"]');

async function inspect(page: Page, label: string) {
  await rows(page).nth(1).waitFor({ timeout: 15_000 }).catch(async () => {
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${label}-missing.png`), fullPage: true });
    throw new Error(`${label}: live and history child hold rows did not render; body=${(await page.locator("body").innerText()).slice(0, 3000)}`);
  });
  const visible = await rows(page).allTextContents().then((values) => values.map((value) => value.replace(/\s+/g, " ").trim()));
  if (JSON.stringify(visible) !== JSON.stringify(expected())) throw new Error(`${label}: child hold copy was ${JSON.stringify(visible)}, expected ${JSON.stringify(expected())}`);
  const dateTimes = await rows(page).locator("time").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("datetime")));
  if (JSON.stringify(dateTimes) !== JSON.stringify([historyIso, liveIso])) throw new Error(`${label}: child hold dateTime values were ${JSON.stringify(dateTimes)}`);
  for (const token of ["child_hold", "rate_limit", "subscription_limit", "codex:first", "codex:second", "2099-01-07T09:30:00+00:00", "2099-01-08T10:45:00+00:00"]) {
    if (visible.some((value) => value.includes(token))) throw new Error(`${label}: visible child hold copy leaked ${token}`);
  }
  const overflow = await rows(page).evaluateAll((nodes) => nodes.map((node) => ({ width: node.getBoundingClientRect().width, scroll: (node as HTMLElement).scrollWidth })).filter(({ width, scroll }) => scroll > width + 1));
  if (overflow.length) throw new Error(`${label}: child hold row overflowed: ${JSON.stringify(overflow)}`);
}

async function runEngine(name: "chromium" | "webkit", engine: BrowserType) {
  const fake = await startFakeZeta({ origins: [origin], port: 0, live: false });
  const gammaHome = await mkdtemp(join(tmpdir(), `gamma-child-hold-${name}-`));
  const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: source,
    env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port), TZ: "America/New_York" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const viteLog: string[] = [];
  vite.stdout?.on("data", (data) => viteLog.push(String(data)));
  vite.stderr?.on("data", (data) => viteLog.push(String(data)));
  try {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (vite.exitCode !== null) throw new Error(`${name}: vite exited ${vite.exitCode}: ${viteLog.join("").slice(-3000)}`);
      if (await fetch(origin).then((response) => response.ok, () => false)) break;
      if (attempt === 299) throw new Error(`${name}: vite did not start: ${viteLog.join("").slice(-3000)}`);
      await Bun.sleep(100);
    }
    const browser = await engine.launch();
    try {
      const primary = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", timezoneId: "America/New_York" });
      const page = await primary.newPage();
      await page.goto(`${origin}/?run=${CHILD_HOLD}&theme=github-light`);
      await inspect(page, `${name}-live`);
      await page.locator('[data-part="sub-agent"]').waitFor({ timeout: 15_000 }).catch(() => { throw new Error(`${name}: later child progress did not render`); });
      if (await rows(page).count() !== 2) throw new Error(`${name}: later child progress removed a durable hold row`);
      const generic = page.locator('[data-part="notification"][data-kind="notification"]', { hasText: "default notification remains visible" });
      await generic.waitFor({ timeout: 15_000 }).catch(() => { throw new Error(`${name}: unknown notification did not delegate to Fulcrum Notification`); });
      const malformed = page.locator('[data-part="notification"][data-kind="notification"]', { hasText: "child malformed waits for a provider rate limit" });
      await malformed.waitFor({ timeout: 15_000 }).catch(() => { throw new Error(`${name}: malformed child hold did not delegate to Fulcrum Notification`); });
      const beforeReload = await rows(page).allTextContents();
      await page.reload();
      await inspect(page, `${name}-reload`);
      if (JSON.stringify(await rows(page).allTextContents()) !== JSON.stringify(beforeReload)) throw new Error(`${name}: reload changed child hold copy or order`);
      await primary.close();

      const variants = [
        { key: "desktop-light", width: 1440, theme: "github-light", colorScheme: "light" as const, forcedColors: "none" as const },
        { key: "desktop-dark", width: 1440, theme: "github-dark", colorScheme: "dark" as const, forcedColors: "none" as const },
        { key: "mobile-light", width: 390, theme: "github-light", colorScheme: "light" as const, forcedColors: "none" as const },
        { key: "mobile-dark", width: 390, theme: "github-dark", colorScheme: "dark" as const, forcedColors: "none" as const },
        { key: "forced-colors", width: 1440, theme: "github-light", colorScheme: "light" as const, forcedColors: "active" as const },
      ];
      for (const variant of variants) {
        const context = await browser.newContext({ viewport: { width: variant.width, height: 900 }, colorScheme: variant.colorScheme, forcedColors: variant.forcedColors, timezoneId: "America/New_York" });
        const variantPage = await context.newPage();
        await variantPage.goto(`${origin}/?run=${CHILD_HOLD}&theme=${variant.theme}`);
        await inspect(variantPage, `${name}-${variant.key}`);
        if (screenshotDir) await variantPage.screenshot({ path: join(screenshotDir, `${name}-${variant.key}.png`), fullPage: true });
        await context.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    vite.kill("SIGTERM");
    await Promise.race([new Promise<void>((resolve) => vite.once("exit", () => resolve())), Bun.sleep(2_000)]);
    await fake.close();
    await rm(gammaHome, { recursive: true, force: true });
  }
}

if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
await runEngine("chromium", chromium);
await runEngine("webkit", webkit);
console.log("child hold gate: 10 visual cases passed; live, reload, fallback, privacy, time, progress, and overflow passed");
