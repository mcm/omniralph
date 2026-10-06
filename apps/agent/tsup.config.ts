import { cpSync } from "node:fs";
import { defineConfig } from "tsup";

const rubricDir = new URL("../../packages/engine/src/rubric/", import.meta.url);

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Bundle the workspace packages from source; third-party packages stay external
  // (tsup externalizes everything in `dependencies`, so each must be listed there).
  noExternal: [/^@omniralph\//],
  removeNodeProtocol: false,
  esbuildOptions(options) {
    options.conditions = ["@omniralph/source"];
  },
  // The engine reads its rubric files relative to `import.meta.url`, which is now
  // `dist/cli.js`: ship them next to the bundle.
  onSuccess: async () => {
    cpSync(new URL("universal.md", rubricDir), new URL("dist/universal.md", import.meta.url));
    cpSync(new URL("languages", rubricDir), new URL("dist/languages", import.meta.url), {
      recursive: true,
    });
  },
});
