import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Rule 22 (the whole UI is live) and Decided `no-live-indicator`: screens update through the
// live data layer (`src/lib/live/`, TOOL-632), never by polling on their own. This scans the
// panel, `@omniralph/ui` and the agent's local page for a `refetchInterval` (other than
// `false`) and for `setInterval`-driven fetching. The live layers' fallback polling (while
// live updates are down) is the only exception, each in the allowlist with its reason.

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Scanned, from the repository root. */
const SCANNED = ["apps/web/src", "packages/ui/src", "apps/agent/ui/src"];

/** The live data layer, where polling and its fallback belong. */
const LIVE_LAYER = "apps/web/src/lib/live/";

const ALLOWED: { file: string; reason: string }[] = [
  {
    file: "apps/web/src/lib/api/query-client.ts",
    reason: "the panel's fallback poll, only while live updates are down (TOOL-632)",
  },
  {
    file: "apps/agent/ui/src/query-client.ts",
    reason: "the agent page's fallback poll, only while its live updates are down",
  },
];

/** A callback that fetches: `fetch(`, a refetch, an invalidation or a router refresh. */
const FETCHING =
  /\b(?:fetch\w*|refetch\w*|invalidateQueries|refetchQueries|resetQueries|refresh)\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => path.join(dir, file));
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

/** Each `refetchInterval` that isn't `false`, and each `setInterval` whose callback fetches. */
function pollingIn(file: string, code: string): Hit[] {
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: Hit[] = [];
  const hit = (node: ts.Node) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    hits.push({
      file,
      line: line + 1,
      text: node.getText(source).replace(/\s+/g, " ").slice(0, 120),
    });
  };
  const visit = (node: ts.Node) => {
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "refetchInterval" &&
      !(ts.isPropertyAssignment(node) && node.initializer.kind === ts.SyntaxKind.FalseKeyword)
    ) {
      hit(node);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      const callback = node.arguments[0];
      if (name === "setInterval" && callback && FETCHING.test(callback.getText(source))) hit(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

const describeHits = (hits: Hit[]) => hits.map((h) => `${h.file}:${h.line}: ${h.text}`);

describe("live data (rule 22)", () => {
  const files = SCANNED.flatMap(sourceFiles);
  const hits = files
    .filter((file) => !file.startsWith(LIVE_LAYER))
    .flatMap((file) => pollingIn(file, readFileSync(path.join(root, file), "utf8")));

  it("scans the panel, @omniralph/ui and the agent's local page", () => {
    expect(files).toContain("apps/web/src/screens/runs/runs-view.tsx");
    expect(files).toContain("packages/ui/src/feedback/live-notice.tsx");
    expect(files).toContain("apps/agent/ui/src/app.tsx");
  });

  it("polls nowhere outside the live data layer and its fallbacks", () => {
    const allowed = new Set(ALLOWED.map((entry) => entry.file));
    expect(describeHits(hits.filter((h) => !allowed.has(h.file)))).toEqual([]);
  });

  it("keeps every allowlist entry in use and explained", () => {
    for (const entry of ALLOWED) {
      expect(
        hits.some((h) => h.file === entry.file),
        entry.file,
      ).toBe(true);
      expect(entry.reason.trim()).not.toBe("");
    }
  });
});

describe("the polling scan", () => {
  it("finds a refetchInterval other than false", () => {
    const code = [
      "useQuery({ queryKey, queryFn, refetchInterval: 5000 });",
      "useQuery({ queryKey, queryFn, refetchInterval: () => 1000 });",
      "useQuery({ queryKey, queryFn, refetchInterval });",
      "useQuery({ queryKey, queryFn, refetchInterval: false });",
    ].join("\n");
    expect(pollingIn("probe.ts", code).map((h) => h.line)).toEqual([1, 2, 3]);
  });

  it("finds setInterval that fetches, not one that ticks a clock", () => {
    const code = [
      "setInterval(() => void fetch('/api/ui/runs'), 5000);",
      "window.setInterval(() => queryClient.invalidateQueries({ queryKey }), 5000);",
      "setInterval(refetch, 10_000);",
      "setInterval(() => router.refresh(), 30_000);",
      "setInterval(() => setNow(Date.now()), 1000);",
    ].join("\n");
    expect(pollingIn("probe.ts", code).map((h) => h.line)).toEqual([1, 2, 3, 4]);
  });
});
