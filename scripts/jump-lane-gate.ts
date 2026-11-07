import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { chromium } from "playwright";
import { LONG, startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.JUMP_GATE_PORT ?? 4187);
const origin = `http://127.0.0.1:${port}`;
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-jump-gate-"));
const fake = await startFakeZeta({ origins: [origin], live: false });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: root,
  env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) },
  stdio: "ignore",
});

const browser = await chromium.launch();
try {
  for (let attempt = 0; ; attempt++) {
    if (vite.exitCode !== null) throw new Error("vite exited");
    if (await fetch(origin).then((response) => response.ok, () => false)) break;
    if (attempt === 600) throw new Error("vite did not start");
    await Bun.sleep(100);
  }

  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${origin}/?run=${LONG}`);
    const scroll = page.locator(".scroll");
    await page.locator('[data-part="timeline"] [data-kind="user"]').last().waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => {
      const element = document.querySelector<HTMLElement>(".scroll");
      return element && element.scrollHeight > element.clientHeight * 2;
    });

    const transcriptBefore = await scroll.boundingBox();
    await scroll.evaluate((element) => { element.scrollTop = 0; });
    const jump = page.getByRole("button", { name: /jump to latest/i });
    await jump.waitFor({ timeout: 5_000 });
    const [transcriptAfter, control] = await Promise.all([scroll.boundingBox(), jump.boundingBox()]);
    if (!transcriptBefore || !transcriptAfter || !control) throw new Error(`${width}: missing layout bounds`);
    if (transcriptBefore.y !== transcriptAfter.y || transcriptBefore.height !== transcriptAfter.height) throw new Error(`${width}: showing the control shifted the transcript`);
    if (control.y < transcriptAfter.y + transcriptAfter.height - 0.5) throw new Error(`${width}: control overlaps transcript text`);

    await jump.click();
    await page.waitForFunction(() => {
      const element = document.querySelector<HTMLElement>(".scroll");
      return element && element.scrollHeight - element.clientHeight - element.scrollTop < 2;
    });

    await scroll.evaluate((element) => { element.scrollTop = 0; });
    await jump.waitFor();
    const composer = page.locator('.dock [data-part="composer"]');
    await composer.locator("textarea").fill(`follow accepted send at ${width}`);
    await composer.locator('[data-part="composer-submit"]').click();
    // Mirrors accepted send/steer replies in zeta tests/test_server_delivery.py:570-601.
    await page.locator('[data-part="timeline"] [data-kind="user"]', { hasText: `follow accepted send at ${width}` }).waitFor({ timeout: 5_000 });
    await page.waitForFunction(() => {
      const element = document.querySelector<HTMLElement>(".scroll");
      return element && element.scrollHeight - element.clientHeight - element.scrollTop < 2;
    });

    await composer.and(page.locator('[data-state="steerable"]')).waitFor({ timeout: 5_000 });
    await scroll.evaluate((element) => { element.scrollTop = 0; });
    await composer.locator("textarea").fill(`follow accepted steer at ${width}`);
    await composer.locator('[data-part="composer-submit"]').click();
    await page.locator('[data-part="timeline"] [data-kind="user"]', { hasText: `follow accepted steer at ${width}` }).waitFor({ timeout: 5_000 });
    await page.waitForFunction(() => {
      const element = document.querySelector<HTMLElement>(".scroll");
      return element && element.scrollHeight - element.clientHeight - element.scrollTop < 2;
    });
    await page.close();
    console.log(`ok   jump lane at ${width}px`);
  }
} finally {
  await browser.close();
  vite.kill("SIGTERM");
  await fake.close();
  await rm(gammaHome, { recursive: true, force: true });
}
