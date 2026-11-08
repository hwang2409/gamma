// Real-zeta half of the compatibility gate: one pinned zeta ref, built in its own detached worktree, served from a
// fresh private ZETA_HOME under /tmp. It proves the full-capability path against the real wire: the real slash_list
// rows (with whatever additive fields that ref sends) all reach the menu, commands stay local receipts, gamma's own
// commands run, and no slash draft becomes a send. Old-server rows stay in the fake gate (scripts/compat-gate.ts).
//
// usage: ZETA_PROOF_REF=<40-char sha> bun scripts/real-zeta-compat-gate.ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { themes } from "@fulcrum/react";
import { createClient, webSocketTransport } from "@fulcrum/zeta";
import { OwnedResources } from "./owned-resources";
import { assertPrivateProofHome } from "./proof-home";

const gamma = new URL("..", import.meta.url).pathname;
const zeta = "/Users/henry/me/fun/zeta";
// The current parity pin and the pre-z9 pin (zeta #890); both predate zeta #1066's runs_while_busy.
const REFS = ["8389c6e90af7fa6c26f1fa1c8eab2470244b27a5", "0869b2b437bfba0250d08dac73becea7212dcbdc"];
const ref = process.env.ZETA_PROOF_REF ?? "";
if (!REFS.includes(ref)) throw new Error(`ZETA_PROOF_REF must be one of ${REFS.join(", ")}`);
const worktree = `${zeta}/.worktrees/parity-compat-proof-${ref.slice(0, 8)}`;
const appPort = Number(process.env.WEB_REAL_COMPAT_GATE_PORT ?? "4215");
const zetaPort = Number(process.env.WEB_REAL_COMPAT_ZETA_PORT ?? "4216");
for (const port of [appPort, zetaPort]) if (!Number.isInteger(port) || port < 1 || port > 65_535 || port === 5190 || port === 8765) throw new Error(`port ${port} is outside the allowed disposable range`);
if (await stat(worktree).then(() => true, () => false)) throw new Error(`proof worktree already exists: ${worktree}`);
const origin = `http://127.0.0.1:${appPort}`;
const resources = new OwnedResources();
const logs = new Map<ChildProcess, string[]>();
let browser: Browser | null = null;

const child = (command: string, args: string[], options: Parameters<typeof spawn>[2] = {}) => {
  const process = resources.child(spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] }));
  const lines: string[] = []; logs.set(process, lines);
  process.stdout?.on("data", (data) => lines.push(String(data)));
  process.stderr?.on("data", (data) => lines.push(String(data)));
  return process;
};
const run = (command: string, args: string[], label: string, cwd: string, env = process.env) => new Promise<string>((resolve, reject) => {
  const process = child(command, args, { cwd, env });
  process.once("exit", (code) => code === 0 ? resolve((logs.get(process) ?? []).join("")) : reject(new Error(`${label} exited ${code}: ${(logs.get(process) ?? []).join("").slice(-4000)}`)));
  process.once("error", reject);
});
const parse = (frame: string) => { try { return JSON.parse(frame) as { id?: unknown; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> }; } catch { return null; } };

