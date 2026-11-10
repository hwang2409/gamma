import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type Locator, type Page } from "playwright";
import { ACTIVE, startFakeZeta } from "./fake-zeta";

const FIDELITY = "s-fidelity";
type Fake = Awaited<ReturnType<typeof startFakeZeta>>;
const until = async (test: () => boolean | Promise<boolean>, timeout: number, name: string) => {
  const end = Date.now() + timeout;
  while (!await test()) {
    if (Date.now() >= end) throw new Error(`${name} timed out after ${timeout}ms`);
    await Bun.sleep(50);
  }
};
const waitFor = async (locator: Locator, timeout: number, name: string) => {
  try {
    await locator.waitFor({ timeout });
  } catch (error) {
    throw new Error(`${name} timed out after ${timeout}ms`, { cause: error });
  }
};
const ready = (page: Page) => waitFor(page.locator('.dock textarea[aria-label^="message"]'), 15_000, "message composer ready");

async function fidelityValues(page: Page) {
  const shell = page.locator('[data-tool-view="shell"]', { hasText: "fidelity-marker" });
  await waitFor(shell, 10_000, "fidelity shell output");
  const summary = shell.locator('[data-part="tool-summary"]');
  if (await summary.getAttribute("aria-expanded") === "false") await summary.click();
  await waitFor(shell.locator('[data-stream="stderr"]', { hasText: "failed" }), 10_000, "fidelity stderr output");
  const image = shell.locator('[data-part="image"]', { hasText: "fidelity preview" });
  await waitFor(image, 10_000, "fidelity image metadata");
  await waitFor(shell.locator('[data-part="image-placeholder"]', { hasText: "image not kept in history" }), 10_000, "omitted image history placeholder");
  const text = (await shell.innerText()).replace(/\s+/g, " ").trim();
  if (!text.includes("exit 2") || !text.includes("/tmp")) throw new Error(`fidelity shell lost exit code or cwd: ${JSON.stringify(text)}`);
  if (!text.includes("1.2 kB")) throw new Error(`fidelity image lost its size: ${JSON.stringify(text)}`);
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

const reasonRows = {
  turn_end: "retained dropped steer",
  abort: "retained stopped steer",
  clear: "retained removed steer",
  disconnect: "retained lost-connection steer",
  failed: "retained unsuccessful steer",
  restart: "retained interrupted steer",
  future_token: "retained future steer",
} as const;
const reasonWords = {
  turn_end: "not delivered · the turn ended before zeta used this steer",
  abort: "not delivered · the stop ended the turn before zeta took this steer",
  clear: "not delivered · pending steers were cleared before zeta used this steer",
  disconnect: "not delivered · the connection ended before zeta used this steer",
  failed: "not delivered · the turn failed before zeta used this steer",
  restart: "not delivered · zeta restarted before it used this steer",
  future_token: "not delivered · zeta did not take this message",
} as const;

const userRow = (page: Page, text: string) => page.locator('[data-part="item"][data-kind="user"]', { hasText: text });

async function openFidelityHistory(page: Page, origin: string) {
  await page.goto(`${origin}/?theme=tokyo-night&run=${FIDELITY}`);
  await ready(page);
  await waitFor(userRow(page, "retained dropped steer"), 10_000, "fidelity history row");
}

async function checkSlotNull(page: Page, origin: string) {
  await page.goto(`${origin}/?theme=tokyo-night&run=${ACTIVE}`);
  await ready(page);
  const delivered = userRow(page, "the reconnect test in packages/zeta fails");
  await waitFor(delivered, 10_000, "delivered message row");
  if (await delivered.locator('[data-part="delivery-note"]').count()) throw new Error("a delivered row has a delivery note wrapper");
  if (await delivered.locator("xpath=following-sibling::*[contains(@class, 'undelivered')]").count()) throw new Error("a delivered row still reserves gamma's old sibling note");
}

async function checkHistoryDrop(page: Page, origin: string) {
  await openFidelityHistory(page, origin);
  const dropped = userRow(page, "retained dropped steer");
  const notes = dropped.locator('[data-part="delivery-note"]');
  if (await notes.count() !== 1) throw new Error(`history drop has ${await notes.count()} delivery notes`);
  const note = (await notes.innerText()).replace(/\s+/g, " ").trim();
  if (note !== reasonWords.turn_end) throw new Error(`history drop note was ${JSON.stringify(note)}`);
  if (await dropped.getByRole("button", { name: "resend" }).count()) throw new Error("history-only drop offered resend without local owner state");
}

async function checkReasonTable(page: Page, origin: string) {
  await openFidelityHistory(page, origin);
  for (const [reason, words] of Object.entries(reasonWords)) {
    const row = userRow(page, reasonRows[reason as keyof typeof reasonRows]);
    await waitFor(row, 10_000, `${reason} history row`);
    const note = (await row.locator('[data-part="delivery-note"]').innerText()).replace(/\s+/g, " ").trim();
    if (note !== words) throw new Error(`${reason} note was ${JSON.stringify(note)}`);
  }
}

async function makeLocalDrop(page: Page, fake: Fake, origin: string, suffix: string) {
  fake.clearSent();
  await page.goto(`${origin}/?theme=tokyo-night&run=${ACTIVE}`);
  await ready(page);
  const field = page.locator('.dock textarea[aria-label="message"]');
  await field.fill(`use a tool ${suffix}`);
  await page.getByRole("button", { name: "send message" }).click();
  await waitFor(page.getByRole("button", { name: "stop the running turn" }), 10_000, "running turn stop control");
  const steer = `queued ${suffix}`;
  await field.fill(steer);
  await page.getByRole("button", { name: "steer the running turn" }).click();
  await waitFor(page.getByLabel(/message queued/i), 10_000, "queued message status");
  await page.getByRole("button", { name: "stop the running turn" }).click();
  const row = userRow(page, steer);
  await waitFor(row.locator('[data-part="delivery-note"]'), 10_000, "dropped delivery note");
  return { row, steer };
}

async function checkLocalDrop(page: Page, fake: Fake, origin: string) {
  const { row } = await makeLocalDrop(page, fake, origin, "local slot");
  if (await row.locator('[data-part="delivery-note"]').count() !== 1) throw new Error("local-only drop does not have exactly one slotted note");
  if (await row.getByRole("button", { name: "resend" }).count() !== 1) throw new Error("local-only drop does not have exactly one resend button");
}

async function checkOneOwner(page: Page, origin: string) {
  await openFidelityHistory(page, origin);
  for (const reason of Object.keys(reasonWords)) {
    const row = userRow(page, reasonRows[reason as keyof typeof reasonRows]);
    const note = row.locator('[data-part="delivery-note"]');
    if (await note.count() !== 1) throw new Error(`${reason} does not have exactly one note owner`);
    const words = (await note.innerText()).replace(/\s+/g, " ").trim();
    if (words !== reasonWords[reason as keyof typeof reasonWords]) throw new Error(`${reason} note was ${JSON.stringify(words)}`);
    const rendered = await row.innerText();
    for (const token of ["delivery_status", "turn_end", "future_token", "abort", "clear", "disconnect", "restart"]) if (new RegExp(`(^|\\W)${token}($|\\W)`).test(rendered)) throw new Error(`raw ${token} leaked into the retained row`);
  }
}

async function checkResendSafety(page: Page, fake: Fake, origin: string) {
  const { row, steer } = await makeLocalDrop(page, fake, origin, "resend safety");
  const first = fake.sent.find((item) => item.method === "steer" && item.text === steer)!;
  await row.getByRole("button", { name: "resend" }).click();
  await until(() => fake.sent.some((item) => item.method === "send" && item.text === steer), 10_000, "resend click");
  const sent = fake.sent.filter((item) => item.method === "send" && item.text === steer);
  if (sent.length !== 1 || sent[0]!.session !== ACTIVE || sent[0]!.delivery_id === first.delivery_id) throw new Error(`unsafe resend request: ${JSON.stringify(sent)}`);
  await makeLocalDrop(page, fake, origin, "leave run");
  const before = fake.sent.length;
  await page.goto(`${origin}/?theme=tokyo-night&run=${FIDELITY}`);
  await ready(page);
  await Bun.sleep(500);
  if (fake.sent.length !== before) throw new Error("leaving the run sent the dropped steer");
}

async function checkSlotLayout(page: Page, fake: Fake, origin: string) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const { row } = await makeLocalDrop(page, fake, origin, `layout ${width}`);
    const note = row.locator('[data-part="delivery-note"]');
    const box = await note.boundingBox();
    if (!box || box.x < 0 || box.x + box.width > width || box.y + box.height > 800) throw new Error(`delivery note clips at ${width}: ${JSON.stringify(box)}`);
    const colors = await row.evaluate((node) => {
      const note = node.querySelector<HTMLElement>('[data-part="delivery-note"]')!;
      const message = node.querySelector<HTMLElement>('[data-part="message-content"]')!;
      return {
        danger: getComputedStyle(node).borderLeftColor,
        mark: getComputedStyle(note, "::before").backgroundColor,
        note: getComputedStyle(note).color,
        noteDecoration: getComputedStyle(note).textDecorationLine,
        rowDecoration: getComputedStyle(node).textDecorationLine,
        messageDecoration: getComputedStyle(message).textDecorationLine,
      };
    });
    if (colors.noteDecoration !== "none" || colors.rowDecoration !== "none") throw new Error(`delivery note is struck at ${width}: ${JSON.stringify(colors)}`);
    if (!colors.messageDecoration.includes("line-through")) throw new Error(`dropped message is not struck at ${width}: ${JSON.stringify(colors)}`);
    if (colors.note === colors.danger || colors.mark !== colors.danger) throw new Error(`delivery note uses danger as text instead of its mark at ${width}: ${JSON.stringify(colors)}`);
    if (width === 390) {
      const noteLeft = await note.evaluate((node) => node.getBoundingClientRect().left);
      const buttonLeft = await note.getByRole("button", { name: "resend" }).evaluate((node) => node.getBoundingClientRect().left);
      if (Math.abs(noteLeft - buttonLeft) > 16) throw new Error(`mobile resend is misaligned by ${Math.abs(noteLeft - buttonLeft)}px`);
    }
  }
  await page.emulateMedia({ colorScheme: "light", forcedColors: "active" });
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  const { row } = await makeLocalDrop(page, fake, origin, "forced zoom");
  if (!await row.locator('[data-part="delivery-note"]').isVisible()) throw new Error("delivery note disappeared in forced colors at 200% zoom");
}

