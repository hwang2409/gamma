import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium, type Browser } from "playwright";
import { createClient, webSocketTransport } from "@fulcrum/zeta";
import { OwnedResources } from "./owned-resources";
import { assertPrivateProofHome } from "./proof-home";

// This checkout, from the script location, so the gate runs from any gamma worktree or main.
const gamma = new URL("..", import.meta.url).pathname;
const zeta = "/Users/henry/me/fun/zeta";
const worktree = process.env.ZETA_PROOF_WORKTREE;
const ref = process.env.ZETA_PROOF_REF;
const portText = process.env.WEB_REAL_ZETA_GATE_PORT ?? "4196";
if (!ref || !/^[0-9a-f]{40}$/.test(ref)) throw new Error("ZETA_PROOF_REF must be an exact 40-character sha");
const planProof = ref === "3e1f48a39cc5a08e4814b91d0ecaa44dba17e489";
const keysProof = ref === "8389c6e90af7fa6c26f1fa1c8eab2470244b27a5";
const requiredWorktree = `${zeta}/.worktrees/${keysProof ? "parity-g5k-proof" : "parity-g3-proof"}`;
if (worktree !== requiredWorktree) throw new Error(`ZETA_PROOF_WORKTREE must be ${requiredWorktree}`);
if (!planProof && !keysProof && ref !== "37622b5eb6716526fb315e766ca33c915ac5ce92") throw new Error("ZETA_PROOF_REF must be a pinned parity proof sha");
if (!/^\d+$/.test(portText)) throw new Error("WEB_REAL_ZETA_GATE_PORT must be an integer");
const appPort = Number(portText);
if (appPort < 1 || appPort > 65_535 || appPort === 5190 || appPort === 8765) throw new Error("WEB_REAL_ZETA_GATE_PORT is outside the allowed disposable range");
if (await stat(worktree).then(() => true, () => false)) throw new Error(`proof worktree already exists: ${worktree}`);
const portProbe = Bun.listen({ hostname: "127.0.0.1", port: appPort, socket: { open() {}, data() {}, close() {} } });
portProbe.stop(true);
const origin = `http://127.0.0.1:${appPort}`;
const resources = new OwnedResources();
let browser: Browser | null = null;
const logs = new Map<ChildProcess, string[]>();

const child = (command: string, args: string[], options: Parameters<typeof spawn>[2] = {}) => {
  const process = resources.child(spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] }));
  const lines: string[] = []; logs.set(process, lines);
  process.stdout?.on("data", (data) => lines.push(String(data)));
  process.stderr?.on("data", (data) => lines.push(String(data)));
  return process;
};
const waitExit = (process: ChildProcess, label: string) => new Promise<void>((resolve, reject) => {
  process.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${label} exited ${code}: ${(logs.get(process) ?? []).join("").slice(-4000)}`)));
  process.once("error", reject);
});
const run = async (command: string, args: string[], label: string, cwd = gamma, env = process.env) => {
  const process = child(command, args, { cwd, env }); await waitExit(process, label); return (logs.get(process) ?? []).join("");
};
const waitFile = async (path: string, owner?: ChildProcess) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text) return text;
    if (owner?.exitCode !== null) throw new Error(`owner exited ${owner.exitCode} before ${path}: ${(logs.get(owner) ?? []).join("").slice(-4000)}`);
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${path}: ${(owner ? logs.get(owner) : [])?.join("").slice(-4000)}`);
};

const temp = await mkdtemp(join(tmpdir(), "g4-")); resources.createdTemp(temp);
const zetaHome = assertPrivateProofHome(join(temp, "zeta-home"), requiredWorktree);
if (await stat(zetaHome).then(() => true, () => false)) throw new Error(`real-zeta proof home was not fresh: ${zetaHome}`);
const proofEnv = { ...process.env, ZETA_HOME: zetaHome, ZETA_PLAN_PROOF: planProof ? "1" : "0" };

