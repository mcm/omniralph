import { defineConfig, mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.shared.js";

export default mergeConfig(
  sharedConfig,
  defineConfig({
    // One Postgres container for the run; each test file clones a migrated database.
    test: { globalSetup: ["./testing/global-setup.ts"] },
  }),
);
