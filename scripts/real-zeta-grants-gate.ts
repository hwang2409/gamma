import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createClient, webSocketTransport } from "@fulcrum/zeta";
import { OwnedResources } from "./owned-resources";
import { assertPrivateProofHome } from "./proof-home";

const gamma = new URL("..", import.meta.url).pathname;
const zeta = "/Users/henry/me/fun/zeta";
const worktree = `${zeta}/.worktrees/parity-g4b-proof`;
const ref = process.env.ZETA_PROOF_REF;
const requiredRef = "473784f598fe387d3e9db4dabb4d2c0ccceccea5";
if (ref !== requiredRef) throw new Error(`ZETA_PROOF_REF must be pinned to ${requiredRef}`);
if (await stat(worktree).then(() => true, () => false)) throw new Error(`proof worktree already exists: ${worktree}`);
const portText = process.env.WEB_REAL_ZETA_GATE_PORT ?? "4196";
if (!/^\d+$/.test(portText)) throw new Error("WEB_REAL_ZETA_GATE_PORT must be an integer");
const appPort = Number(portText);
if (appPort < 1 || appPort > 65_535 || appPort === 5190 || appPort === 8765) throw new Error("WEB_REAL_ZETA_GATE_PORT is outside the allowed disposable range");
const origin = `http://127.0.0.1:${appPort}`;
const resources = new OwnedResources();
const logs = new Map<ChildProcess, string[]>();
const child = (command: string, args: string[], options: Parameters<typeof spawn>[2] = {}) => {
  const process = resources.child(spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] }));
  const output: string[] = []; logs.set(process, output);
  process.stdout?.on("data", (data) => output.push(String(data)));
  process.stderr?.on("data", (data) => output.push(String(data)));
  return process;
};
const waitExit = (process: ChildProcess, label: string) => new Promise<void>((resolve, reject) => {
  process.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${label} exited ${code}: ${(logs.get(process) ?? []).join("").slice(-4000)}`)));
  process.once("error", reject);
});
const run = async (command: string, args: string[], label: string, cwd = gamma, env = process.env) => {
  const process = child(command, args, { cwd, env }); await waitExit(process, label); return (logs.get(process) ?? []).join("");
};
const waitFile = async (path: string, owner: ChildProcess) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text) return text;
    if (owner.exitCode !== null) throw new Error(`owner exited ${owner.exitCode} before ${path}: ${(logs.get(owner) ?? []).join("").slice(-4000)}`);
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${path}`);
};

