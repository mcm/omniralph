import { defaultServerConditions, defaultClientConditions } from "vite";
import { defineConfig } from "vitest/config";

// Workspace packages export their TypeScript source under the
// "@omniralph/source" condition, so tests run against src without a build.
const sourceCondition = "@omniralph/source";

export default defineConfig({
  resolve: {
    conditions: [sourceCondition, ...defaultClientConditions],
  },
  ssr: {
    resolve: {
      conditions: [sourceCondition, ...defaultServerConditions],
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // Stopping a Testcontainers Postgres in `afterAll` can take well over the default 10s
    // when several packages' suites run containers at once under `pnpm test`.
    hookTimeout: 60_000,
    // Testcontainers-backed tests (web ralph/agent API, db) take up to ~3s alone and two to
    // three times that when every package's suite runs at once, past the default 5s.
    testTimeout: 20_000,
  },
});
