import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { chromium } from "playwright";
import { ACTIVE, LONG, startFakeZeta } from "./fake-zeta";

async function assertCenterHit(control: import("playwright").Locator, label: string) {
  const box = await control.boundingBox();
  if (!box) throw new Error(`${label}: missing control bounds`);
  const hit = await control.evaluate((element, point) => {
    const target = document.elementFromPoint(point.x, point.y);
    const lane = document.querySelector<HTMLElement>(".jump-lane");
    const style = lane && getComputedStyle(lane);
    const rect = lane?.getBoundingClientRect();
    const controlStyle = getComputedStyle(element);
    return {
      hit: target instanceof HTMLElement ? `${target.tagName.toLowerCase()}.${target.className}` : String(target),
      inside: target === element || element.contains(target),
      control: { parent: element.parentElement?.getAttribute("data-part") ?? element.parentElement?.className, position: controlStyle.position, zIndex: controlStyle.zIndex, height: controlStyle.height, rect: { x: point.x - element.getBoundingClientRect().width / 2, y: point.y - element.getBoundingClientRect().height / 2, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height } },
      lane: lane ? { parent: lane.parentElement?.className, position: style?.position, zIndex: style?.zIndex, height: style?.height, rect: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : null,
    };
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  if (label.includes("jump to approval")) console.log(`${label}: ${JSON.stringify(hit)}`);
  if (!hit.inside) throw new Error(`${label}: center hit ${hit.hit}; control ${JSON.stringify(hit.control)}; lane ${JSON.stringify(hit.lane)}`);
}

async function assertControlsClickable(page: import("playwright").Page, label: string) {
  const controls = page.locator('.dock button:visible, [data-part="approval-actions"] button:visible');
  for (let index = 0; index < await controls.count(); index++) await assertCenterHit(controls.nth(index), `${label}: control ${index}`);
}

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
    fake.setLive(true);
    const approvalPage = await browser.newPage({ viewport: { width, height: 900 } });
    await approvalPage.goto(`${origin}/?run=${ACTIVE}`);
    const approval = approvalPage.locator('[data-part="approval"][data-state="pending"]');
    await approval.waitFor({ timeout: 15_000 });
    const jumpToApproval = approvalPage.getByRole("button", { name: /jump to approval/i });
    await jumpToApproval.focus();
    await assertCenterHit(jumpToApproval, `${width}: jump to approval`);
    await jumpToApproval.click();
    await approval.getByRole("button", { name: "approve" }).waitFor({ timeout: 5_000 });
    const approvalInView = await approval.evaluate((element) => {
      const row = element.getBoundingClientRect();
      const viewport = element.closest(".scroll")!.getBoundingClientRect();
      return row.top >= viewport.top && row.bottom <= viewport.bottom;
    });
    if (!approvalInView) throw new Error(`${width}: jump to approval did not reveal the approval`);
    await assertControlsClickable(approvalPage, `${width}: approval view`);
    await approval.getByRole("button", { name: "deny" }).click();
    for (let attempt = 0; fake.running && attempt < 100; attempt++) await Bun.sleep(20);
    if (fake.running) throw new Error(`${width}: approval turn did not finish`);
    await approvalPage.close();
    fake.setLive(false);

    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${origin}/?run=${LONG}`);
    const scroll = page.locator(".scroll");
    await page.locator('[data-part="timeline"] [data-kind="user"]').last().waitFor({ timeout: 20_000 });
    await page.locator(".note", { hasText: "loading earlier messages" }).waitFor({ state: "detached", timeout: 20_000 });
    await page.waitForFunction(() => {
      const element = document.querySelector<HTMLElement>(".scroll");
      return element && element.scrollHeight > element.clientHeight * 2;
    });
    const transcriptBefore = await scroll.boundingBox();
    if (!transcriptBefore) throw new Error(`${width}: missing transcript bounds`);
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
    const jump = page.getByRole("button", { name: /jump to latest/i });
    await jump.waitFor({ timeout: 15_000 });
    const [transcriptAfter, control] = await Promise.all([scroll.boundingBox(), jump.boundingBox()]);
    if (!transcriptAfter || !control) throw new Error(`${width}: missing layout bounds`);
    if (transcriptBefore.y !== transcriptAfter.y || transcriptBefore.height !== transcriptAfter.height) throw new Error(`${width}: showing the control shifted the transcript (${transcriptBefore.y}/${transcriptBefore.height} to ${transcriptAfter.y}/${transcriptAfter.height})`);
    if (control.y < transcriptAfter.y + transcriptAfter.height - 0.5) throw new Error(`${width}: control overlaps transcript text`);
    await assertCenterHit(jump, `${width}: jump to latest`);
    await assertControlsClickable(page, `${width}: jump to latest view`);

    await jump.click();
    await page.waitForFunction(() => {
      const element = document.querySelector<HTMLElement>(".scroll");
      return element && element.scrollHeight - element.clientHeight - element.scrollTop < 2;
    });
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
