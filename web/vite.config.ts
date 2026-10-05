import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/** The backend prints its port on start-up; override with GAMMA_BACKEND. */
const backend = process.env.GAMMA_BACKEND ?? "http://127.0.0.1:8777";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: backend, changeOrigin: false, ws: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
