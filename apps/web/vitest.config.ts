import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import sharedConfig from "../../vitest.shared";

export default mergeConfig(
  sharedConfig,
  defineConfig({
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    test: {
      // The fixture seed (`scripts/fixtures`) and the local lint rules are tested too.
      include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts", "eslint-rules/**/*.test.ts"],
      // `ai` imports `@opentelemetry/api`, whose "module" build (picked by Vite's
      // conditions) has extensionless imports Node can't load; let Vite load `ai`.
      server: { deps: { inline: [/\/node_modules\/ai\//] } },
      // One Postgres container for the run; each test file clones a migrated database.
      globalSetup: ["../../packages/db/testing/global-setup.ts"],
      setupFiles: ["./vitest.setup.ts"],
    },
  }),
);
