import { defineConfig, mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.shared.js";

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      // The components' tests share no module state, and the setup file cleans up the DOM
      // after each test, so they reuse one jsdom per worker: about 4x faster than one per file.
      isolate: false,
      setupFiles: ["./vitest.setup.ts"],
    },
  }),
);
