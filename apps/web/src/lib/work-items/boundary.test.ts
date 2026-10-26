import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../..");

/**
 * The Backlog and work item modules: they reach a tracker only through the tracker interface
 * (`WorkItemTracker`), never the Linear gateway. The Linear adapter is the one place that
 * does, with `get-tracker.ts`, which builds it from the organization's connection.
 */
const ROOTS = [
  "lib/work-items",
  "app/api/ui/backlog",
  "app/api/ui/work-items",
  "app/api/ui/share-links",
  "screens/backlog",
  "components/work-items",
];
const ADAPTER = new Set(["lib/work-items/linear.ts", "lib/work-items/get-tracker.ts"]);

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the work item boundary", () => {
  it("keeps Backlog and work item modules from importing the Linear gateway", () => {
    const files = ROOTS.flatMap((root) => sources(join(SRC, root)))
      .map((file) => relative(SRC, file))
      .filter((file) => !ADAPTER.has(file));
    expect(files).toContain("lib/work-items/backlog.ts");
    const offending = files.filter((file) =>
      /from\s+["']@\/lib\/linear\/|import\(\s*["']@\/lib\/linear\/|import\s+["']@\/lib\/linear\//.test(
        readFileSync(join(SRC, file), "utf8"),
      ),
    );
    expect(offending).toEqual([]);
  });
});