const omittedRow = (page: Page, deliveryId: string) => page.locator(`[data-part="item"][data-kind="user"][data-id="user:delivery:${deliveryId}"]`);
const omittedReason = (words: string) => `${words} · text not kept`;

async function checkGenericTerminal(page: Page, origin: string) {
  await openFidelityHistory(page, origin);
  const row = omittedRow(page, "fidelity-generic-drop");
  await waitFor(row, 10_000, "generic terminal user row");
  if (await row.count() !== 1) throw new Error(`generic terminal created ${await row.count()} user rows`);
  if (await page.locator('[data-part="notification"]', { hasText: "steer dropped" }).count()) throw new Error("generic terminal created a notification row");
  const note = (await row.locator('[data-part="delivery-note"]').innerText()).replace(/\s+/g, " ").trim();
  if (note !== omittedReason(reasonWords.turn_end)) throw new Error(`generic terminal note was ${JSON.stringify(note)}`);
}

async function checkTextlessRendering(page: Page, origin: string) {
  await openFidelityHistory(page, origin);
  const row = omittedRow(page, "fidelity-generic-drop");
  await waitFor(row, 10_000, "text-less custom user row");
  if (!await row.isVisible()) throw new Error("text-less row did not reach gamma's user renderer");
  if (await row.locator('[data-part="message-content"], [data-part="message-prompt"]').count()) throw new Error("text-less row rendered an empty message bubble");
  if (await row.getByRole("button", { name: "resend" }).count()) throw new Error("text-less history row offered resend");
  const rendered = (await row.innerText()).replace(/\s+/g, " ").trim();
  if (rendered !== omittedReason(reasonWords.turn_end)) throw new Error(`text-less row rendered ${JSON.stringify(rendered)}`);
  if (/steer dropped|turn_end/.test(rendered)) throw new Error(`text-less row leaked wire text: ${JSON.stringify(rendered)}`);
}

