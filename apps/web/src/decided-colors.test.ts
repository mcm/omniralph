import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Rule 15 and Decided `mint-and-lavender` (apps/web/DESIGN.md): lavender means needs you, mint
// good or running, coral failed. This scans every stylesheet and component of the panel,
// `@omniralph/ui` and the agent's local page for the three token families, and allows each use
// only where an entry below says why: lavender in the few component styles that mean needs you
// (and focus rings), mint and coral on selectors named for their state.

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Scanned, from the repository root: stylesheets and TS/TSX sources (string literals). */
const SCANNED = ["packages/ui/styles", "packages/ui/src", "apps/web/src", "apps/agent/ui/src"];

type Family = "lavender" | "mint" | "coral";

const FAMILIES: Record<Family, RegExp> = {
  lavender: /--or-(?:acc[\w-]*|halo|glow)\b/,
  mint: /--or-run[\w-]*/,
  coral: /--or-fail[\w-]*/,
};

/** One use of a token: the declaration (or literal) that names it, and where. */
interface Use {
  family: Family;
  file: string;
  line: number;
  /** The rule's selector (with its at-rules), or `null` for a TS literal. */
  selector: string | null;
  property: string | null;
  value: string;
}

interface Allowed {
  family: Family;
  /** Only in this file (path from the repository root). */
  file?: string;
  /** Every selector of the rule's list must match (nothing else with a comma slips in). */
  selector?: RegExp;
  property?: RegExp;
  reason: string;
}

/** Selectors named for a good or running state. */
const MINT_STATES = /[-_](?:run|running|good|add)\b/;
/** Selectors named for a failed state (or a destructive action, which fails what it removes). */
const CORAL_STATES =
  /[-_.[](?:alert|fail|failed|error|danger|bad|invalid|problems|missing|del|fatal)\b/;

const ALLOWED: Allowed[] = [
  // Every family: the tokens' own definitions.
  ...(["lavender", "mint", "coral"] as const).map((family): Allowed => ({
    family,
    file: "packages/ui/styles/tokens.css",
    property: /^--or-/,
    reason: "the token definitions, per theme",
  })),
  // Lavender.
  {
    family: "lavender",
    selector: /:focus(?:-visible|-within)?\b/,
    property: /^(?:outline|outline-color|border-color|box-shadow)$/,
    reason: "the focus indicator (WCAG 2.4.7), on every focusable control",
  },
  {
    family: "lavender",
    file: "packages/ui/styles/actions.css",
    selector: /^\.or-btn--primary\b/,
    reason: "the primary Button: the one button that clears a needs-you item (rule 6)",
  },
  {
    family: "lavender",
    file: "packages/ui/styles/shell.css",
    selector: /^\.or-(?:nav__count|topbar__alert)$/,
    reason: "the needs-you count badge in the navigation, and its dot on the phone's menu button",
  },
  {
    family: "lavender",
    file: "packages/ui/styles/controls.css",
    selector: /^\.or-tab__count--need$/,
    reason: "the needs-you count on a tab",
  },
  {
    family: "lavender",
    file: "packages/ui/styles/status.css",
    selector: /^\.or-(?:dot|status|statusline)--need$/,
    reason: "the needs-you status dot and status text",
  },
  {
    family: "lavender",
    file: "packages/ui/styles/surfaces.css",
    selector: /^\.or-(?:progress__seg|step)--waiting\b/,
    reason: "a progress step waiting on you (needs-you)",
  },
  {
    family: "lavender",
    file: "packages/ui/styles/content.css",
    selector: /^\.or-md (?:a|a:hover|\.task-list-item input\[type="checkbox"\])$/,
    reason: "links and task checkboxes in rendered Markdown (PRDs, Om's answers)",
  },
  {
    family: "lavender",
    file: "packages/ui/src/brand/glyph.tsx",
    reason: "the Cursor glyph's cursor is the brand accent (TOOL-575)",
  },
  // Mint and coral.
  {
    family: "mint",
    selector: MINT_STATES,
    reason: "good or running states (and a diff's added lines)",
  },
  {
    family: "coral",
    selector: CORAL_STATES,
    reason: "failed states, errors, invalid fields and destructive actions (and removed lines)",
  },
  {
    family: "coral",
    file: "apps/agent/ui/src/styles.css",
    selector: /^\.agent-log__line--(?:warn|error|fatal) \.agent-log__level$/,
    reason: "the log level of warning lines, which say something went wrong on the agent",
  },
];

function files(dir: string): string[] {
  return readdirSync(path.join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(?:css|tsx?)$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => path.join(dir, file));
}

/** Each declaration of a stylesheet with its rule's selector (nested at-rules joined by » ). */
function declarations(
  css: string,
): { selector: string; property: string; value: string; line: number }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const found: { selector: string; property: string; value: string; line: number }[] = [];
  const stack: string[] = [];
  let buffer = "";
  let line = 1;
  const flush = () => {
    const declaration = buffer.trim();
    buffer = "";
    const colon = declaration.indexOf(":");
    if (colon < 0 || stack.length === 0) return;
    found.push({
      selector: stack[stack.length - 1]!,
      property: declaration.slice(0, colon).trim(),
      value: declaration.slice(colon + 1).trim(),
      line,
    });
  };
  for (const char of text) {
    if (char === "\n") line++;
    if (char === "{") {
      stack.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
    } else if (char === "}") {
      flush();
      stack.pop();
    } else if (char === ";") {
      flush();
    } else {
      buffer += char;
    }
  }
  return found;
}

