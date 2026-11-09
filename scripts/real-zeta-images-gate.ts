// Real-zeta image-send proof: one pinned zeta ref, built in its own detached worktree, served from a fresh private
// ZETA_HOME under /tmp with a scripted provider backend. Gamma attaches a png in the browser and sends it; the gate
// records the exact send_images request and reply, then replays that same request (same delivery_id, text, and images)
// from a fresh controller and requires `duplicate: true` with exactly one image user row in history. Before the
// browser runs it also records how the real server treats extra and feature-gated params (the strict fake mirrors it).
// Local only: not part of `bun run gate` or CI.
//
// usage: bun scripts/real-zeta-images-gate.ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { createClient, webSocketTransport } from "@fulcrum/zeta";
import { OwnedResources } from "./owned-resources";
import { assertPrivateProofHome } from "./proof-home";

const gamma = new URL("..", import.meta.url).pathname;
const zeta = "/Users/henry/me/fun/zeta";
const ref = "169fb144b6f6120afeb6aa180927d6cce181a024";
const worktree = `${zeta}/.worktrees/image-probe`;
const appPort = Number(process.env.WEB_REAL_IMAGES_GATE_PORT ?? "4222");
const zetaPort = Number(process.env.WEB_REAL_IMAGES_ZETA_PORT ?? "4223");
for (const port of [appPort, zetaPort]) if (!Number.isInteger(port) || port < 1 || port > 65_535 || port === 5190 || port === 8765) throw new Error(`port ${port} is outside the allowed disposable range`);
if (await stat(worktree).then(() => true, () => false)) throw new Error(`proof worktree already exists: ${worktree}`);
const origin = `http://127.0.0.1:${appPort}`;
const resources = new OwnedResources();
const logs = new Map<ChildProcess, string[]>();
let browser: Browser | null = null;
// A valid 1x1 png (zeta checks the signature and decodes it).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
type Frame = { id?: unknown; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } };
const parse = (frame: string) => { try { return JSON.parse(frame) as Frame; } catch { return null; } };
type Client = ReturnType<typeof createClient>;
const outcome = async (client: Client, method: string, params: Record<string, unknown>) => {
  for (let attempt = 0; ; attempt++) {
    try { return { result: await client.request(method, params, { timeoutMs: 15_000 }) }; }
    catch (error) {
      const { code, message } = error as { code?: number; message?: string };
      // A scripted turn from an earlier probe may still be finishing.
      if (code === -32004 && attempt < 100) { await Bun.sleep(100); continue; }
      return { error: { code, message } };
    }
  }
};
const connect = async (features: string[], port: number, token: string) => {
  const transport = await webSocketTransport(`ws://127.0.0.1:${port}/`, ["zeta.v1", `zeta.bearer.${token}`]);
  const client = createClient(transport);
  await client.hello(features, "controller");
  return { client, close: () => transport.close() };
};

