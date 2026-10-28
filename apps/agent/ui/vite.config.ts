// Builds the agent page into `dist/ui/` (after tsup, which cleans `dist/`): static files the
// daemon serves on 127.0.0.1 (`src/ui/server.ts`). No dev server and no fast refresh, so no
// React plugin: Vite's own TSX transform with the automatic JSX runtime is enough.
import { fileURLToPath } from "node:url";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // Relative URLs, so the page works behind a port forward that adds a path prefix.
  base: "./",
  publicDir: false,
  resolve: {
    // Workspace packages (@omniralph/ui, @omniralph/shared) are bundled from source.
    conditions: ["@omniralph/source", ...defaultClientConditions],
  },
  oxc: { jsx: { runtime: "automatic" } },
  build: {
    outDir: fileURLToPath(new URL("../dist/ui/", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    // Fonts and icons stay files: the CSP allows no `data:` fonts and no inline scripts.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    reportCompressedSize: false,
    rolldownOptions: {
      onwarn(warning, warn) {
        // Radix's "use client" directives mean nothing in a plain browser bundle.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
    },
  },
});