const temp = await mkdtemp(join(tmpdir(), "gamma-g4b-real-"));
resources.createdTemp(temp);
const zetaHome = assertPrivateProofHome(join(temp, "zeta-home"), worktree);
const proofEnv = { ...process.env, ZETA_HOME: zetaHome, ZETA_GRANTS_PROOF: "1" };
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
try {
  await run("git", ["-C", zeta, "worktree", "add", "--detach", worktree, ref], "git worktree add", gamma, proofEnv);
  resources.createdWorktree(worktree);
  const actual = (await run("git", ["rev-parse", "HEAD"], "verify proof sha", worktree, proofEnv)).trim();
  if (actual !== ref) throw new Error(`proof worktree is ${actual}, expected ${ref}`);
  await run("uv", ["sync", "--frozen"], "uv sync", worktree, proofEnv);

  const cwd = join(temp, "cwd");
  const gammaHome = join(temp, "gamma-home");
  const control = join(temp, "control.json");
  await Promise.all([mkdir(cwd), mkdir(gammaHome)]);
  const server = child("uv", ["run", "--project", worktree, "python", join(gamma, "scripts", "real-zeta-server.py")], {
    cwd: worktree,
    env: { ...proofEnv, PYTHONPATH: worktree, ZETA_PROOF_WORKTREE: worktree, ZETA_PROOF_CWD: cwd, ZETA_PROOF_CONTROL: control, ZETA_PROOF_ORIGIN: origin },
  });
  const discovery = JSON.parse(await waitFile(control, server)) as { port: number; token: string };
  const transport = await webSocketTransport(`ws://127.0.0.1:${discovery.port}/`, ["zeta.v1", `zeta.bearer.${discovery.token}`]);
  const seed = createClient(transport);
  await seed.hello(["session_grants"], "controller");
  const created = await seed.request("new_session", {}) as { session: { session_id: string } };
  seed.close();
  await Bun.sleep(250);

  const vite = child("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(appPort), "--strictPort"], { cwd: gamma, env: { ...proofEnv, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin } });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (vite.exitCode !== null) throw new Error(`vite exited during startup: ${(logs.get(vite) ?? []).join("").slice(-3000)}`);
    if (await fetch(origin).then((response) => response.ok, () => false)) break;
    if (attempt === 199) throw new Error("vite did not start");
    await Bun.sleep(100);
  }

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
  const frames: string[] = [];
  const errors: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", (event) => frames.push(String(event.payload)));
    socket.on("framereceived", (event) => frames.push(String(event.payload)));
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  await page.goto(`${origin}/?run=${created.session.session_id}`);
  const field = page.getByRole("combobox", { name: "message" });
  await field.waitFor({ timeout: 20_000 }).catch(async () => { throw new Error(`composer did not open: ${await page.locator("body").innerText()}`); });
  const grantProofStart = frames.length;
  await field.fill("start grant proof");
  await page.getByRole("button", { name: "send message", exact: true }).click();
  const always = page.getByRole("button", { name: "always allow" });
  await always.waitFor({ timeout: 30_000 }).catch(async () => { throw new Error(`first approval missing; body=${(await page.locator("body").innerText()).slice(-4000)}; frames=${frames.slice(-40).join("\n")}; zeta=${(logs.get(server) ?? []).join("").slice(-4000)}`); });
  await always.click();

  for (let attempt = 0; attempt < 300; attempt++) {
    const approvals = frames.filter((frame) => frame.includes('"event":"approval_request"')).length;
    if (approvals >= 2 && await always.isVisible().catch(() => false)) break;
    if (attempt === 299) throw new Error(`second approval missing; frames=${frames.slice(-40).join("\n")}`);
    await Bun.sleep(100);
  }
  const stop = page.getByRole("button", { name: "stop" });
  await stop.click();
  await page.getByPlaceholder("message zeta").waitFor({ timeout: 20_000 });

  const permissionsControl = page.getByRole("button", { name: /permissions: 1 session grant/ });
  await permissionsControl.waitFor({ timeout: 10_000 });
  await permissionsControl.click();
  await page.getByRole("dialog", { name: "session permissions" }).getByRole("code").filter({ hasText: "bash" }).waitFor();
  const grantEvents = frames.slice(grantProofStart).filter((frame) => frame.includes('"event":"session_grants_changed"') && frame.includes('"change":"grant"'));
  if (grantEvents.length !== 1) throw new Error(`always-allow plus cancel emitted ${grantEvents.length} grant-change events: ${grantEvents.join("\n")}`);

  await permissionsControl.click();
  const approvalsBeforeReuse = frames.filter((frame) => frame.includes('"event":"approval_request"')).length;
  await field.fill("reuse the grant");
  await page.getByRole("button", { name: "send message", exact: true }).click();
  await page.getByText("real zeta grant proof complete", { exact: true }).waitFor({ timeout: 30_000 });
  const approvalsAfterReuse = frames.filter((frame) => frame.includes('"event":"approval_request"')).length;
  if (approvalsAfterReuse !== approvalsBeforeReuse) throw new Error(`reused bash grant asked again: ${approvalsBeforeReuse} -> ${approvalsAfterReuse}`);
  if (errors.length) throw new Error(`browser errors: ${errors.join(" | ")}`);
  console.log(`real zeta grants gate passed at ${ref}: always-allow survived cancelled approval, one session_grants_changed event, later bash did not re-ask, private home ${zetaHome}`);
} finally {
  await browser?.close().catch(() => {});
  await resources.cleanup(
    (path) => rm(path, { recursive: true, force: true }),
    async (path) => { await run("git", ["-C", zeta, "worktree", "remove", path], "git worktree remove"); },
  );
  console.log("real zeta grants cleanup passed");
}
