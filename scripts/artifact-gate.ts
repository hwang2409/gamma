import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { ACTIVE, startFakeZeta } from "./fake-zeta";

const root = new URL("..", import.meta.url).pathname;
const port = Number(process.env.ARTIFACT_GATE_PORT ?? 4190);
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.WEB_SHOTS ?? join(root, "gate-artifacts");
const gammaHome = await mkdtemp(join(tmpdir(), "gamma-artifact-gate-"));
await mkdir(shots, { recursive: true });
const fake = await startFakeZeta({ origins: [origin] });
const vite = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, env: { ...process.env, ZETA_HOME: fake.home, GAMMA_HOME: gammaHome, GAMMA_APP_ORIGIN: origin, VITE_ZETA_PORT: String(fake.port) }, stdio: ["ignore", "ignore", "inherit"] });
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const fixtures: Array<[string, string, Uint8Array | string]> = [
  ["image/png", "pixel png", png],
  ["image/svg+xml", "safe svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="120" height="40" fill="#282a36"/><text x="8" y="25" fill="white">gamma</text></svg>`],
  ["text/markdown", "notes markdown", "# render result\n\n**persisted** after the tool."],
  ["text/csv", "metrics csv", "name,value\nlatency,42\nthroughput,9000\n"],
  ["application/pdf", "report pdf", "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF"],
  ["text/html", "hostile html", `<h1>isolated</h1><script>parent.document.body.dataset.gammaPwned='yes';localStorage.setItem('gamma-pwned','yes')</script>`],
];
const assert = (value: unknown, message: string): asserts value => { if (!value) throw new Error(message); };
try {
  for (let attempt = 0; ; attempt++) {
    if (vite.exitCode !== null) throw new Error("vite exited");
    if (await fetch(origin).then((response) => response.ok, () => false)) break;
    if (attempt > 600) throw new Error("vite did not start");
    await Bun.sleep(100);
  }
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${origin}/?run=${encodeURIComponent(ACTIVE)}`);
    await page.locator('[data-virtual-id="tool:live-1"]').waitFor({ timeout: 30_000 });
    const registration = await page.evaluate(async (sessionId) => {
      const response = await fetch("/__gamma/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId }) });
      return response.json();
    }, ACTIVE) as any;
    await page.evaluate(async ({ sessionId, tool }) => { await fetch(`/__gamma/sessions/${encodeURIComponent(sessionId)}/context`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool_call_id: tool }) }); }, { sessionId: ACTIVE, tool: "live-1" });
    for (const [type, title, body] of fixtures) {
      const response = await fetch(`${registration.command.environment.GAMMA_API_URL}/render`, { method: "POST", headers: { Authorization: `Bearer ${registration.command.environment.GAMMA_API_TOKEN}`, "Content-Type": type, "X-Gamma-Title": title }, body });
      assert(response.ok, `${title} upload failed: ${response.status} ${await response.text()}`);
    }
    const artifacts = page.locator('[data-virtual-id="tool:live-1"] .artifact');
    await artifacts.first().waitFor({ timeout: 10_000 });
    assert(await artifacts.count() === fixtures.length, `expected ${fixtures.length} artifacts after tool, got ${await artifacts.count()}`);
    await page.reload();
    await page.locator('[data-virtual-id="tool:live-1"] .artifact').first().waitFor({ timeout: 30_000 });
    assert(await page.locator('[data-virtual-id="tool:live-1"] .artifact').count() === fixtures.length, "reload lost artifacts or their tool placement");

    for (const [type] of fixtures) {
      const card = page.locator(`.artifact[data-media-type="${type}"]`);
      await card.locator("button").first().click();
      const inspector = page.getByRole("dialog", { name: "file inspector" }); await inspector.waitFor();
      assert(await inspector.locator('a[download]').count() === 1, `${type} has no download`);
      if (type === "image/png" || type === "image/svg+xml") await inspector.locator("img").waitFor();
      if (type === "text/markdown") await inspector.getByRole("heading", { name: "render result" }).waitFor();
      if (type === "text/csv") { await inspector.locator("table td").first().waitFor(); assert(await inspector.locator("table td").count() >= 4, "csv table missing cells"); }
      if (type === "application/pdf") await inspector.locator('iframe[title="pdf preview"]').waitFor();
      if (type === "text/html") {
        await inspector.locator('iframe[data-viewer="html"]').waitFor(); await Bun.sleep(200);
        assert(await page.locator("body[data-gamma-pwned]").count() === 0, "sandboxed html accessed the gamma page");
        assert(await page.evaluate(() => localStorage.getItem("gamma-pwned")) === null, "sandboxed html accessed gamma storage");
      }
      await inspector.getByRole("button", { name: "close" }).click();
    }
    await page.screenshot({ path: join(shots, "artifacts-1440.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-virtual-id="tool:live-1"] .artifact').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, "artifacts-390.png"), fullPage: true });
    console.log("ok   artifact placement, reload persistence, six viewers, downloads, and html sandbox");
  } finally { await browser.close(); }
} finally {
  if (vite.exitCode === null) {
    vite.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => vite.once("exit", resolve)), Bun.sleep(5_000)]);
  }
  await fake.close(); await rm(gammaHome, { recursive: true, force: true });
}