async function checkLaterEcho(page: Page, fake: Fake, origin: string) {
  await openFidelityHistory(page, origin);
  const row = omittedRow(page, "fidelity-generic-drop");
  await waitFor(row, 10_000, "text-less row before later echo");
  const before = (await row.locator('[data-part="delivery-note"]').innerText()).replace(/\s+/g, " ").trim();
  if (before !== omittedReason(reasonWords.turn_end)) throw new Error(`pre-echo note was ${JSON.stringify(before)}`);
  fake.echoFidelityDrop();
  await waitFor(row.locator('[data-part="message-content"]', { hasText: "recovered omitted steer" }), 10_000, "later echo text in existing row");
  if (await page.locator('[data-id="user:delivery:fidelity-generic-drop"]').count() !== 1) throw new Error("later echo duplicated the dropped row");
  if (await row.getAttribute("data-text-omitted") !== null) throw new Error("later echo left the row marked text-omitted");
  const note = (await row.locator('[data-part="delivery-note"]').innerText()).replace(/\s+/g, " ").trim();
  if (note !== reasonWords.turn_end) throw new Error(`later echo note was ${JSON.stringify(note)}`);
}

async function checkOmittedPrivacy(page: Page, origin: string) {
  await openFidelityHistory(page, origin);
  for (const deliveryId of ["fidelity-generic-unknown", "fidelity-generic-missing"]) {
    const row = omittedRow(page, deliveryId);
    await waitFor(row, 10_000, `${deliveryId} text-less row`);
    const rendered = (await row.innerText()).replace(/\s+/g, " ").trim();
    const expected = omittedReason("not delivered · zeta did not take this message");
    if (rendered !== expected) throw new Error(`${deliveryId} rendered ${JSON.stringify(rendered)}`);
    if (/private_future_token|steer dropped|delivery_status/.test(rendered)) throw new Error(`${deliveryId} leaked wire text: ${JSON.stringify(rendered)}`);
  }
}

