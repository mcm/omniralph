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
  },
});
