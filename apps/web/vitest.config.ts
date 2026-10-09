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
      // `ai` imports `@opentelemetry/api`, whose "module" build (picked by Vite's
      // conditions) has extensionless imports Node can't load; let Vite load `ai`.
      server: { deps: { inline: [/\/node_modules\/ai\//] } },
    },
  }),
);
