/**
 * Browser checks: screenshots in both themes and two viewports, and axe.
 *
 * They drive a running gamma (backend + Vite dev server, so the dev-only
 * fixture route exists) with the fake provider; nothing here starts
 * servers. See e2e/ui.spec.ts for the environment it reads.
 */

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: process.env.GAMMA_WEB_URL ?? "http://localhost:5173",
    browserName: "chromium",
  },
});
