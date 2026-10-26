import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The machine that runs jobs is the "agent" and the AI is "Om" (TOOL-570); the product says
// "Coding" / "Coding tasks", never "Ralph" (TOOL-419). This scans the control panel's pages and
// components and the modules that build Omniralph's Linear, GitHub/GitLab and chat messages for
// "ralph" as a word and "harness" anywhere in JSX text, string literals and template literals ("harness"
// also in the agent, its shared packages and the release scripts). Code identifiers aren't
// strings, so they don't count; import paths and log messages (console.*) aren't shown to
// anyone, so they're skipped too. Everything else that has to keep an old word is in its rule's
// allowlist below, with the reason.

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Directories (and files) scanned for "ralph", from the repository root. */
const SCANNED = [
  "apps/web/src/app",
  "apps/web/src/components",
  "apps/web/src/screens",
  "apps/web/next.config.ts",
  "apps/web/src/lib/navigation.ts",
  // Linear, GitHub/GitLab and chat messages.
  "apps/web/src/lib/chat",
  "apps/web/src/lib/linear",
  "apps/web/src/lib/mentions",
  "apps/web/src/lib/ralph",
  "apps/web/src/lib/review",
  "apps/web/src/lib/reviews",
  "apps/web/src/lib/runs",
  "apps/web/src/lib/scm",
  "apps/web/src/lib/sinks",
  "apps/web/src/lib/triage",
  "packages/ralph/src",
  // Built-in playbooks: their descriptions and prompts are served by the Playbooks API.
  "packages/tasks/src/builtin",
];

interface Allowed {
  /** Text inside a literal that may keep the word (global, so every occurrence is removed). */
  text: RegExp;
  /** Files (paths from the repository root, or their endings) the exception applies to. */
  files: string[];
  reason: string;
}

const RALPH_ALLOWED: Allowed[] = [
  {
    text: /\bralph\.[a-z-]*/g,
    files: [
      "apps/web/src/app/api/agent/credentials/route.ts",
      "apps/web/src/lib/chat/agent/read-tools.ts",
    ],
    reason: "job types (`ralph.story`, the `ralph.` prefix) stored with every job",
  },
  {
    text: /^analytics-ralph$/g,
    files: ["apps/web/src/app/(app)/analytics/analytics-view.tsx"],
    reason: "element id of the analytics Coding section; never shown",
  },
  {
    text: /^ralph-run$/g,
    files: [
      "apps/web/src/lib/ralph/coding.ts",
      "apps/web/src/lib/sinks/ralph-run.ts",
      "apps/web/src/lib/sinks/run-result.ts",
      "packages/tasks/src/builtin/handle-request.ts",
      "packages/tasks/src/builtin/implement-story.ts",
    ],
    reason: "the `ralph-run` sink kind, stored with task definitions and jobs",
  },
  {
    text: /^(ralph|ralph-run|ralph-cleanup|ralph-hidden-refs|ralph-thread-notice):$/g,
    files: [
      "apps/web/src/lib/chat/run-events.ts",
      "apps/web/src/lib/ralph/run.ts",
      "apps/web/src/lib/ralph/cleanup.ts",
      "apps/web/src/lib/ralph/hidden-refs.ts",
      "apps/web/src/lib/ralph/chat-notify.ts",
    ],
    reason: "prefixes of idempotency and lock keys stored in the database",
  },
  {
    text: /^(ralph:active|ralph:reconciled|ralph-active)$/g,
    files: ["apps/web/src/lib/ralph/active.ts"],
    reason: "the reconcile cron's Redis keys and hot-state rebuilder name",
  },
  {
    text: /\(people may also call them ralph runs, their old name\)/g,
    files: ["apps/web/src/lib/chat/agent/prompt.ts"],
    reason: "tells the chat assistant the old name, so it understands people who still use it",
  },
  {
    text: /^ralph metadata$/g,
    files: ["packages/ralph/src/story-body.ts"],
    reason: "reads the legacy `## Ralph Metadata` section of issues written by older versions",
  },
  {
    text: /`## Ralph Metadata`/g,
    files: ["packages/ralph/src/triage.ts", "packages/tasks/src/builtin/triage.ts"],
    reason: "tells triage to drop the legacy `## Ralph Metadata` section from issues",
  },
];

