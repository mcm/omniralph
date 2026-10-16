// Bundled to `e2e/playwright.config.js` and run in the Playwright container by
// `pnpm --filter @omniralph/web e2e` (scripts/e2e/run.ts), which sets E2E_BASE_URL and
// DATABASE_URL. Not for running on the host.
import { defineConfig } from "@playwright/test";

/** `next dev` compiles each route on its first visit. */
const NAVIGATION_TIMEOUT_MS = 180_000;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.js",
  outputDir: "../test-results",
  // One worker: the specs share the fixture database and a single `next dev`.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 300_000,
  // Live updates poll every 3s; 10s covers a poll, its render and a slow dev compile.
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL,
    navigationTimeout: NAVIGATION_TIMEOUT_MS,
    actionTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
