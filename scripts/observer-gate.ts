import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import { ACTIVE, CHILD_HOLD, startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.OBSERVER_GATE_PORT ?? 4357);
const origin = `http://127.0.0.1:${port}`;
const screenshots = process.env.OBSERVER_SCREENSHOTS;
const runId = "s-themes";
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-observer-gate-"));
const fake = await startFakeZeta({ origins: [origin], live: true });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: root,
  env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) },
  stdio: "ignore",
});
const failures: string[] = [];
let passed = 0;
const mutatingMethods = [
  "new_session", "resume", "send", "steer", "send_images", "approve", "deny", "abort", "rename_session",
  "delete_session", "repair_transcript", "switch_branch", "fork_message", "set_settings", "set_compaction",
  "slash_run", "set_turn_context", "account_logout", "account_refresh", "account_switch", "login_start",
  "login_cancel", "project_inbox", "clear_steering", "revoke_session_grants", "child_run_send",
] as const;

for (let attempt = 0; attempt < 100; attempt++) {
  try { if ((await fetch(origin)).ok) break; } catch {}
  if (attempt === 99) throw new Error("vite did not start");
  await Bun.sleep(100);
}
if (screenshots) await mkdir(screenshots, { recursive: true });

async function ready(page: Page) {
  await page.locator(".app").waitFor({ timeout: 15_000 });
}
// Enter only sends once the composer says it can: while the run opens it shows "sending is paused until the run
// opens" and keeps the draft, so an Enter pressed earlier is (correctly) not a send.
async function submit(page: Page, text: string) {
  await page.locator('.dock textarea[aria-label="message"]').fill(text);
  await page.locator('.dock [data-part="composer-submit"]:not([aria-disabled="true"])').waitFor({ timeout: 15_000 });
  await page.locator('.dock textarea[aria-label="message"]').press("Enter");
}
async function check(name: string, run: () => Promise<void>) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); failures.push(`${name}: ${message}`); console.log(`FAIL ${name}: ${message}`); }
}
async function matrix(type: BrowserType, browserName: string, width: number) {
  const browser = await type.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
  try {
    fake.setMode("controller-busy");
    fake.attachQuietly(runId);
    const observerStart = fake.requests.length;
    const observer = await context.newPage();
    await observer.goto(`${origin}/?run=${runId}`);
    await ready(observer);
    await observer.getByText("observing", { exact: true }).waitFor({ timeout: 15_000 });
    const reason = observer.getByText("another client controls this run; you are observing, sending is off", { exact: true });
    await reason.waitFor();
    await observer.getByText("idle", { exact: true }).waitFor();
    if (await observer.getByText("ready", { exact: true }).count()) throw new Error("observer footer still said ready");
    if (screenshots) { await Bun.sleep(400); await observer.screenshot({ path: join(screenshots, `observer-run-${browserName}-${width}.png`), fullPage: true }); }
    const marks = await observer.locator(".authority-mark").evaluate((header, reasonElement) => {
      const reasonMark = getComputedStyle(reasonElement as Element, "::before");
      return { header: getComputedStyle(header).backgroundColor, reason: reasonMark.backgroundColor, shape: reasonMark.outlineStyle };
    }, await reason.elementHandle());
    if (marks.header !== marks.reason || marks.shape === "none") throw new Error(`observer marks did not match: ${JSON.stringify(marks)}`);
    if (width === 390) {
      const gap = await observer.locator(".authority-badge").evaluate((badge) => badge.getBoundingClientRect().left - (document.querySelector(".run-title")?.getBoundingClientRect().right ?? 0));
      if (gap < 11) throw new Error(`mobile title-to-status gap was ${gap}px`);
    }
    if (await observer.locator('.dock textarea[aria-label="message"]').count()) throw new Error("observer composer remained editable");
    const observerRequests = fake.requests.slice(observerStart);
    const mutated = observerRequests.filter(({ method }) => mutatingMethods.includes(method as typeof mutatingMethods[number]));
    if (mutated.length) throw new Error(`observer made mutating calls: ${mutated.map(({ method }) => method).join(", ")}`);
    await observer.close();

    // Zeta origin/main src/zeta/server/protocol.py:357 (#1175): an observer lists children; child_run_send stays controller-only.
    fake.attachQuietly(CHILD_HOLD);
    const childStart = fake.requests.length;
    const child = await context.newPage();
    await child.goto(`${origin}/?run=${CHILD_HOLD}`);
    await ready(child);
    const openCatalog = async () => {
      await child.getByRole("button", { name: /^children/ }).click({ timeout: 15_000 });
      const row = child.getByRole("dialog", { name: "children" }).locator(".child-row").first();
      await row.waitFor({ timeout: 15_000 });
      return row;
    };
    const assertChildView = async (how: string) => {
      await child.waitForURL((url) => url.searchParams.get("child") === "root:2");
      await child.getByRole("log", { name: "saved child activity" }).getByText("saved child transcript is available", { exact: true }).waitFor({ timeout: 15_000 });
      await child.getByText("read-only: follow-ups are available from the controller connection", { exact: true }).waitFor();
      if (await child.getByLabel("child follow-up").count()) throw new Error(`observer child view opened by ${how} exposed its composer`);
      if (await child.locator('.dock textarea[aria-label="message"]').count()) throw new Error(`observer child view opened by ${how} exposed the run composer`);
    };
    await (await openCatalog()).click();
    await assertChildView("click");
    if (screenshots) { await Bun.sleep(400); await child.screenshot({ path: join(screenshots, `observer-child-${browserName}-${width}.png`), fullPage: true }); }
    await child.getByRole("button", { name: "back to parent run" }).click();
    await child.waitForURL((url) => !url.searchParams.has("child"));
    const keyboardRow = await openCatalog();
    await keyboardRow.focus();
    await child.keyboard.press("Enter");
    await assertChildView("Enter");
    const childRequests = fake.requests.slice(childStart);
    if (!childRequests.some(({ method }) => method === "child_run_list")) throw new Error("observer did not list children");
    const childWrites = childRequests.filter(({ method }) => mutatingMethods.includes(method as typeof mutatingMethods[number]));
    if (childWrites.length) throw new Error(`observer child route made mutating calls: ${childWrites.map(({ method }) => method).join(", ")}`);
    await child.close();

    // A zeta before #1175 neither offers nor serves child_run_list to observers (CONTROLLER_READ at a88e60133^1).
    fake.setObserverChildList(false);
    fake.attachQuietly(CHILD_HOLD);
    const olderStart = fake.requests.length;
    const older = await context.newPage();
    await older.goto(`${origin}/?run=${CHILD_HOLD}&child=${encodeURIComponent("root:2")}`);
    await ready(older);
    const olderNote = older.getByText("this zeta connection cannot list child details", { exact: true });
    await olderNote.waitFor({ timeout: 15_000 });
    if (await olderNote.getAttribute("role") !== "status") throw new Error("older-zeta child list note was not neutral");
    if (await older.getByRole("button", { name: /^children/ }).count()) throw new Error("older zeta still offered the child list to an observer");
    await Bun.sleep(500);
    const olderLists = fake.requests.slice(olderStart).filter(({ method }) => method === "child_run_list" || method === "child_run_send");
    if (olderLists.length) throw new Error(`observer on an older zeta requested ${olderLists.map(({ method }) => method).join(", ")}`);
    await older.close();
    fake.setObserverChildList(true);

    fake.setChildRunHistoryEnabled(false);
    fake.attachQuietly(CHILD_HOLD);
    const noHistoryStart = fake.requests.length;
    const noHistory = await context.newPage();
    await noHistory.goto(`${origin}/?run=${CHILD_HOLD}`);
    await ready(noHistory);
    const parentRow = noHistory.locator('[data-part="sub-agent"][data-id="sub-agent:root:2"]');
    await parentRow.waitFor({ timeout: 15_000 });
    await parentRow.click();
    await noHistory.waitForURL((url) => url.searchParams.get("child") === "root:2");
    await noHistory.getByRole("heading", { name: /reviewer/ }).waitFor();
    await noHistory.getByText("read-only: follow-ups are available from the controller connection", { exact: true }).waitFor();
    const unavailable = noHistory.getByText("this zeta version cannot show the child transcript yet", { exact: true });
    await unavailable.waitFor();
    if (await unavailable.getAttribute("role") !== "status") throw new Error("observer no-history note was not neutral");
    if (await noHistory.getByLabel("child follow-up").count()) throw new Error("observer no-history child exposed its composer");
    const noHistoryRequests = fake.requests.slice(noHistoryStart).filter(({ method }) => method === "child_run_send" || method === "child_run_history");
    if (noHistoryRequests.length) throw new Error(`observer no-history child made requests: ${noHistoryRequests.map(({ method }) => method).join(", ")}`);
    await noHistory.close();
    fake.setChildRunHistoryEnabled(true);

    // Zeta origin/main src/zeta/server/handlers/lifecycle.py:178-209 (#1218): status gives an observer the controller's
    // pending_approvals rows; approve and deny stay controller-only (-32008, protocol.py:116-118).
    fake.attachQuietly(ACTIVE);
    const approvalStart = fake.requests.length;
    const watcher = await context.newPage();
    await watcher.goto(`${origin}/?run=${ACTIVE}`);
    await ready(watcher);
    const assertReadOnlyApproval = async (page: Page, how: string) => {
      const card = page.locator('[data-part="approval"][data-state="pending"]');
      await card.waitFor({ timeout: 15_000 });
      await page.locator(".observer-approval").filter({ has: card }).getByText("waiting for the controller to approve", { exact: true }).waitFor();
      if (await page.getByRole("button", { name: /approve|deny|always allow/ }).count()) throw new Error(`observer ${how} approval offered a decision button`);
      await card.focus();
      for (const key of ["Enter", " ", "y", "a", "n", "d"]) await page.keyboard.press(key);
    };
    await assertReadOnlyApproval(watcher, "live");
    await watcher.locator(".status-line").getByText("waiting for the controller to approve", { exact: true }).waitFor();
    if (screenshots) { await Bun.sleep(400); await watcher.screenshot({ path: join(screenshots, `observer-approval-${browserName}-${width}.png`), fullPage: true }); }
    const baseline = await context.newPage();
    await baseline.goto(`${origin}/?run=${ACTIVE}`);
    await ready(baseline);
    await assertReadOnlyApproval(baseline, "status baseline");
    await Bun.sleep(300);
    const approvalWrites = fake.requests.slice(approvalStart).filter(({ method }) => mutatingMethods.includes(method as typeof mutatingMethods[number]));
    if (approvalWrites.length) throw new Error(`observer approval made mutating calls: ${approvalWrites.map(({ method }) => method).join(", ")}`);
    await watcher.close();
    await baseline.close();
    // The controller still decides, which also ends the held turn so the next row starts clean.
    fake.setMode("ok");
    const decider = await context.newPage();
    await decider.goto(`${origin}/?run=${ACTIVE}`);
    await decider.getByRole("button", { name: "deny", exact: true }).click({ timeout: 15_000 });
    for (let attempt = 0; fake.running && attempt < 100; attempt++) await Bun.sleep(100);
    if (fake.running) throw new Error("controller deny did not end the approval turn");
    await decider.close();
    fake.resetSeededApproval();

    fake.setMode("observer-limit");
    const limitStart = fake.requests.length;
    const limited = await context.newPage();
    await limited.goto(`${origin}/?run=${runId}`);
    await ready(limited);
    await limited.getByText("observer limit reached", { exact: true }).waitFor({ timeout: 15_000 });
    const beforeWait = fake.requests.slice(limitStart).filter(({ method }) => method === "hello").length;
    await Bun.sleep(1_200);
    const afterWait = fake.requests.slice(limitStart).filter(({ method }) => method === "hello").length;
    if (beforeWait !== 2 || afterWait !== 2) throw new Error(`observer limit made ${afterWait} hello attempts instead of waiting after 2`);
    await limited.getByRole("button", { name: "retry now" }).click();
    for (let attempt = 0; attempt < 50 && fake.requests.slice(limitStart).filter(({ method }) => method === "hello").length < 3; attempt++) await Bun.sleep(100);
    const afterRetry = fake.requests.slice(limitStart).filter(({ method }) => method === "hello");
    if (afterRetry.length !== 3 || afterRetry[2]?.params.role !== "observer") throw new Error("explicit retry did not make one observer hello attempt");
    await limited.close();

    fake.setMode("ok");
    fake.attachQuietly(runId);
    const controllerStart = fake.requests.length;
    const controller = await context.newPage();
    await controller.goto(`${origin}/?run=${runId}`);
    await controller.locator('.dock textarea[aria-label="message"]').waitFor({ timeout: 15_000 });
    if (await controller.getByText("observing", { exact: true }).count()) throw new Error("controller view showed the observer badge");
    if (screenshots) { await controller.locator('.dock [data-part="composer-submit"]').waitFor(); await Bun.sleep(400); await controller.screenshot({ path: join(screenshots, `controller-run-${browserName}-${width}.png`), fullPage: true }); }
    const composer = controller.locator('.dock textarea[aria-label="message"]');
    await submit(controller, "controller send remains enabled");
    for (let attempt = 0; attempt < 50 && !fake.requests.slice(controllerStart).some(({ method }) => method === "send"); attempt++) await Bun.sleep(100);
    if (!fake.requests.slice(controllerStart).some(({ method }) => method === "send")) throw new Error("controller could not send");
    for (let attempt = 0; fake.running && attempt < 200; attempt++) await Bun.sleep(100);
    if (fake.running) throw new Error("controller turn did not finish before transition setup");

    fake.setHoldTurns(true);
    await submit(controller, "hold for observer transition");
    await controller.getByRole("button", { name: "stop the running turn" }).waitFor({ timeout: 15_000 });
    await submit(controller, "dropped before observer transition");
    await controller.getByRole("button", { name: "stop the running turn" }).click();
    await controller.getByRole("button", { name: "resend" }).waitFor({ timeout: 15_000 });
    fake.setHoldTurns(false);
    await submit(controller, "fail this turn before observer transition");
    await controller.getByRole("button", { name: "retry" }).waitFor({ timeout: 15_000 });
    await composer.fill("draft kept across observer transition");
    await Bun.sleep(200);
    const savedDraft = await controller.evaluate(() => sessionStorage.getItem("gamma-run-drafts"));
    if (!savedDraft?.includes("draft kept across observer transition")) throw new Error("transition setup did not persist the draft");

    fake.setMode("controller-busy");
    fake.drop();
    await controller.getByText("observing", { exact: true }).waitFor({ timeout: 15_000 });
    const transitionStart = fake.requests.length;
    if (await controller.getByRole("button", { name: "resend" }).count()) throw new Error("observer transition kept a resend action");
    if (await controller.getByRole("button", { name: "retry" }).count()) throw new Error("observer transition kept a retry action");
    if (await controller.locator('.dock textarea[aria-label="message"]').count()) throw new Error("observer transition kept an editable composer");
    await Bun.sleep(500);
    const transitionMutations = fake.requests.slice(transitionStart).filter(({ method }) => mutatingMethods.includes(method as typeof mutatingMethods[number]));
    if (transitionMutations.length) throw new Error(`observer transition reconciled with mutations: ${transitionMutations.map(({ method }) => method).join(", ")}`);
    const observedDraft = await controller.evaluate(() => sessionStorage.getItem("gamma-run-drafts"));
    if (observedDraft !== savedDraft) throw new Error("observer transition changed the saved draft");
    await controller.close();
    fake.setMode("ok");
  } finally {
    await context.close();
    await browser.close();
  }
}

try {
  for (const [type, name] of [[chromium, "chromium"], [webkit, "webkit"]] as const) {
    if (process.env.OBSERVER_GATE_BROWSER && process.env.OBSERVER_GATE_BROWSER !== name) continue;
    for (const width of process.env.OBSERVER_GATE_WIDTH ? [Number(process.env.OBSERVER_GATE_WIDTH)] : [1440, 390]) {
      await check(`${name} observer mode at ${width}`, () => matrix(type, name, width));
    }
  }
} finally {
  vite.kill("SIGTERM");
  await fake.stop();
  await fake.close();
  await rm(gammaHome, { recursive: true, force: true });
}
if (failures.length) throw new Error(`${failures.length} observer gate failure(s)\n${failures.join("\n")}`);
console.log(`observer gate: ${passed} rows passed`);