// /tmp, not tmpdir(): zeta binds a unix socket under ZETA_HOME, and macOS tmpdir() paths exceed AF_UNIX limits.
const temp = await mkdtemp("/tmp/gamma-images-"); resources.createdTemp(temp);
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
    env: { ...proofEnv, PYTHONPATH: worktree, ZETA_PROOF_WORKTREE: worktree, ZETA_PROOF_CWD: cwd, ZETA_PROOF_CONTROL: control, ZETA_PROOF_ORIGIN: origin, ZETA_PROOF_WS_PORT: String(zetaPort), ZETA_IMAGES_PROOF: "1" },
  });
  let discoveryText = "";
  for (let attempt = 0; attempt < 600 && !discoveryText; attempt++) {
    if (python.exitCode !== null) throw new Error(`real zeta exited during startup: ${(logs.get(python) ?? []).join("").slice(-4000)}`);
    discoveryText = await readFile(control, "utf8").catch(() => "");
    if (!discoveryText) await Bun.sleep(100);
  }
  const discovery = JSON.parse(discoveryText) as { port: number; token: string };
  if (discovery.port !== zetaPort) throw new Error(`real zeta listened on ${discovery.port}, expected ${zetaPort}`);

  // Param probes. Without send_images_delivery_id, then with it, on fresh sessions.
  const image = { name: "probe.png", mime_type: "image/png", data: PNG };
  const probes: Record<string, unknown> = {};
  {
    const { client, close } = await connect(["delivery_id"], discovery.port, discovery.token);
    const { session } = await client.request("new_session", {}) as { session: { session_id: string } };
    const session_id = session.session_id;
    probes["send_images delivery_id without send_images_delivery_id"] = await outcome(client, "send_images", { session_id, text: "p1", images: [image], delivery_id: "probe-1" });
    probes["send_images without session_id"] = await outcome(client, "send_images", { text: "p2", images: [image] });
    probes["send_images unknown param"] = await outcome(client, "send_images", { session_id, text: "p3", images: [image], bogus_param: 1 });
    probes["send unknown param"] = await outcome(client, "send", { text: "p4", bogus_param: 1 });
    probes["send session_id"] = await outcome(client, "send", { session_id, text: "p5" });
    probes["status unknown param"] = await outcome(client, "status", { bogus_param: 1 });
    close();
  }
  console.log(`real zeta param probes at ${ref}:\n${JSON.stringify(probes, null, 2)}`);
  await Bun.sleep(250);

  const seed = await connect(["delivery_id", "send_images_delivery_id"], discovery.port, discovery.token);
  const created = await seed.client.request("new_session", {}) as { session: { session_id: string } };
  const sessionId = created.session.session_id;
  seed.close();
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
  page.on("websocket", (socket) => {
    socket.on("framesent", (event) => frames.push(String(event.payload)));
    socket.on("framereceived", (event) => frames.push(String(event.payload)));
  });
  await page.goto(`${origin}/?run=${sessionId}`);
  const field = page.getByRole("combobox", { name: "message" });
  await field.waitFor({ timeout: 20_000 });
  await page.locator('.dock [data-part="composer"] input[type=file]').setInputFiles([{ name: "probe.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") }]);
  await page.getByRole("button", { name: "remove probe.png" }).waitFor({ timeout: 10_000 });
  await field.fill("real image proof");
  await page.getByRole("button", { name: "send message" }).click();
  const sentRequest = () => frames.map(parse).find((frame) => frame?.method === "send_images");
  const reply = () => { const request = sentRequest(); return request ? frames.map(parse).find((frame) => frame?.id === request.id && (frame.result || frame.error)) : undefined; };
  for (let attempt = 0; attempt < 300 && !reply(); attempt++) await Bun.sleep(100);
  const request = sentRequest();
  const response = reply();
  const hello = frames.map(parse).find((frame) => (frame?.result as { server?: unknown } | undefined)?.server === "zeta")?.result as { capabilities?: { features?: string[] } } | undefined;
  const shown = (frame: Frame | null | undefined) => JSON.stringify(frame, (key, value) => key === "data" && typeof value === "string" && value.length > 40 ? `${value.slice(0, 16)}…(${value.length} chars)` : value);
  console.log(`gamma hello features echoed: ${JSON.stringify(hello?.capabilities?.features)}`);
  console.log(`gamma send_images request: ${shown(request)}`);
  console.log(`real zeta reply: ${shown(response)}`);
  if (!request || !response) throw new Error(`no send_images round trip; frames=${frames.join("\n").slice(-4000)}`);
  if (response.error || response.result?.accepted !== true) throw new Error(`gamma image send failed against real zeta: ${shown(response)}`);
  await page.getByText("image proof turn", { exact: false }).first().waitFor({ timeout: 20_000 });
  if (errors.length) throw new Error(`browser errors: ${errors.join(" | ")}`);
  await browser.close(); browser = null;
  await Bun.sleep(500);

  // Replay gamma's exact request from a fresh controller: zeta must dedupe it (same delivery_id, text, and images).
  const replay = await connect(["delivery_id", "send_images_delivery_id"], discovery.port, discovery.token);
  await outcome(replay.client, "resume", { session_id: sessionId });
  const again = await outcome(replay.client, "send_images", request.params!);
  console.log(`replayed send_images reply: ${JSON.stringify(again)}`);
  if ((again.result as { duplicate?: unknown } | undefined)?.duplicate !== true) throw new Error(`replay was not deduplicated: ${JSON.stringify(again)}`);
  const history = await replay.client.request("session_history", { session_id: sessionId }) as { messages?: Array<{ role?: string; content?: Array<{ type?: string }> }> };
  const imageRows = (history.messages ?? []).filter((message) => message.role === "user" && message.content?.some((block) => block.type === "attachment"));
  replay.close();
  if (imageRows.length !== 1) throw new Error(`expected one attachment user row, history has ${imageRows.length}: ${JSON.stringify(history).slice(0, 2000)}`);
  console.log(`real zeta images passed: ${ref}; private home ${zetaHome}; accepted once, replay duplicate:true, 1 attachment row`);
} finally {
  await browser?.close().catch(() => {});
  await resources.cleanup(
    (path) => rm(path, { recursive: true, force: true }),
    async (path) => { await run("git", ["-C", zeta, "worktree", "remove", "--force", path], "git worktree remove", gamma); },
  );
  console.log(`real zeta images cleanup: children closed; removed ${temp} and ${worktree}`);
}