/** Also scanned for "harness": the agent, the packages it bundles and the release scripts. */
const HARNESS_SCANNED = [
  ...SCANNED,
  "apps/agent/src",
  "packages/tasks/src",
  "packages/shared/src",
  "scripts/check-agent-changeset.ts",
  "scripts/rewrite-legacy-changesets.ts",
];

const HARNESS_ALLOWED: Allowed[] = [
  {
    text: /@omniralph\/harness\b/g,
    files: ["apps/agent/src/import.ts", "apps/agent/src/main.ts"],
    reason: "`omniralph-agent import` names the old package it brings a config over from",
  },
  {
    text: /^omniralph-harness$/g,
    files: ["apps/agent/src/import.ts"],
    reason: "`import` looks for the old binary's running daemon (pm2 and /proc)",
  },
  {
    text: /\$?OMNIRALPH_HARNESS_CONFIG\b/g,
    files: ["apps/agent/src/import.ts", "apps/agent/src/main.ts"],
    reason: "`import` reads the old config's path from the old env var",
  },
  {
    text: /(~\/\.config\/omniralph\/)?harness\.json\b/g,
    files: ["apps/agent/src/import.ts", "apps/agent/src/main.ts"],
    reason: "`import` reads the old config file",
  },
  {
    text: /^@omniralph\/harness$/g,
    files: ["scripts/check-agent-changeset.ts"],
    reason: "legacy changesets: other 2.0 epics write them until Epic 14 removes the old name",
  },
];

interface Rule {
  word: RegExp;
  scanned: string[];
  allowed: Allowed[];
}

const RALPH: Rule = { word: /\bralph\b/i, scanned: SCANNED, allowed: RALPH_ALLOWED };
const HARNESS: Rule = { word: /harness/i, scanned: HARNESS_SCANNED, allowed: HARNESS_ALLOWED };

function sourceFiles(entry: string): string[] {
  const full = path.join(root, entry);
  if (!statSync(full).isDirectory()) return [entry];
  return readdirSync(full, { withFileTypes: true }).flatMap((dirent) => {
    const child = path.join(entry, dirent.name);
    if (dirent.isDirectory()) {
      return dirent.name === "node_modules" || dirent.name.startsWith("__")
        ? []
        : sourceFiles(child);
    }
    return /\.tsx?$/.test(dirent.name) && !/\.test\.tsx?$/.test(dirent.name) ? [child] : [];
  });
}

