// The agent page (`ui/`) is static files Vite builds into `dist/ui/`: React, TanStack Query and
// @omniralph/ui are bundled into them, so the published package gains no runtime dependency.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe("the agent page bundle", () => {
  it("takes React, React DOM, TanStack Query and @omniralph/ui as devDependencies only", () => {
    for (const name of ["@omniralph/ui", "react", "react-dom", "@tanstack/react-query", "vite"]) {
      expect(manifest.devDependencies).toHaveProperty(name);
      expect(manifest.dependencies).not.toHaveProperty(name);
    }
  });

  it("leaves the runtime dependencies as they were", () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@anthropic-ai/claude-agent-sdk",
      "ably",
      "fastest-levenshtein",
      "picomatch",
      "pino",
      "proper-lockfile",
      "zod",
    ]);
  });
});