try {
  await run("git", ["-C", zeta, "worktree", "add", "--detach", worktree, ref], "git worktree add", gamma, proofEnv);
  resources.createdWorktree(worktree);
  const actual = (await Bun.file(join(worktree, ".git")).text()).trim();
  if (!actual) throw new Error("detached proof worktree has no git marker");
  const actualSha = (await run("git", ["rev-parse", "HEAD"], "verify proof sha", worktree, proofEnv)).trim();
  if (actualSha !== ref) throw new Error(`proof worktree is ${actualSha}, expected ${ref}`);
  await run("uv", ["sync", "--frozen"], "uv sync", worktree, proofEnv);
  await run("uv", ["build"], "uv build", worktree, proofEnv);

  const gammaHome = join(temp, "gamma-home");
  const cwd = join(temp, "cwd");
  const control = join(temp, "control.json");
  const skill = join(zetaHome, "skills", "review", "SKILL.md");
  await Promise.all([mkdir(dirname(skill), { recursive: true }), mkdir(gammaHome), mkdir(cwd)]);
  await writeFile(skill, "---\nname: review\ndescription: run the private real proof\nkeywords: [review]\n---\n\nREAL_ZETA_HIDDEN_SKILL_TEXT_7d91\n", "utf8");

  const python = child("uv", ["run", "--project", worktree, "python", join(gamma, "scripts", "real-zeta-server.py")], {
    cwd: worktree,
    env: { ...proofEnv, PYTHONPATH: worktree, ZETA_PROOF_WORKTREE: worktree, ZETA_PROOF_CWD: cwd, ZETA_PROOF_CONTROL: control, ZETA_PROOF_ORIGIN: origin },
  });
  const discovery = JSON.parse(await waitFile(control, python)) as { port: number; token: string; pending_session: string };
  if (python.exitCode !== null) throw new Error(`real zeta exited during startup: ${(logs.get(python) ?? []).join("")}`);

  const transport = await webSocketTransport(`ws://127.0.0.1:${discovery.port}/`, ["zeta.v1", `zeta.bearer.${discovery.token}`]);
  const seed = createClient(transport);
  await seed.hello(["model_input_ids", "delivery_id"], "controller");
  const created = await seed.request("new_session", {}) as { session: { session_id: string } };
  await seed.request("resume", { session_id: discovery.pending_session });
  const pendingStatus = await seed.request("status", {}) as { state?: unknown; pending_approvals?: unknown };
  if (pendingStatus.state !== "idle" || !Array.isArray(pendingStatus.pending_approvals) || pendingStatus.pending_approvals.length !== 0) throw new Error(`seeded pending-tool session is not idle without approvals: ${JSON.stringify(pendingStatus)}`);
  transport.close();
  await Bun.sleep(250);

  const vite = child("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(appPort), "--strictPort"], {
    cwd: gamma,
    env: { ...proofEnv, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin },
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (vite.exitCode !== null) throw new Error(`vite exited during startup: ${(logs.get(vite) ?? []).join("")}`);
    if (await fetch(origin).then((response) => response.ok, () => false)) break;
    await Bun.sleep(100);
    if (attempt === 199) throw new Error("vite did not start");
  }

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
  const errors: string[] = [];
  const frames: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("websocket", (socket) => {
    socket.on("framesent", (event) => frames.push(String(event.payload)));
    socket.on("framereceived", (event) => frames.push(String(event.payload)));
  });
  await page.goto(`${origin}/?run=${created.session.session_id}`);
  const field = page.getByRole("combobox", { name: "message" });
  await field.waitFor({ timeout: 20_000 }).catch(async () => { throw new Error(`composer did not open; browser=${errors.join(" | ")}; body=${await page.locator("body").innerText()}; vite=${(logs.get(vite) ?? []).join("").slice(-3000)}; zeta=${(logs.get(python) ?? []).join("").slice(-3000)}`); });
  const submit = async (text: string) => { await field.fill(text); await field.press("Enter"); if ((await field.inputValue()).trim() === text) await field.press("Enter"); };
  const navigateRun = async (run: string) => page.evaluate((nextRun) => {
    history.pushState({ run: nextRun }, "", `/?run=${encodeURIComponent(nextRun)}`);
    dispatchEvent(new PopStateEvent("popstate", { state: { run: nextRun } }));
  }, run);

  for (let attempt = 0; attempt < 200 && !frames.some((frame) => frame.includes('"name":"review"')); attempt++) await Bun.sleep(100);
  const review = page.getByRole("option", { name: /review/ });
  for (let attempt = 0; attempt < 20 && !(await review.isVisible().catch(() => false)); attempt++) {
    await field.fill("");
    await field.fill("/rev");
    await Bun.sleep(250);
  }
  await review.waitFor({ timeout: 5_000 });
  await field.fill("");
  await field.press("Escape");
  await submit("/status");
  await page.locator(".command-receipt").waitFor({ timeout: 30_000 }).catch(async () => { throw new Error(`status receipt missing; value=${await field.inputValue()}; body=${await page.locator("body").innerText()}; frames=${frames.join("\n").slice(-6000)}`); });
  await page.getByRole("button", { name: "dismiss command result" }).click();
  if (!frames.some((frame) => frame.includes('"model_input_ids"'))) throw new Error("hello did not echo model_input_ids");
  if (!frames.some((frame) => frame.includes('"name":"review"'))) throw new Error("slash_list omitted the private review skill");

  if (planProof) {
  for (const [command, output, chip] of [["/plan", "plan mode: on", true], ["/plan off", "plan mode: off", false], ["/plan on", "plan mode: on", true], ["/plan toggle", "plan mode: off", false]] as const) {
    const settingsBefore = frames.filter((frame) => frame.includes('"method":"session_settings"')).length;
    await submit(command);
    await page.locator(".command-receipt-text", { hasText: output }).waitFor({ timeout: 10_000 });
    if ((await page.locator(".plan-chip").count() > 0) !== chip) throw new Error(`${command} left the wrong real-zeta plan chip state`);
    const settingsAfter = frames.filter((frame) => frame.includes('"method":"session_settings"')).length;
    if (settingsAfter !== settingsBefore + 1) throw new Error(`${command} did not refresh real settings exactly once`);
    await page.getByRole("button", { name: "dismiss command result" }).click();
  }
  for (const [command, chip] of [["/plan create a proof", true], ["/implement", false]] as const) {
    const beforeCommand = frames.length;
    await submit(command);
    for (let attempt = 0; attempt < 200 && !frames.slice(beforeCommand).some((frame) => frame.includes('"method":"send"')); attempt++) await Bun.sleep(50);
    const commandFrames = frames.slice(beforeCommand).map((frame) => { try { return JSON.parse(frame); } catch { return null; } });
    const sends = commandFrames.filter((frame) => frame?.method === "send");
    if (!commandFrames.some((frame) => frame?.method === "slash_run") || sends.length !== 1 || typeof sends[0]?.params?.input_id !== "string" || "text" in sends[0].params) throw new Error(`${command} did not use one opaque real-zeta send: ${JSON.stringify(commandFrames)}`);
    if ((await page.locator(".plan-chip").count() > 0) !== chip) throw new Error(`${command} left the wrong real-zeta plan chip state`);
    await page.getByPlaceholder("message zeta").waitFor({ timeout: 15_000 });
  }
  }

  await field.fill("");
  const before = frames.length;
  await field.fill("/review real proof");
  await field.press("Escape");
  await field.press("Enter");
  for (let attempt = 0; attempt < 300 && !frames.slice(before).some((frame) => frame.includes('"event":"approval_request"')); attempt++) await Bun.sleep(100);
  const scroll = page.locator(".scroll:visible");
  await scroll.hover();
  await page.mouse.wheel(0, -2_000);
  const jump = page.getByText(/^jump to approval:/);
  await jump.waitFor({ timeout: 30_000 });
  await jump.focus();
  await jump.press("Enter");
  const approval = page.getByRole("button", { name: "always allow" });
  await approval.waitFor({ timeout: 5_000 }).catch(async () => { throw new Error(`approval did not render; body=${await page.locator("body").innerText()}; frames=${frames.slice(before).join("\n").slice(-6000)}; zeta=${(logs.get(python) ?? []).join("").slice(-4000)}`); });
  if (planProof) {
    const busySettings = frames.filter((frame) => frame.includes('"method":"session_settings"')).length;
    await field.fill("/plan");
    await field.press("Escape");
    await field.press("Enter");
    await page.getByText(/\/plan waits until this turn ends; your draft is kept/).waitFor({ timeout: 10_000 });
    if ((await field.inputValue()).trim() !== "/plan") throw new Error("real active-turn refusal lost the plan draft");
    if (frames.filter((frame) => frame.includes('"method":"session_settings"')).length !== busySettings) throw new Error("real busy /plan refreshed settings");
    await page.getByRole("button", { name: "jump to approval", exact: true }).click();
  }
  const proofFrames = frames.slice(before);
  if (proofFrames.some((frame) => frame.includes("REAL_ZETA_HIDDEN_SKILL_TEXT_7d91")) || (await page.locator("body").innerText()).includes("REAL_ZETA_HIDDEN_SKILL_TEXT_7d91")) throw new Error("hidden skill text escaped onto the wire or DOM");
  const sends = proofFrames.map((frame) => { try { return JSON.parse(frame); } catch { return null; } }).filter((frame) => frame?.method === "send");
  if (sends.length !== 1 || typeof sends[0]?.params?.input_id !== "string" || "text" in sends[0].params) throw new Error(`opaque proof sent the wrong shape: ${JSON.stringify(sends)}`);
  if ((await page.locator("body").innerText()).includes(sends[0].params.input_id)) throw new Error("opaque id reached the DOM");

  await approval.click();
  await approval.waitFor({ state: "detached", timeout: 20_000 });
  const approvals = frames.map((frame) => { try { return JSON.parse(frame); } catch { return null; } }).filter((frame) => frame?.method === "approve");
  if (approvals.length !== 1 || approvals[0].params?.scope !== "always_tool") throw new Error(`wrong approval scope: ${JSON.stringify(approvals)}`);
  if (planProof) {
    await page.getByPlaceholder("message zeta").waitFor({ timeout: 20_000 });
    await navigateRun(discovery.pending_session);
    await page.getByText("pending proof", { exact: true }).waitFor({ timeout: 20_000 });
    const pendingImage = join(temp, "pending-proof.png");
    await writeFile(pendingImage, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    await page.locator('input[type="file"]').setInputFiles(pendingImage);
    await page.locator('[data-part="attachment"]').waitFor({ timeout: 5_000 });
    const pendingBefore = frames.length;
    await field.fill("/plan");
    await field.press("Escape");
    await page.getByRole("button", { name: "send message", exact: true }).click();
    const pendingReceipt = page.locator(".command-receipt-text");
    const expectedPendingReceipt = "commands wait for pending work to finish: tools, approvals, or background agents\nattachments are still attached and were not sent.";
    try {
      await pendingReceipt.waitFor({ timeout: 10_000 });
    } catch (error) {
      throw new Error(`pending command refusal missing; value=${JSON.stringify(await field.inputValue())}; body=${JSON.stringify((await page.locator("body").innerText()).slice(0, 2000))}; frames=${frames.slice(pendingBefore).join("\n").slice(-3000)}; cause=${String(error)}`);
    }
    if ((await pendingReceipt.innerText()).trim() !== expectedPendingReceipt) throw new Error(`pending-work refusal used the wrong exact wording: ${JSON.stringify(await pendingReceipt.innerText())}`);
    if ((await field.inputValue()).trim() !== "/plan") throw new Error("real pending-work refusal lost the plan draft");
    if (await page.locator('[data-part="attachment"]').count() !== 1) throw new Error("real pending-work refusal lost its attachment");
    if (await page.getByRole("button", { name: "jump to approval", exact: true }).count()) throw new Error("idle pending-work refusal exposed jump to approval");
    if ((await pendingReceipt.innerText()).includes("this turn ends")) throw new Error("idle pending-work refusal used active-turn wording");
    if (await page.locator(".plan-chip").count()) throw new Error("refused pending-work /plan changed plan mode");
    const pendingFrames = frames.slice(pendingBefore).map((frame) => { try { return JSON.parse(frame); } catch { return null; } });
    const slashIndex = pendingFrames.findIndex((frame) => frame?.method === "slash_run");
    const routeFrames = slashIndex < 0 ? [] : pendingFrames.slice(slashIndex);
    const pendingMethods = routeFrames.filter((frame) => frame?.method).map((frame) => frame.method);
    const slashFrame = routeFrames.find((frame) => frame?.method === "slash_run");
    const refusalFrame = routeFrames.find((frame) => frame?.id === slashFrame?.id && frame?.error);
    if (pendingMethods.filter((method) => method === "slash_run").length !== 1 || slashFrame?.params?.session_id !== discovery.pending_session || slashFrame?.params?.text !== "/plan" || refusalFrame?.error?.code !== -32004 || refusalFrame?.error?.message !== "finish pending tools and background agents first" || pendingMethods.some((method) => method === "session_settings" || method === "send" || method === "steer")) throw new Error(`pending-work plan used the wrong route: ${JSON.stringify(routeFrames)}`);
  }
  if (errors.length) throw new Error(`browser errors: ${errors.join(" | ")}`);
  console.log(`real zeta gate passed: ${ref}; private home ${zetaHome}; model_input_ids, slash_list, /status, opaque send, hidden-text, approval always_tool${planProof ? ", plan idle/active/pending" : ""}`);
} finally {
  await browser?.close().catch(() => {});
  await resources.cleanup(
    (path) => rm(path, { recursive: true, force: true }),
    async (path) => { await run("git", ["-C", zeta, "worktree", "remove", "--force", path], "git worktree remove"); },
  );
  console.log("real zeta cleanup passed: recorded children closed; private temp root and detached proof worktree removed");
}