/** Literals whose text is never shown: import paths and log messages. */
function isSkipped(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isExternalModuleReference(parent)) return true;
  for (let current: ts.Node | undefined = parent; current; current = current.parent) {
    if (!ts.isCallExpression(current)) continue;
    if (current.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
    const callee = current.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "console"
    ) {
      return true;
    }
  }
  return false;
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function literalTexts(file: string, code: string): { node: ts.Node; text: string }[] {
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: { node: ts.Node; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      if (!isSkipped(node)) found.push({ node, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Hits of the rule's word left after removing the allowed text, and the allowed entries used. */
function scan(
  rule: Rule,
  files: string[],
  read = (file: string) => readFileSync(path.join(root, file), "utf8"),
): { hits: Hit[]; used: Set<Allowed> } {
  const hits: Hit[] = [];
  const used = new Set<Allowed>();
  for (const file of files) {
    const allowed = rule.allowed.filter((entry) => entry.files.some((f) => file.endsWith(f)));
    for (const { node, text } of literalTexts(file, read(file))) {
      if (!rule.word.test(text)) continue;
      let rest = text;
      for (const entry of allowed) {
        const next = rest.replace(entry.text, "");
        if (next !== rest) used.add(entry);
        rest = next;
      }
      if (!rule.word.test(rest)) continue;
      const source = node.getSourceFile();
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      hits.push({ file, line: line + 1, text: text.trim().slice(0, 120) });
    }
  }
  return { hits, used };
}

const describeHits = (hits: Hit[]) =>
  hits.map((hit) => `${hit.file}:${hit.line}: ${JSON.stringify(hit.text)}`);

describe("user-facing wording", () => {
  const files = SCANNED.flatMap(sourceFiles);
  const harnessFiles = HARNESS_SCANNED.flatMap(sourceFiles);
  const ralph = scan(RALPH, files);
  const harness = scan(HARNESS, harnessFiles);

  it("scans the pages, components and message builders", () => {
    expect(files).toContain("apps/web/src/app/(app)/runs/page.tsx");
    expect(files).toContain("apps/web/src/screens/inbox/inbox-view.tsx");
    expect(files).toContain("apps/web/src/lib/linear/webhook.ts");
    expect(files.some((file) => file.endsWith(".test.ts"))).toBe(false);
  });

  it("scans the agent, its shared packages and the release scripts for harness too", () => {
    expect(harnessFiles).toEqual(expect.arrayContaining(files));
    expect(harnessFiles).toContain("apps/agent/src/import.ts");
    expect(harnessFiles).toContain("packages/tasks/src/builtin/triage.ts");
    expect(harnessFiles).toContain("packages/shared/src/agent-protocol.ts");
    expect(harnessFiles.some((file) => file.endsWith(".test.ts"))).toBe(false);
  });

  it('calls the AI "Om", never "Ralph", in what Omniralph shows or posts', () => {
    expect(describeHits(ralph.hits)).toEqual([]);
  });

  it('calls the machine "agent", never "harness", in what Omniralph shows or posts', () => {
    expect(describeHits(harness.hits)).toEqual([]);
  });

  it.each([
    ["ralph", RALPH, () => ralph.used],
    ["harness", HARNESS, () => harness.used],
  ])("keeps every %s allowlist entry in use and explained", (_word, rule, used) => {
    const unused = rule.allowed
      .filter((entry) => !used().has(entry))
      .map((entry) => String(entry.text));
    expect(unused).toEqual([]);
    for (const entry of rule.allowed) expect(entry.reason.trim()).not.toBe("");
  });
});

describe("the wording scan", () => {
  it("finds the word in JSX text, strings and templates, not in identifiers or imports", () => {
    const code = [
      'import { ralph } from "@/lib/ralph/run";',
      "const ralphRun = ralph;",
      "const a = <p>Start a Ralph run</p>;",
      'const b = "ralph";',
      "const c = `Ralph ${ralphRun}`;",
      'console.error("Advancing ralph run failed");',
      'const d = "Omniralph";',
    ].join("\n");
    const texts = literalTexts("probe.tsx", code)
      .map(({ text }) => text)
      .filter((text) => RALPH.word.test(text));
    expect(texts).toEqual(["Start a Ralph run", "ralph", "Ralph "]);
  });

  it("finds harness in JSX text, strings and templates, not in identifiers, imports or logs", () => {
    const code = [
      'import { harnessName } from "@/lib/harnesses/display";',
      "const harness = harnessName;",
      "const a = <Button>Enroll harness</Button>;",
      'const b = "No harnesses yet";',
      "const c = `Saved — waiting for ${harness} harness`;",
      'console.warn("harness went away");',
      'const d = "omniralph-agent";',
    ].join("\n");
    const { hits } = scan(HARNESS, ["probe.tsx"], () => code);
    expect(hits.map((hit) => hit.text)).toEqual(["Enroll harness", "No harnesses yet", "harness"]);
  });

  it("allows the old names only in the files their entry names", () => {
    const code = [
      'const pkg = "@omniralph/harness";',
      'const env = "OMNIRALPH_HARNESS_CONFIG";',
      'const file = "harness.json";',
    ].join("\n");
    expect(scan(HARNESS, ["apps/agent/src/import.ts"], () => code).hits).toEqual([]);
    expect(
      scan(HARNESS, ["apps/web/src/app/probe.tsx"], () => code).hits.map((hit) => hit.text),
    ).toEqual(["@omniralph/harness", "OMNIRALPH_HARNESS_CONFIG", "harness.json"]);
  });
});