async function checkStopReload(page: Page, fake: Fake, origin: string) {
  fake.setLive(true);
  await page.goto(`${origin}/?theme=tokyo-night&run=${ACTIVE}`);
  await ready(page);
  await waitFor(page.getByText("needs approval"), 15_000, "seeded approval");
  await page.getByRole("button", { name: "stop the running turn" }).click();
  const stopped = page.locator('[data-part="timeline"] [data-kind="stopped"]');
  await waitFor(stopped, 10_000, "live stopped row");
  await page.reload();
  await ready(page);
  await waitFor(stopped, 10_000, "reloaded stopped row");
  if (await stopped.count() !== 1) throw new Error(`stop + reload restored ${await stopped.count()} stopped rows instead of 1`);
  if (await page.getByText("needs approval").count()) throw new Error("stop + reload kept the cancelled approval live");
}

async function checkTurnEndResend(page: Page, fake: Fake, origin: string) {
  fake.clearSent();
  await page.goto(`${origin}/?theme=tokyo-night&run=${ACTIVE}`);
  await ready(page);
  const field = page.locator('.dock textarea[aria-label^="message"]');
  await field.fill("start the fidelity resend turn");
  await page.getByRole("button", { name: "send message" }).click();
  await until(() => fake.sent.some((item) => item.text === "start the fidelity resend turn"), 10_000, "first send");
  await waitFor(page.getByPlaceholder("steer the running turn"), 10_000, "steer composer ready");
  await field.fill("automatic fidelity steer");
  await page.getByRole("button", { name: "steer the running turn" }).click();
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
    env: { ...process.env, FAKE_ZETA_WORD_MS: "30", ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) },
    stdio: "ignore",
  });
  let browser;
  try {
    await until(() => fetch(origin).then((response) => response.ok, () => false), 60_000, "vite start");
    const engine = process.env.FIDELITY_GATE_BROWSER === "webkit" ? webkit : chromium;
    browser = await engine.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const cases = {
      data: () => checkFidelityData(page, origin),
      "slot-null": () => checkSlotNull(page, origin),
      "slot-local": () => checkLocalDrop(page, fake, origin),
      "slot-history": () => checkHistoryDrop(page, origin),
      "slot-owner": () => checkOneOwner(page, origin),
      "slot-reasons": () => checkReasonTable(page, origin),
      "slot-resend": () => checkResendSafety(page, fake, origin),
      "slot-layout": () => checkSlotLayout(page, fake, origin),
      "omitted-generic": () => checkGenericTerminal(page, origin),
      "omitted-render": () => checkTextlessRendering(page, origin),
      "omitted-echo": () => checkLaterEcho(page, fake, origin),
      "omitted-privacy": () => checkOmittedPrivacy(page, origin),
      "stop-reload": () => checkStopReload(page, fake, origin),
      auto: () => checkTurnEndResend(page, fake, origin),
    } as const;
    const selected = process.env.FIDELITY_GATE_CASE as keyof typeof cases | undefined;
    if (selected) await cases[selected]();
    else for (const run of Object.values(cases)) await run();
    console.log(`fidelity gate passed: ${selected ?? "all cases"}`);
  } finally {
    await browser?.close();
    if (vite.exitCode === null) vite.kill("SIGTERM");
    await Promise.race([new Promise<void>((resolve) => vite.once("exit", () => resolve())), Bun.sleep(2_000)]);
    await fake.close();
    await rm(gammaHome, { recursive: true, force: true });
  }
}
