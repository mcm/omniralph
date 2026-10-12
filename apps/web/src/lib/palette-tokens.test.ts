import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = resolve(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

// The library's raw palette steps don't follow the theme (e.g. `--glacier-300` text is 1.9:1 on
// the light theme's raised surface). The panel uses the semantic tokens built on them instead:
// `--text-accent`, `--accent`/`--accent-fg`, `--text-secondary`, `--<state>-fg`…
const RAW_PALETTE = /--(?:glacier|frost|slate|aurora)-[a-z0-9]+/g;

describe("palette tokens", () => {
  it("no panel source uses a raw palette token", () => {
    const offenders = walk(src)
      .filter((path) => /\.(tsx?|css)$/.test(path) && !/\.test\.tsx?$/.test(path))
      .flatMap((path) =>
        [...readFileSync(path, "utf8").matchAll(RAW_PALETTE)].map(
          (match) => `${relative(src, path)}: ${match[0]}`,
        ),
      );
    expect(offenders).toEqual([]);
  });
});
