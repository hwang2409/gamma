import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { ACTIVE, FIDELITY, startFakeZeta } from "./fake-zeta";

type Fake = Awaited<ReturnType<typeof startFakeZeta>>;
const until = async (test: () => boolean | Promise<boolean>, timeout: number, name: string) => {
  const end = Date.now() + timeout;
  while (!await test()) {
    if (Date.now() >= end) throw new Error(`${name} timed out after ${timeout}ms`);
    await Bun.sleep(50);
  }
};
const ready = (page: Page) => page.locator('.dock textarea[aria-label^="message"]').waitFor({ timeout: 15_000 });

async function fidelityValues(page: Page) {
  const shell = page.locator('[data-tool-view="shell"]', { hasText: "fidelity-marker" });
  await shell.waitFor({ timeout: 10_000 });
  const summary = shell.locator('[data-part="tool-summary"]');
  if (await summary.getAttribute("aria-expanded") === "false") await summary.click();
  await shell.getByText("failed", { exact: true }).waitFor({ timeout: 10_000 });
  const image = shell.locator('[data-part="image"]', { hasText: "fidelity preview" });
  await image.waitFor({ timeout: 10_000 });
  const text = (await shell.innerText()).replace(/\s+/g, " ").trim();
  if (!text.includes("exit 2") || !text.includes("/tmp")) throw new Error(`fidelity shell lost exit code or cwd: ${JSON.stringify(text)}`);
  if (!text.includes("1.2 KB")) throw new Error(`fidelity image lost its size: ${JSON.stringify(text)}`);
  if (await image.getAttribute("data-size") !== "known") throw new Error("fidelity image lost its dimensions");
  return {
    command: (await summary.innerText()).replace(/\s+/g, " ").trim(),
    stderr: "failed",
    exit: "exit 2",
    image: (await image.innerText()).replace(/\s+/g, " ").trim(),
    tools: await page.locator('[data-part="timeline"] [data-part="tool"]').count(),
  };
}

export async function checkFidelityData(page: Page, origin: string) {
  await page.goto(`${origin}/?theme=tokyo-night&run=${FIDELITY}`);
  await ready(page);
  const live = await fidelityValues(page);
  await page.reload();
  await ready(page);
  const reloaded = await fidelityValues(page);
  if (JSON.stringify(reloaded) !== JSON.stringify(live)) throw new Error(`live/reload fidelity differs: ${JSON.stringify({ live, reloaded })}`);
}

async function checkTurnEndResend(page: Page, fake: Fake, origin: string) {
  fake.clearSent();
  await page.goto(`${origin}/?theme=tokyo-night&run=${ACTIVE}`);
  await ready(page);
  const field = page.locator('.dock textarea[aria-label^="message"]');
  await field.fill("start the fidelity resend turn");
  await field.press("Enter");
  await until(() => fake.sent.some((item) => item.text === "start the fidelity resend turn"), 10_000, "first send");
  await page.locator('.dock textarea[aria-label^="steer"]').waitFor({ timeout: 10_000 });
  await field.fill("automatic fidelity steer");
  await field.press("Enter");
  await until(() => fake.sent.filter((item) => item.text === "automatic fidelity steer").length === 2, 20_000, "one automatic resend");
  await Bun.sleep(1_000);
  const attempts = fake.sent.filter((item) => item.text === "automatic fidelity steer");
  if (attempts.length !== 2) throw new Error(`automatic resend ran ${attempts.length - 1} times`);
  if (attempts[0]!.method !== "steer" || attempts[1]!.method !== "send") throw new Error(`automatic resend methods were ${attempts.map((item) => item.method).join(",")}`);
  if (attempts[0]!.delivery_id === attempts[1]!.delivery_id) throw new Error("automatic resend reused its delivery id");
  if (attempts.some((item) => item.session !== ACTIVE)) throw new Error(`automatic resend landed outside ${ACTIVE}`);
}

if (import.meta.main) {
  const root = new URL("..", import.meta.url).pathname;
  const port = Number(process.env.FIDELITY_GATE_PORT ?? 4387);
  const origin = `http://127.0.0.1:${port}`;
  const gammaHome = await mkdtemp(join(tmpdir(), "gamma-fidelity-"));
  const fake = await startFakeZeta({ origins: [origin], live: false });
  const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: root,
    env: { ...process.env, FAKE_ZETA_WORD_MS: "5", ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) },
    stdio: "ignore",
  });
  let browser;
  try {
    await until(() => fetch(origin).then((response) => response.ok, () => false), 60_000, "vite start");
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await checkFidelityData(page, origin);
    await checkTurnEndResend(page, fake, origin);
    console.log("fidelity gate passed: live/reload tool data and one turn-end automatic resend");
  } finally {
    await browser?.close();
    if (vite.exitCode === null) vite.kill("SIGTERM");
    await Promise.race([new Promise<void>((resolve) => vite.once("exit", () => resolve())), Bun.sleep(2_000)]);
    await fake.close();
    await rm(gammaHome, { recursive: true, force: true });
  }
}
