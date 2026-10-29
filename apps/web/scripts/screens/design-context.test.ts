import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DECIDED_CHECKS } from "./checks";
import { ACCESSIBILITY_CHECKS } from "./ignore";
import { SCREEN_ROUTES } from "./routes";

/**
 * The design context every critique round and fix story judges the UI against: the Design
 * rules and Decided items in `DESIGN.md`, the matching `decided:` rows in the critique ignore
 * list, and the canvas boards' routes.
 */

const WEB = join(__dirname, "../..");
const read = (path: string) => readFileSync(join(WEB, path), "utf8");
const DESIGN = read("DESIGN.md");
const PRODUCT = read("PRODUCT.md");
const IGNORE = read("../../.impeccable/critique/ignore.md");

/** The body of a `##` section, up to the next `##` heading. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`DESIGN.md has no "## ${heading}" section`);
  const body = markdown.slice(start + heading.length + 5);
  const end = body.search(/\n## /);
  return end < 0 ? body : body.slice(0, end);
}

/** The numbered items of a markdown list, by number. */
function numberedItems(markdown: string): { number: number; text: string }[] {
  return [...markdown.matchAll(/^(\d+)\. (.+)$/gm)].map((match) => ({
    number: Number(match[1]),
    text: match[2]!,
  }));
}

/** The body rows of the markdown tables in `markdown`, as trimmed cells. */
function tableRows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|[\s|:-]+\|$/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
}

/**
 * A decided item: `` N. `slug` (rule N): what is decided. _Why:_ reason Guard: guards. `` (the
 * rule optional). The guards are test files (paths from the repository root) and capture
 * checks (`capture check \`name\``).
 */
const DECIDED_ITEM = /^`([a-z0-9-]+)`(?: \(rules? [^)]+\))?: (.+?) _Why:_ (.+?) Guard: (.+)$/;

function decidedItems() {
  return numberedItems(section(DESIGN, "Decided — never flag, never undo")).map((item) => {
    const match = DECIDED_ITEM.exec(item.text);
    if (!match) {
      throw new Error(`Decided item ${item.number} is not "\`slug\`: … _Why:_ … Guard: …"`);
    }
    const guard = match[4]!;
    const captureChecks = [...guard.matchAll(/capture check `([^`]+)`/g)].map((m) => m[1]!);
    const files = [...guard.replace(/capture check `[^`]+`/g, "").matchAll(/`([^`]+)`/g)].map(
      (m) => m[1]!,
    );
    return { number: item.number, slug: match[1]!, reason: match[3]!, files, captureChecks };
  });
}

/** The route pattern a `page.tsx` serves, e.g. `(app)/runs/[id]/page.tsx` → `/runs/[id]`. */
function pageRoute(page: string): string {
  const segments = page
    .split("/")
    .slice(0, -1)
    .filter((segment) => !/^\(.*\)$/.test(segment));
  return `/${segments.join("/")}`;
}

describe("DESIGN.md", () => {
  it("lists the Design rules numbered 1 to 24", () => {
    const rules = numberedItems(section(DESIGN, "Design rules"));
    expect(rules.map((rule) => rule.number)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
  });

  it("lists the 12 Decided items, numbered in order with unique names", () => {
    const items = decidedItems();
    expect(items.map((item) => item.number)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(new Set(items.map((item) => item.slug)).size).toBe(12);
  });

  it("names each Decided item's guards: test files that exist, capture checks verify reports", () => {
    for (const item of decidedItems()) {
      expect([...item.files, ...item.captureChecks], item.slug).not.toEqual([]);
      for (const file of item.files) {
        expect(file, item.slug).toMatch(/\.test\.tsx?$/);
        expect(() => readFileSync(join(WEB, "../..", file)), `${item.slug}: ${file}`).not.toThrow();
      }
      for (const check of item.captureChecks) {
        expect(DECIDED_CHECKS as readonly string[], `${item.slug}: ${check}`).toContain(check);
      }
    }
  });

  it("guards every Decided check verify reports with at least one Decided item", () => {
    const named = new Set(decidedItems().flatMap((item) => item.captureChecks));
    expect(DECIDED_CHECKS.filter((check) => !named.has(check))).toEqual([]);
  });

  it("maps every canvas board to routes the screenshot matrix captures", () => {
    const captured = new Set(SCREEN_ROUTES.map((route) => pageRoute(route.page)));
    const rows = tableRows(section(DESIGN, "Canvas boards"));
    expect(rows[0]?.[0]).toBe("Board");
    const boards = rows.slice(1);
    expect(boards.map(([board]) => board)).toEqual([
      "Main",
      "InboxUVL",
      "InboxEmpty",
      "Runs",
      "Backlog",
      "Repos",
      "Fleet",
      "Ask",
      "Settings",
      "CursorAvatars",
      "MobileInbox",
      "MobileMenu",
      "MobileRun",
      "MobileAsk",
    ]);
    for (const [board, routes] of boards) {
      const named = [...routes!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
      expect(named, board).not.toEqual([]);
      for (const route of named) expect(captured, `${board}: ${route}`).toContain(route);
    }
  });
});

describe("the critique ignore list", () => {
  const rows = tableRows(IGNORE).slice(1);
  const decidedRows = rows.filter(([rule]) => rule!.startsWith("decided: "));

  it("has one decided row per Decided item, with the same reason", () => {
    const items = decidedItems();
    expect(decidedRows.map(([rule]) => rule)).toEqual(items.map((item) => `decided: ${item.slug}`));
    for (const [rule, scope, reason, round] of decidedRows) {
      const item = items.find((candidate) => `decided: ${candidate.slug}` === rule)!;
      expect(reason, rule).toBe(item.reason);
      expect(scope, rule).toBe(
        "2.0 code: `apps/web/src`, `packages/ui/src`, the agent's local UI source",
      );
      expect(round, rule).toBe("TOOL-730");
    }
  });

  it("scopes every other critique entry to files that exist", () => {
    // Accessibility entries (`axe: …`, `keyboard: …`) are scoped to captures (ignore.test.ts).
    const others = rows.filter(
      ([rule]) =>
        !rule!.startsWith("decided: ") &&
        !ACCESSIBILITY_CHECKS.some((check) => rule!.replace(/`/g, "").startsWith(`${check}:`)),
    );
    for (const [rule, scope] of others) {
      const paths = [...scope!.matchAll(/`([^`]*\/[^`]*)`/g)].map((match) => match[1]!);
      expect(paths, rule).not.toEqual([]);
      for (const path of paths)
        expect(() => readFileSync(join(WEB, "../..", path)), path).not.toThrow();
    }
  });
});

describe("PRODUCT.md", () => {
  it("keeps the impeccable product schema marker", () => {
    expect(PRODUCT).toContain("<!-- impeccable:product-schema 1 -->");
  });

  it("has no persona framing", () => {
    expect(PRODUCT).not.toMatch(/morning-after|persona/i);
  });
});
