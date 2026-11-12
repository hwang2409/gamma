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
// A slow reply keeps the turn streaming through the disappearance check, so a new line lands between sample and click.
process.env.FAKE_ZETA_WORD_MS ??= "150";
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
    await page.locator(".note", { hasText: "loading history…" }).waitFor({ state: "detached", timeout: 20_000 });
    await page.waitForFunction(() => {
      const element = document.querySelector<HTMLElement>(".scroll");
      return element && element.scrollHeight > element.clientHeight * 2;
    });
    const composer = page.locator('.dock [data-part="composer"]');
    await scroll.evaluate((element) => { element.scrollTop = 0; });
    await composer.locator("textarea").fill(`use a tool; follow accepted send at ${width}`);
    await composer.locator('[data-part="composer-submit"]').click();
    // Mirrors accepted send/steer replies in zeta tests/test_server_delivery.py:570-601.
    await page.locator('[data-part="timeline"] [data-kind="user"]', { hasText: `follow accepted send at ${width}` }).waitFor({ timeout: 5_000 });
    await page.waitForFunction(() => {
      const element = document.querySelector<HTMLElement>(".scroll");
      return element && element.scrollHeight - element.clientHeight - element.scrollTop < 2;
    });

    await composer.and(page.locator('[data-state="steerable"]')).waitFor({ timeout: 5_000 });
    const viewport = await scroll.boundingBox();
    if (!viewport) throw new Error(`${width}: missing scroll viewport`);
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
    for (let step = 0; step < 8; step++) { await page.mouse.wheel(0, -1000); await page.waitForTimeout(50); }
    await page.waitForFunction(() => {
      const element = document.querySelector<HTMLElement>(".scroll");
      return element && element.scrollTop < element.scrollHeight - element.clientHeight - 100;
    });
    const transcriptBefore = await scroll.boundingBox();
    if (!transcriptBefore) throw new Error(`${width}: missing transcript bounds`);
    const rowBefore = await page.locator('[data-part="timeline"] [data-id]').first().evaluate((element) => ({ id: element.getAttribute("data-id"), top: element.getBoundingClientRect().top }));
    if (!rowBefore) throw new Error(`${width}: missing comparison row`);
    // The only change between the two samples is the control's visibility.
    const jump = page.getByRole("button", { name: /jump to latest/i });
    await jump.waitFor({ timeout: 15_000 });
    const [transcriptAfter, control] = await Promise.all([scroll.boundingBox(), jump.boundingBox()]);
    const rowAfter = await page.locator(`[data-part="timeline"] [data-id="${rowBefore.id}"]`).evaluate((element) => element.getBoundingClientRect().top).catch(() => null);
    if (!transcriptAfter || !control) throw new Error(`${width}: missing layout bounds`);
    if (transcriptBefore.y !== transcriptAfter.y || transcriptBefore.height !== transcriptAfter.height) throw new Error(`${width}: showing the control shifted the transcript (${transcriptBefore.y}/${transcriptBefore.height} to ${transcriptAfter.y}/${transcriptAfter.height})`);
    if (rowAfter === null) throw new Error(`${width}: showing the control unmounted row ${rowBefore.id}`);
    if (Math.abs(rowBefore.top - rowAfter) > 0.5) throw new Error(`${width}: showing the control shifted row ${rowBefore.id} (${rowBefore.top} to ${rowAfter})`);
    if (control.y < transcriptAfter.y + transcriptAfter.height - 0.5) throw new Error(`${width}: control overlaps transcript text`);

    // Measure the end rows first: an estimated end row can shrink by more than 10 px when it mounts, which would leave
    // the reader truly at the bottom (following) instead of 10 px above it. Half a viewport above the end mounts the
    // end rows (overscan is one viewport) without reaching the bottom, so the reader stays unpinned.
    await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight - element.clientHeight * 1.5; });
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('[data-part="timeline"] [data-id]')].slice(-3);
      const next = rows.map((row) => `${row.dataset.id}:${row.getBoundingClientRect().height}`).join("|");
      const state = window as typeof window & { __jumpEndRows?: { value: string; frames: number } };
      state.__jumpEndRows = state.__jumpEndRows?.value === next ? { value: next, frames: state.__jumpEndRows.frames + 1 } : { value: next, frames: 1 };
      return rows.length > 0 && state.__jumpEndRows.frames >= 3;
    }, undefined, { polling: "raf" });
    await scroll.evaluate(async (element) => {
      element.scrollTop = element.scrollHeight - element.clientHeight - 10;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    await jump.waitFor();
    await page.waitForFunction(() => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-part="timeline"] [data-id]')].at(-1);
      if (!row) return false;
      const next = `${row.dataset.id}:${row.getBoundingClientRect().top}`;
      const state = window as typeof window & { __jumpStableRow?: { value: string; frames: number } };
      state.__jumpStableRow = state.__jumpStableRow?.value === next ? { value: next, frames: state.__jumpStableRow.frames + 1 } : { value: next, frames: 1 };
      return state.__jumpStableRow.frames >= 3;
    }, { polling: "raf" });
    // A row's place in the transcript content is its viewport top plus scrollTop; only a layout shift changes it.
    const measure = (element: Element) => {
      const scroll = document.querySelector<HTMLElement>(".scroll")!;
      const box = scroll.getBoundingClientRect();
      const row = element.getBoundingClientRect();
      return { id: element.getAttribute("data-id"), top: row.top, height: row.height, scrollTop: scroll.scrollTop, boxTop: box.top, boxHeight: box.height };
    };
    const stableRow = await page.locator('[data-part="timeline"] [data-id]').last().evaluate(measure);
    // The live reply wraps to a new line before the click, as on a slow CI runner.
    await page.waitForFunction(({ id, height }) => {
      const row = document.querySelector(`[data-part="timeline"] [data-id="${CSS.escape(id)}"]`);
      return !!row && row.getBoundingClientRect().height > height + 0.5;
    }, { id: stableRow.id!, height: stableRow.height }, { polling: "raf", timeout: 15_000 });
    await jump.click();
    await page.waitForFunction(() => {
      const element = document.querySelector<HTMLElement>(".scroll");
      return element && element.scrollHeight - element.clientHeight - element.scrollTop < 2;
    });
    await jump.waitFor({ state: "detached" });
    const rowAfterDisappearance = await page.locator(`[data-part="timeline"] [data-id="${stableRow.id}"]`).evaluate(measure);
    if (stableRow.boxTop !== rowAfterDisappearance.boxTop || stableRow.boxHeight !== rowAfterDisappearance.boxHeight) throw new Error(`${width}: hiding the control resized the transcript (${stableRow.boxTop}/${stableRow.boxHeight} to ${rowAfterDisappearance.boxTop}/${rowAfterDisappearance.boxHeight})`);
    const shift = (stableRow.top + stableRow.scrollTop) - (rowAfterDisappearance.top + rowAfterDisappearance.scrollTop);
    if (Math.abs(shift) > 0.5) throw new Error(`${width}: hiding the control shifted row ${stableRow.id} by ${shift} px beyond the ${rowAfterDisappearance.scrollTop - stableRow.scrollTop} px scroll to the bottom`);
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