/** The token uses of one file. */
function usesIn(file: string, code: string): Use[] {
  const uses: Use[] = [];
  const familiesOf = (text: string) =>
    (Object.keys(FAMILIES) as Family[]).filter((family) => FAMILIES[family].test(text));
  if (file.endsWith(".css")) {
    for (const { selector, property, value, line } of declarations(code)) {
      for (const family of familiesOf(`${property}: ${value}`)) {
        uses.push({ family, file, line, selector, property, value });
      }
    }
    return uses;
  }
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      for (const family of familiesOf(node.text)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        uses.push({
          family,
          file,
          line: line + 1,
          selector: null,
          property: null,
          value: node.text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

/** A selector list's selectors: split on its top-level commas (not those in `:not(…)`). */
function selectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let part = "";
  for (const char of selector) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(part.trim());
      part = "";
    } else {
      part += char;
    }
  }
  return [...parts, part.trim()];
}

/** The entry that allows `use`, if any. */
function allowing(use: Use, allowed: readonly Allowed[]): Allowed | undefined {
  return allowed.find((entry) => {
    if (entry.family !== use.family) return false;
    if (entry.file !== undefined && entry.file !== use.file) return false;
    if (entry.selector !== undefined) {
      if (use.selector === null) return false;
      // The innermost rule's selectors (an at-rule's own prelude is in the stack, not here).
      const selectors = selectorList(use.selector);
      if (!selectors.every((part) => entry.selector!.test(part))) return false;
    }
    if (entry.property !== undefined && !entry.property.test(use.property ?? "")) return false;
    return true;
  });
}

const describeUse = (use: Use) =>
  `${use.file}:${use.line}: ${use.family} ${use.selector ?? "(literal)"} { ${use.property ?? ""}: ${use.value} }`;

describe("color tokens (rule 15)", () => {
  const scanned = SCANNED.flatMap(files);
  const uses = scanned.flatMap((file) => usesIn(file, readFileSync(path.join(root, file), "utf8")));

  it("scans the stylesheets and components of the panel, @omniralph/ui and the agent page", () => {
    expect(scanned).toContain("packages/ui/styles/status.css");
    expect(scanned).toContain("apps/web/src/screens/fleet/fleet.css");
    expect(scanned).toContain("apps/agent/ui/src/styles.css");
    expect(scanned).toContain("packages/ui/src/brand/glyph.tsx");
    for (const family of Object.keys(FAMILIES) as Family[]) {
      expect(uses.some((use) => use.family === family)).toBe(true);
    }
  });

  it.each(["lavender", "mint", "coral"] as const)(
    "uses %s only where the allowlist says why",
    (family) => {
      const unexplained = uses
        .filter((use) => use.family === family && !allowing(use, ALLOWED))
        .map(describeUse);
      expect(unexplained).toEqual([]);
    },
  );

  it("keeps every allowlist entry in use and explained", () => {
    const used = new Set(uses.map((use) => allowing(use, ALLOWED)));
    for (const entry of ALLOWED) {
      expect(used.has(entry), `${entry.family} ${entry.file ?? ""} ${entry.selector ?? ""}`).toBe(
        true,
      );
      expect(entry.reason.trim()).not.toBe("");
    }
  });
});

describe("the color scan", () => {
  const scan = (file: string, code: string) =>
    usesIn(file, code)
      .filter((use) => !allowing(use, ALLOWED))
      .map((use) => `${use.family} ${use.selector ?? "(literal)"}`);

  it("refuses lavender outside the needs-you styles and focus rings", () => {
    const css = [
      ".or-run-card__title { color: var(--or-acc); }",
      ".or-btn--primary { background: var(--or-acc); }",
      ".or-thing:focus-visible { outline: 2px solid var(--or-acc); }",
      ".or-thing:focus-visible { background: var(--or-halo); }",
      "@media (max-width: 768px) { .or-banner { border-color: var(--or-acc-hover); } }",
    ].join("\n");
    expect(scan("packages/ui/styles/actions.css", css)).toEqual([
      "lavender .or-run-card__title",
      "lavender .or-thing:focus-visible",
      "lavender .or-banner",
    ]);
  });

  it("allows mint and coral only on selectors named for their state", () => {
    const css = [
      ".or-dot--run { background: var(--or-run); }",
      ".or-card__title { color: var(--or-run); }",
      ".or-step--failed .or-step__label { color: var(--or-fail); }",
      ".or-step--failed, .or-step__label { color: var(--or-fail); }",
      ".or-tag { background: var(--or-fail-tint); }",
    ].join("\n");
    expect(scan("apps/web/src/screens/probe.css", css)).toEqual([
      "mint .or-card__title",
      "coral .or-step--failed, .or-step__label",
      "coral .or-tag",
    ]);
  });

  it("reads tokens in string literals, not in comments", () => {
    const code = [
      "// A row's tone: `bad` tints it with `--or-fail-tint`.",
      'const style = { color: "var(--or-acc)" };',
    ].join("\n");
    expect(scan("apps/web/src/screens/probe.tsx", code)).toEqual(["lavender (literal)"]);
  });
});
