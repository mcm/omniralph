import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// "Show advanced settings" is a UI preference only (TOOL-580): it never gates an API,
// refuses a write, or changes routing or run behavior. Outside the database package, only
// the files below may name it; everything else (API handlers, routing, runs, the agent)
// works the same whatever the user chose.

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** The session that loads it, the `(app)` layout that passes it on, and `useShowAdvanced`. */
const READERS = new Set([
  "apps/web/src/auth.ts",
  "apps/web/src/lib/auth/session.ts",
  "apps/web/src/app/(app)/layout.tsx",
  "apps/web/src/components/app-shell.tsx",
  "apps/web/src/components/show-advanced.tsx",
]);

const SCANNED = ["apps", "packages"];
const SKIPPED = new Set(["node_modules", "dist", ".next", ".turbo", "drizzle", "coverage"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : sourceFiles(relative);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

describe("show advanced settings", () => {
  it("is read only by the (app) layout and useShowAdvanced", () => {
    const readers = SCANNED.flatMap(sourceFiles)
      .filter((file) => !file.startsWith("packages/db/"))
      .filter((file) =>
        /\bshowAdvanced\b|show_advanced/.test(readFileSync(path.join(root, file), "utf8")),
      );
    expect(readers.filter((file) => !READERS.has(file))).toEqual([]);
    expect(readers.length).toBeGreaterThan(0);
  });
});
