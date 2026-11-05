import { defineConfig, type Plugin } from "vite";
import { zetaDiscoveryPlugin } from "@fulcrum/zeta/discovery";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gammaHostPlugin = (appOrigin: string): Plugin => {
  let owned: ChildProcess | null = null;
  return {
    name: "gamma-host",
    async configureServer(server) {
      const home = process.env.GAMMA_HOME ?? join(process.env.HOME!, ".gamma");
      const controlPath = join(home, "control.json");
      type Control = { url: string; pid: number; app_origin: string; app_token: string };
      const readControl = async () => JSON.parse(await readFile(controlPath, "utf8")) as Control;
      let control = await readControl().catch(() => null);
      if (!control || !running(control.pid)) {
        owned = spawn("bun", ["src/host/server.ts"], { cwd: new URL(".", import.meta.url).pathname, env: { ...process.env, GAMMA_APP_ORIGIN: appOrigin }, stdio: ["ignore", "ignore", "inherit"] });
        for (let attempt = 0; attempt < 100; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (owned.exitCode !== null) throw new Error("gamma host exited during startup");
          control = await readControl().catch(() => null);
          if (control?.pid === owned.pid) break;
        }
        if (!control || control.pid !== owned.pid) throw new Error("gamma host did not publish discovery");
      }
      server.middlewares.use("/__gamma", async (request, response) => {
        try {
          const headers = new Headers();
          for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          headers.set("x-gamma-app-token", control!.app_token); headers.set("origin", control!.app_origin); headers.delete("host");
          const body = request.method === "GET" || request.method === "HEAD" ? undefined : await new Response(request as any).arrayBuffer();
          const upstream = await fetch(`${control!.url}/app${request.url}`, { method: request.method, headers, body });
          response.statusCode = upstream.status; upstream.headers.forEach((value, key) => response.setHeader(key, value));
          response.end(Buffer.from(await upstream.arrayBuffer()));
        } catch { response.statusCode = 502; response.end(JSON.stringify({ error: { code: "host_unavailable", message: "gamma host is unavailable" } })); }
      });
      server.httpServer?.once("close", () => { if (owned?.pid && running(owned.pid)) owned.kill("SIGTERM"); owned = null; });
    },
  };
};

export default defineConfig(({ command }) => {
  const appOrigin = process.env.GAMMA_APP_ORIGIN ?? "http://localhost:5190";
  return {
    plugins: [zetaDiscoveryPlugin(), ...(command === "serve" ? [gammaHostPlugin(appOrigin)] : [])],
    server: { port: 5180, strictPort: true, cors: false },
    preview: { port: 5180, strictPort: true },
  };
});
