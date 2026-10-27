import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../..");

/**
 * The chat and Ask reach work items only through the tracker interface (`WorkItemTracker`):
 * no file under these directories, tests included, imports from the Linear modules.
 */
const ROOTS = ["lib/chat", "lib/ask", "components/ask"];

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(name) ? [path] : [];
  });
}

const LINEAR_IMPORT =
  /from\s+["']@\/lib\/linear\/|import\(\s*["']@\/lib\/linear\/|import\s+["']@\/lib\/linear\/|require\(\s*["']@\/lib\/linear\/|vi\.mock\(\s*["']@\/lib\/linear\//;

describe("the chat's tracker boundary", () => {
  it("keeps every chat and Ask file from importing the Linear modules", () => {
    const files = ROOTS.flatMap((root) => sources(join(SRC, root))).map((file) =>
      relative(SRC, file),
    );
    expect(files).toContain("lib/chat/linear-issue.ts");
    expect(files).toContain("lib/chat/agent/action-tools.ts");
    expect(files).toContain("lib/ask/messages.ts");
    const offending = files.filter((file) =>
      LINEAR_IMPORT.test(readFileSync(join(SRC, file), "utf8")),
    );
    expect(offending).toEqual([]);
  });

  it("recognizes each way of importing them", () => {
    // Built, so this file doesn't name the modules itself.
    const linear = ["@", "lib", "linear", ""].join("/");
    for (const line of [
      `import { getLinearGateway } from "${linear}client";`,
      `import type { LinearGateway } from '${linear}gateway';`,
      `const { x } = await import("${linear}client");`,
      `import "${linear}client";`,
      `vi.mock("${linear}client", () => ({}));`,
    ]) {
      expect(LINEAR_IMPORT.test(line)).toBe(true);
    }
    expect(LINEAR_IMPORT.test('import { x } from "@/lib/work-items/tracker";')).toBe(false);
  });
});
