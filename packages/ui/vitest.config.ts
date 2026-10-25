import { defineConfig, mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.shared.js";

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./vitest.setup.ts"],
    },
  }),
);
