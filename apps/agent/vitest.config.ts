import { defineConfig, mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.shared.js";

// The agent page's tests (`ui/src`) run here too, each under jsdom
// (`// @vitest-environment jsdom`); the daemon's and its fixture mode's (`scripts`) stay on node.
export default mergeConfig(
  sharedConfig,
  defineConfig({ test: { include: ["ui/src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"] } }),
);