// /tmp, not tmpdir(): zeta binds a unix socket under ZETA_HOME, and macOS tmpdir() paths exceed AF_UNIX limits.
const temp = await mkdtemp("/tmp/gamma-compat-"); resources.createdTemp(temp);
const zetaHome = assertPrivateProofHome(join(temp, "zeta-home"), worktree);
if (await stat(zetaHome).then(() => true, () => false)) throw new Error(`real-zeta proof home was not fresh: ${zetaHome}`);
const proofEnv = { ...process.env, ZETA_HOME: zetaHome };

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
  const python = child("uv", ["run", "--project", worktree, "python", join(gamma, "scripts", "real-zeta-server.py")], {
    cwd: worktree,
    env: { ...proofEnv, PYTHONPATH: worktree, ZETA_PROOF_WORKTREE: worktree, ZETA_PROOF_CWD: cwd, ZETA_PROOF_CONTROL: control, ZETA_PROOF_ORIGIN: origin, ZETA_PROOF_WS_PORT: String(zetaPort) },
  });
  let discoveryText = "";
  for (let attempt = 0; attempt < 600 && !discoveryText; attempt++) {
    if (python.exitCode !== null) throw new Error(`real zeta exited during startup: ${(logs.get(python) ?? []).join("").slice(-4000)}`);
    discoveryText = await readFile(control, "utf8").catch(() => "");
    if (!discoveryText) await Bun.sleep(100);
  }
  const discovery = JSON.parse(discoveryText) as { port: number; token: string };
  if (discovery.port !== zetaPort) throw new Error(`real zeta listened on ${discovery.port}, expected ${zetaPort}`);

  const transport = await webSocketTransport(`ws://127.0.0.1:${discovery.port}/`, ["zeta.v1", `zeta.bearer.${discovery.token}`]);
  const seed = createClient(transport);
  await seed.hello(["model_input_ids"], "controller");
  const created = await seed.request("new_session", {}) as { session: { session_id: string } };
  transport.close();
  await Bun.sleep(250);

  const vite = child("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(appPort), "--strictPort"], { cwd: gamma, env: { ...proofEnv, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin } });
  for (let attempt = 0; attempt < 200 && !(await fetch(origin).then((response) => response.ok, () => false)); attempt++) {
    if (vite.exitCode !== null) throw new Error(`vite exited during startup: ${(logs.get(vite) ?? []).join("")}`);
    await Bun.sleep(100);
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
  await field.waitFor({ timeout: 20_000 });
  const receipt = page.locator(".command-receipt-text");
  const dismiss = async () => { const button = page.getByRole("button", { name: "dismiss command result" }); if (await button.count()) await button.click(); };
  const submit = async (text: string) => {
    await dismiss();
    await field.fill(text);
    await field.press("Escape");
    await field.press("Enter");
    await receipt.waitFor({ timeout: 30_000 }).catch(async () => { throw new Error(`${text} showed no receipt; value=${await field.inputValue()}; frames=${frames.join("\n").slice(-4000)}`); });
    return receipt.innerText();
  };

  // The run's command source asks for the catalog when it attaches; wait for the real reply.
  const listFrame = () => {
    const request = frames.map(parse).find((frame) => frame?.method === "slash_list");
    return request ? frames.map(parse).find((frame) => frame?.id === request.id && frame.result) : undefined;
  };
  for (let attempt = 0; attempt < 300 && !listFrame(); attempt++) await Bun.sleep(100);
  const realRows = (listFrame()?.result?.commands as Array<Record<string, unknown>> | undefined) ?? [];
  const runnable = realRows.filter((row) => row.unavailable === null).length;
  if (!runnable) throw new Error(`real slash_list returned no runnable rows: ${JSON.stringify(listFrame())}`);
  const fields = [...new Set(realRows.flatMap((row) => Object.keys(row)))].sort();

  const hello = frames.map(parse).find((frame) => (frame?.result as { server?: unknown } | undefined)?.server === "zeta")?.result as { protocol_version?: string; capabilities?: { features?: string[]; requests?: string[] } } | undefined;
  for (const feature of ["model_input_ids", "session_grants"]) if (!hello?.capabilities?.features?.includes(feature)) throw new Error(`real hello did not echo ${feature}: ${JSON.stringify(hello)}`);
  for (const request of ["slash_list", "slash_run", "session_grants"]) if (!hello?.capabilities?.requests?.includes(request)) throw new Error(`real hello did not list ${request}`);

  let menuRows = 0;
  for (let attempt = 0; attempt < 20 && !menuRows; attempt++) {
    await field.fill("");
    await field.fill("/");
    await page.getByRole("listbox", { name: "command suggestions" }).getByRole("option").first().waitFor({ timeout: 500 }).catch(() => {});
    menuRows = await page.getByRole("listbox", { name: "command suggestions" }).getByRole("option").count();
  }
  await field.fill("");
  if (menuRows !== runnable) throw new Error(`menu showed ${menuRows} rows for ${runnable} runnable real slash_list rows`);
  await page.locator(".permissions-trigger").waitFor({ timeout: 10_000 });

  const status = await submit("/status");
  if (!status.trim()) throw new Error("/status showed an empty receipt");
  const unknown = await submit("/no-such-compat-command");
  if (!/^unknown command:? \/no-such-compat-command/.test(unknown)) throw new Error(`unknown command showed ${JSON.stringify(unknown)}`);
  const keys = await submit("/keys");
  if (!keys.includes("browser precedence and terminal-only exclusions")) throw new Error(`/keys showed ${JSON.stringify(keys.slice(0, 120))}`);
  const before = await page.evaluate(() => document.documentElement.dataset.fulcrumTheme);
  const next = themes.find((theme) => theme !== before)!;
  await submit(`/theme ${next}`);
  if (await page.evaluate(() => document.documentElement.dataset.fulcrumTheme) !== next) throw new Error(`/theme ${next} did not change the theme`);
  await dismiss();

  const sends = frames.map(parse).filter((frame) => frame?.method === "send" || frame?.method === "send_images" || frame?.method === "steer");
  if (sends.length) throw new Error(`a slash draft reached the model: ${JSON.stringify(sends)}`);
  if (errors.length) throw new Error(`browser errors: ${errors.join(" | ")}`);
  console.log(`real zeta compat passed: ${ref}; private home ${zetaHome}; protocol ${hello?.protocol_version}; ${runnable} runnable rows all in the menu; row fields ${fields.join(",")}; /status, unknown, /keys, /theme local; 0 sends`);
} finally {
  await browser?.close().catch(() => {});
  await resources.cleanup(
    (path) => rm(path, { recursive: true, force: true }),
    async (path) => { await run("git", ["-C", zeta, "worktree", "remove", "--force", path], "git worktree remove", gamma); },
  );
  console.log(`real zeta compat cleanup: children closed; removed ${temp} and ${worktree}`);
}
