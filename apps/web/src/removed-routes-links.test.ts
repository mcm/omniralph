import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Runs (`/runs`, TOOL-642) replaced the Coding (`/coding`, once `/ralph`), Reviews, Triage and
// Jobs pages and a repository's Reviews tab, and those routes are gone: nothing in the app may
// link to them. This scans every source file under `src` (tests too) for string literals and
// template strings that start with one of the old routes, so a link built from a template
// (`/repositories/${id}/reviews`) is caught as well. Links to a run use `runHref` and
// `runListHref` (`src/lib/runs/hrefs.ts`).

const SRC = path.resolve(__dirname);
const SELF = "src/removed-routes-links.test.ts";

/** An old route at the start of a literal: the path itself, or followed by `/`, `?` or `#`. */
const REMOVED_ROUTE = /^\/(?:coding|ralph|reviews|triage|jobs)(?=$|[/?#])/;
/** A repository's Reviews tab, with `${…}` (or anything) as the repository. */
const REPOSITORY_REVIEWS = /^\/repositories\/[^/?#]+\/reviews(?=$|[/?#])/;

interface Allowed {
  /** The whole literal text. */
  text: RegExp;
  /** Files (from `src/`'s parent) the exception applies to. */
  files: RegExp;
  reason: string;
}

const ALLOWED: Allowed[] = [
  {
    text: /^\/(?:coding|ralph|triage)$/,
    files: /^src\/lib\/(?:ralph|triage|linear)\/[^/]+\.test\.ts$/,
    reason: "Omniralph's Linear commands (`/coding`, `/ralph`, `/triage`) in replies, not routes",
  },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Every string literal and template string of `code`, a template's holes as `${}`. */
function literals(file: string, code: string): { line: number; text: string }[] {
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: { line: number; text: string }[] = [];
  const add = (node: ts.Node, text: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({ line: line + 1, text });
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      add(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      add(
        node,
        node.head.text + node.templateSpans.map((span) => "${}" + span.literal.text).join(""),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const files = walk(SRC)
  .filter((file) => /\.tsx?$/.test(file))
  .map((file) => path.relative(path.dirname(SRC), file).split(path.sep).join("/"))
  .filter((file) => file !== SELF);

const isRemovedRoute = (text: string) => REMOVED_ROUTE.test(text) || REPOSITORY_REVIEWS.test(text);

function scan(entries: { file: string; code: string }[]) {
  const hits: string[] = [];
  const used = new Set<Allowed>();
  for (const { file, code } of entries) {
    for (const { line, text } of literals(file, code)) {
      if (!isRemovedRoute(text)) continue;
      const allowed = ALLOWED.find((entry) => entry.files.test(file) && entry.text.test(text));
      if (allowed) used.add(allowed);
      else hits.push(`${file}:${line}: ${JSON.stringify(text)}`);
    }
  }
  return { hits, used };
}

describe("links to the removed run pages", () => {
  const { hits, used } = scan(
    files.map((file) => ({ file, code: readFileSync(path.join(path.dirname(SRC), file), "utf8") })),
  );

  it("scans the app's sources and tests (sanity check)", () => {
    expect(files).toContain("src/app/(app)/page.tsx");
    expect(files).toContain("src/lib/chat/agent/read-tools.ts");
    expect(files.some((file) => file.endsWith(".test.tsx"))).toBe(true);
  });

  it("finds an old route in literals and templates, and leaves other paths alone", () => {
    const sample = [
      'const a = "/coding";',
      "const b = `/ralph/${id}`;",
      'const c = "/reviews?status=failed";',
      "const d = `/triage#${id}`;",
      'const e = <a href="/jobs">Jobs</a>;',
      "const f = `/repositories/${id}/reviews?page=2`;",
      'const g = "/repositories/r1/reviews";',
      // Not the old routes.
      'const h = "/runs?kind=review";',
      'const i = "/api/ui/jobs/x/cancel";',
      'const j = "/codingx";',
      "const k = `/repositories/${id}/rules`;",
      'const l = "Reply `/coding` again.";',
    ].join("\n");
    expect(
      scan([{ file: "src/x.tsx", code: sample }]).hits.map((hit) => hit.split(": ")[1]),
    ).toEqual([
      '"/coding"',
      '"/ralph/${}"',
      '"/reviews?status=failed"',
      '"/triage#${}"',
      '"/jobs"',
      '"/repositories/${}/reviews?page=2"',
      '"/repositories/r1/reviews"',
    ]);
  });

  it("has none of the old pages, and no redirects to them", () => {
    for (const page of [
      "coding",
      "ralph",
      "reviews",
      "triage",
      "jobs",
      "repositories/[id]/reviews",
    ]) {
      expect(existsSync(path.join(SRC, "app/(app)", page)), page).toBe(false);
    }
    const config = readFileSync(path.join(SRC, "../next.config.ts"), "utf8");
    expect(config).not.toMatch(/\bredirects\b/);
  });

  it("finds no link to /coding, /ralph, /reviews, /triage, /jobs or a repository's reviews", () => {
    expect(hits).toEqual([]);
  });

  it("uses every allowed exception", () => {
    expect(ALLOWED.filter((entry) => !used.has(entry)).map((entry) => entry.reason)).toEqual([]);
  });
});
