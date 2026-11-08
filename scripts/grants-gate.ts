import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { themes } from "@fulcrum/react";
import { createClient, webSocketTransport } from "@fulcrum/zeta";
import { ACTIVE, startFakeZeta } from "./fake-zeta";

const source = process.env.GAMMA_PROOF_APP ?? new URL("..", import.meta.url).pathname;
const portText = process.env.WEB_COMMAND_GATE_PORT ?? "4197";
if (!/^\d+$/.test(portText)) throw new Error("WEB_COMMAND_GATE_PORT must be an integer");
const port = Number(portText);
if (port < 1 || port > 65_535 || port === 5190 || port === 8765) throw new Error("WEB_COMMAND_GATE_PORT is outside the allowed disposable range");
const origin = `http://127.0.0.1:${port}`;
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-grants-gate-"));
const fake = await startFakeZeta({ origins: [origin], port: 0, live: false, sessionGrants: true });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: source, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) }, stdio: ["ignore", "pipe", "pipe"] });
const viteLog: string[] = [];
vite.stdout?.on("data", (data) => viteLog.push(String(data)));
vite.stderr?.on("data", (data) => viteLog.push(String(data)));

try {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (vite.exitCode !== null) throw new Error(`vite exited ${vite.exitCode}: ${viteLog.join("").slice(-3000)}`);
    if (await fetch(origin).then((response) => response.ok, () => false)) break;
    if (attempt === 299) throw new Error(`vite did not start: ${viteLog.join("").slice(-3000)}`);
    await Bun.sleep(100);
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && !/WebSocket connection/.test(message.text())) browserErrors.push(message.text()); });
    page.on("response", (response) => { if (response.status() >= 400) browserErrors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    await page.goto(`${origin}/?run=${ACTIVE}`);
    const control = page.getByRole("button", { name: /^permissions/ });
    await control.waitFor({ timeout: 15_000 }).catch(async () => { throw new Error(`zero-grant permissions control missing; body=${await page.locator("body").innerText()}`); });
    if (await control.locator(".permissions-count").count()) throw new Error("zero-grant control showed a count badge");

    const reads = () => fake.requests.filter((request) => request.method === "session_grants").length;
    const beforeEvent = reads();
    fake.changeSessionGrants(ACTIVE, ["bash"], "grant");
    await page.getByRole("button", { name: /permissions: 1 session grant/ }).waitFor();
    await control.locator(".permissions-count").filter({ hasText: /^1$/ }).waitFor({ timeout: 5_000 }).catch(() => { throw new Error("one grant did not show the visible count badge 1"); });
    if (reads() !== beforeEvent) throw new Error("grant event triggered an unnecessary session_grants read");
    await control.click();
    const dialog = page.getByRole("dialog", { name: "session permissions" });
    await dialog.getByText("bash", { exact: true }).waitFor();

    fake.changeSessionGrants("other-session", [], "revoke");
    await page.waitForTimeout(100);
    if (!await dialog.getByText("bash", { exact: true }).count()) throw new Error("another session's event replaced the viewed grants");

    const revokeStart = fake.requests.length;
    await dialog.getByRole("button", { name: "revoke" }).click();
    await page.getByRole("button", { name: "permissions", exact: true }).waitFor();
    const revokeCalls = fake.requests.slice(revokeStart).filter((request) => request.method === "revoke_session_grants");
    if (revokeCalls.length !== 1 || JSON.stringify(revokeCalls[0]!.params) !== JSON.stringify({ grant: "bash" })) throw new Error(`revoke used wrong params: ${JSON.stringify(revokeCalls)}`);
    if (await dialog.getByRole("button", { name: "revoke" }).count()) throw new Error("last revoke left a revoke button");
    if (await dialog.locator("h2").evaluate((node) => document.activeElement === node) !== true) throw new Error("last revoke did not focus the popover heading");

    fake.changeSessionGrants(ACTIVE, ["bash", "read"], "grant");
    await page.getByRole("button", { name: "clear all" }).waitFor();
    const clearStart = fake.requests.length;
    await page.getByRole("button", { name: "clear all" }).click();
    await page.waitForTimeout(100);
    if (fake.requests.slice(clearStart).some((request) => request.method === "revoke_session_grants")) throw new Error("first clear-all click sent a request");
    await page.getByRole("button", { name: "confirm clear" }).waitFor();
    await page.getByRole("button", { name: "confirm clear" }).click();
    const clearCalls = fake.requests.slice(clearStart).filter((request) => request.method === "revoke_session_grants");
    if (clearCalls.length !== 1 || JSON.stringify(clearCalls[0]!.params) !== JSON.stringify({ clear: true })) throw new Error(`confirmed clear used wrong params: ${JSON.stringify(clearCalls)}`);

    await control.click();
    fake.changeSessionGrants(ACTIVE, ["bash", "read"], "grant");
    const field = page.getByRole("combobox", { name: "message" });
    const typedStart = fake.requests.length;
    await field.fill("/permissions clear");
    await field.press("Enter");
    if ((await field.inputValue()).trim()) await field.press("Enter");
    await page.getByText("permissions · session grants cleared: bash, read", { exact: true }).waitFor();
    const typedCalls = fake.requests.slice(typedStart).filter((request) => request.method === "revoke_session_grants");
    if (typedCalls.length !== 1 || JSON.stringify(typedCalls[0]!.params) !== JSON.stringify({ clear: true })) throw new Error(`typed clear did not act once: ${JSON.stringify(typedCalls)}`);

    await page.getByRole("button", { name: "dismiss command result" }).click();
    await field.fill("/permissions");
    await field.press("Enter");
    if ((await field.inputValue()).trim()) await field.press("Enter");
    await dialog.waitFor();
    await page.waitForFunction(() => document.activeElement?.matches(".permissions-popover h2"), undefined, { timeout: 5_000 }).catch(() => { throw new Error("typed /permissions did not focus the popover heading"); });

    // a reconnect remounts the control; the earlier typed request must not reopen it or move focus
    await page.getByRole("button", { name: "close permissions" }).click();
    await field.click();
    fake.drop();
    await control.waitFor({ state: "detached", timeout: 15_000 });
    await control.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(300);
    if (await dialog.count()) throw new Error("reconnect reopened the permissions popover without a new request");
    if (await page.evaluate(() => document.activeElement?.matches(".permissions-popover h2") ?? false)) throw new Error("reconnect moved focus to the permissions heading");
    if (await field.evaluate((node) => document.activeElement !== node)) throw new Error(`reconnect moved focus away from the composer: ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))}`);

    await page.goto(origin);
    await page.getByRole("button", { name: "new run" }).click();
    await field.waitFor();
    const detachedStart = fake.requests.length;
    await field.fill("/permissions");
    await field.press("Enter");
    if ((await field.inputValue()).trim()) await field.press("Enter");
    await page.getByText("open this run before changing permissions", { exact: true }).waitFor();
    if (fake.requests.slice(detachedStart).some((request) => request.method === "slash_run")) throw new Error("detached /permissions reached zeta");

    for (const width of [1440, 1024, 390]) for (const theme of themes) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${origin}/?run=${ACTIVE}&theme=${encodeURIComponent(theme)}`);
      await page.getByRole("button", { name: /^permissions/ }).click();
      const box = await page.getByRole("dialog", { name: "session permissions" }).boundingBox();
      if (!box || box.x < 0 || box.y < 0 || box.x + box.width > width || box.y + box.height > 800) throw new Error(`${theme} at ${width}px put the permissions popover outside the viewport: ${JSON.stringify(box)}`);
    }

    const discovery = JSON.parse(await readFile(join(fake.home, "run", "serve.ws.json"), "utf8")) as { port: number; observer_token: string };
    const observerTransport = await webSocketTransport(`ws://127.0.0.1:${discovery.port}/`, ["zeta.v1", `zeta.bearer.${discovery.observer_token}`]);
    const observer = createClient(observerTransport);
    await observer.hello(["session_grants"], "observer");
    const observerError = await observer.request("revoke_session_grants", { grant: "bash" }).then(() => null, (error) => error as { code?: unknown });
    observer.close();
    if (observerError?.code !== -32008) throw new Error(`observer revoke did not return -32008: ${String(observerError?.code)}`);

    const helloCount = fake.requests.filter((request) => request.method === "hello").length;
    fake.setSessionGrantsEnabled(false);
    fake.drop();
    await page.getByRole("button", { name: /^permissions/ }).waitFor({ state: "detached", timeout: 15_000 });
    for (let attempt = 0; attempt < 150 && fake.requests.filter((request) => request.method === "hello").length <= helloCount; attempt++) await Bun.sleep(100);
    await page.getByPlaceholder("message zeta").waitFor({ timeout: 15_000 });
    if (await page.getByRole("button", { name: /^permissions/ }).count()) throw new Error("permissions control remained visible without the negotiated session_grants feature");
    await field.fill("/permissions");
    await field.press("Enter");
    if ((await field.inputValue()).trim()) await field.press("Enter");
    await page.getByText("permissions need a newer zeta server", { exact: true }).waitFor();

    if (browserErrors.length) throw new Error(`browser errors: ${browserErrors.join(" | ")}`);
    console.log(`session grants gate passed: zero state, live events, exact revoke/clear params, typed commands, focus, observer fixture, ${themes.length} themes at 1440/1024/390`);
  } finally { await browser.close(); }
} finally {
  vite.kill("SIGTERM");
  await fake.close();
  await rm(gammaHome, { recursive: true, force: true });
}
