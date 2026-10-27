import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Inbox, Runs (TOOL-642), Repos (TOOL-694), Settings (TOOL-649), Fleet (TOOL-657) and Analytics (TOOL-637) are live: change events refresh their queries, and
// they poll only as the live data layer's fallback while the realtime connection is down
// (TOOL-632). No query of theirs, nor of the shared components the Repos epic (TOOL-645) built
// for them and Settings, sets a `refetchInterval` of its own; `refetchInterval: false` (a query
// that must never poll, like a story's diff from GitHub or GitLab) is the one value allowed.

const WEB = path.resolve(__dirname, "../..");
const SCANNED = [
  "src/screens",
  "src/components/runs",
  "src/app/(app)/page.tsx",
  "src/app/(app)/runs",
  "src/app/(app)/repos",
  "src/app/(app)/fleet",
  "src/app/(app)/settings",
  "src/app/(app)/analytics",
  "src/components/use-staged-card.ts",
  "src/components/change-history-popover.tsx",
  "src/components/connection-health.tsx",
  "src/components/connect-gitlab-form.tsx",
  "src/components/connect-github-button.tsx",
];

function walk(full: string): string[] {
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full).flatMap((name) => walk(path.join(full, name)));
}

const files = SCANNED.flatMap((entry) => walk(path.join(WEB, entry)))
  .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
  .map((file) => path.relative(WEB, file).split(path.sep).join("/"));

/** Each `refetchInterval` property of `code` whose value isn't `false`, as `file:line`. */
function pollingIntervals(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(path.join(WEB, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const name =
      ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)
        ? node.name.getText(source)
        : null;
    if (
      name === "refetchInterval" &&
      !(ts.isPropertyAssignment(node) && node.initializer.kind === ts.SyntaxKind.FalseKeyword)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(`${file}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("Inbox, Runs and Repos polling", () => {
  it("scans the screens, the run components, the shared Repos components and their pages", () => {
    expect(files).toContain("src/screens/inbox/queries.ts");
    expect(files).toContain("src/screens/runs/queries.ts");
    expect(files).toContain("src/screens/repos/queries.ts");
    expect(files).toContain("src/screens/repos/add-repo-sheet.tsx");
    expect(files).toContain("src/app/(app)/repos/[id]/page.tsx");
    expect(files).toContain("src/components/change-history-popover.tsx");
    expect(files).toContain("src/components/connection-health.tsx");
    expect(files).toContain("src/components/runs/use-run-detail.ts");
    expect(files).toContain("src/app/(app)/runs/[id]/page.tsx");
  });

  it("sets no refetchInterval of its own", () => {
    expect(files.flatMap(pollingIntervals)).toEqual([]);
  });
});
