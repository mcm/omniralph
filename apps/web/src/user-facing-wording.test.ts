import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_NOTICE_MESSAGE } from "@omniralph/ui";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  AGO,
  BANNED_HINTS,
  bannedIn,
  DOCUMENT_REVISION_DATE,
  LIVE_INDICATOR_ALLOWED,
  LIVE_INDICATORS,
  REFRESH_CONTROL,
} from "@/lib/copy/banned-hints";

// The machine that runs jobs is the "agent" and the AI is "Om" (TOOL-570); the product says
// "Coding" / "Coding tasks", never "Ralph" (TOOL-419). This scans the control panel's pages and
// components and the modules that build Omniralph's Linear, GitHub/GitLab and chat messages for
// "ralph" as a word and "harness" anywhere in JSX text, string literals and template literals ("harness"
// also in the agent, its shared packages and the release scripts). Code identifiers aren't
// strings, so they don't count; import paths and log messages (console.*) aren't shown to
// anyone, so they're skipped too. Everything else that has to keep an old word is in its rule's
// allowlist below, with the reason.
//
// The same scan guards two Decided items (apps/web/DESIGN.md) in the panel, `@omniralph/ui` and
// the agent's local page: no hint text about where things are (`lib/copy/banned-hints.ts`,
// rule 3) and no "Live" or "Updated" indicator (rules 9 and 22).

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
  // The agent's local page.
  "apps/agent/ui/src",
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
    text: /^(ralph:active|ralph:reconciled|ralph:backoff|ralph-active)$/g,
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
  word: { test(text: string): boolean };
  scanned: string[];
  allowed: Allowed[];
}

const RALPH: Rule = { word: /\bralph\b/i, scanned: SCANNED, allowed: RALPH_ALLOWED };
const HARNESS: Rule = { word: /harness/i, scanned: HARNESS_SCANNED, allowed: HARNESS_ALLOWED };

/** Scanned for hint text and indicators: the "ralph" scan's files and `@omniralph/ui`. */
const COPY_SCANNED = [...SCANNED, "packages/ui/src"];

const HINT_ALLOWED: Allowed[] = [];

/** Hint text about where things are (rule 3, Decided `no-location-hints`). */
const HINTS: Rule = {
  word: { test: (text) => bannedIn(text, BANNED_HINTS).length > 0 },
  scanned: COPY_SCANNED,
  allowed: HINT_ALLOWED,
};

const INDICATOR_ALLOWED: Allowed[] = [
  {
    text: new RegExp(DOCUMENT_REVISION_DATE.source, "g"),
    files: ["apps/web/src/app/(legal)/privacy/page.tsx", "apps/web/src/app/(legal)/terms/page.tsx"],
    reason: "the legal document's revision date, not the page's freshness",
  },
  {
    text: /^Updated$/g,
    files: ["apps/web/src/lib/ralph/publish.ts"],
    reason:
      'the comment posted on the pull request ("Updated <link>, ready for review"), not the UI',
  },
  {
    text: new RegExp(`^${LIVE_INDICATOR_ALLOWED.map(escapeRegExp).join("|")}$`, "g"),
    files: ["packages/ui/src/feedback/live-notice.tsx"],
    reason: "`LiveNotice`, shown only while live updates have stopped",
  },
];

/** A "Live" or "Updated" indicator (rules 9 and 22, Decided `no-live-indicator`). */
const INDICATORS: Rule = {
  word: { test: (text) => bannedIn(text, LIVE_INDICATORS).length > 0 },
  scanned: COPY_SCANNED,
  allowed: INDICATOR_ALLOWED,
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

/** Whether a file renders a refresh control: the refresh icon, or a control named Refresh. */
function rendersRefresh(code: string): boolean {
  return (
    /\bIconRefresh\b|\bIconReload\b/.test(code) ||
    literalTexts("probe.tsx", code).some(({ text }) => REFRESH_CONTROL.test(text))
  );
}

/** "… ago" in the literals of files that also render a refresh control. */
function agoNextToRefresh(
  files: string[],
  read = (file: string) => readFileSync(path.join(root, file), "utf8"),
): Hit[] {
  return files.flatMap((file) => {
    const code = read(file);
    if (!rendersRefresh(code)) return [];
    return literalTexts(file, code)
      .filter(({ text }) => AGO.test(text))
      .map(({ node, text }) => {
        const source = node.getSourceFile();
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        return { file, line: line + 1, text: text.trim().slice(0, 120) };
      });
  });
}

const describeHits = (hits: Hit[]) =>
  hits.map((hit) => `${hit.file}:${hit.line}: ${JSON.stringify(hit.text)}`);

describe("user-facing wording", () => {
  const files = SCANNED.flatMap(sourceFiles);
  const harnessFiles = HARNESS_SCANNED.flatMap(sourceFiles);
  const copyFiles = COPY_SCANNED.flatMap(sourceFiles);
  const ralph = scan(RALPH, files);
  const harness = scan(HARNESS, harnessFiles);
  const hints = scan(HINTS, copyFiles);
  const indicators = scan(INDICATORS, copyFiles);

  it("scans the pages, components and message builders", () => {
    expect(files).toContain("apps/web/src/app/(app)/runs/page.tsx");
    expect(files).toContain("apps/web/src/screens/inbox/inbox-view.tsx");
    expect(files).toContain("apps/web/src/screens/repos/repo-detail-view.tsx");
    expect(files).toContain("apps/web/src/screens/repos/agents-card.tsx");
    expect(files).toContain("apps/web/src/components/connection-health.tsx");
    expect(files).toContain("apps/web/src/lib/linear/webhook.ts");
    expect(files).toContain("apps/agent/ui/src/shell.tsx");
    expect(files).toContain("apps/agent/ui/src/app.tsx");
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

  it("scans @omniralph/ui and the agent's local page for hint text and indicators", () => {
    expect(copyFiles).toEqual(expect.arrayContaining(files));
    expect(copyFiles).toContain("packages/ui/src/feedback/live-notice.tsx");
    expect(copyFiles).toContain("apps/agent/ui/src/shell.tsx");
    expect(copyFiles.some((file) => file.endsWith(".test.tsx"))).toBe(false);
  });

  it("shows no hint text about where things are (rule 3)", () => {
    expect(describeHits(hints.hits)).toEqual([]);
  });

  it('shows no "Live" or "Updated" indicator (rules 9 and 22)', () => {
    expect(describeHits(indicators.hits)).toEqual([]);
  });

  it('shows no "… ago" in a file that renders a refresh control (an "Updated" indicator)', () => {
    expect(describeHits(agoNextToRefresh(copyFiles))).toEqual([]);
  });

  it("allows only LiveNotice's text, which is what LiveNotice says", () => {
    expect(LIVE_INDICATOR_ALLOWED).toEqual([LIVE_NOTICE_MESSAGE]);
  });

  it.each([
    ["ralph", RALPH, () => ralph.used],
    ["harness", HARNESS, () => harness.used],
    ["hint", HINTS, () => hints.used],
    ["indicator", INDICATORS, () => indicators.used],
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

describe("the hint text and indicator scans", () => {
  it.each(BANNED_HINTS.map((phrase) => [phrase.id, phrase.example]))(
    "the hint rule catches %s: %s",
    (_id, example) => {
      const { hits } = scan(HINTS, ["probe.tsx"], () => `const a = <p>${example}</p>;`);
      expect(hits.map((hit) => hit.text)).toEqual([example]);
    },
  );

  it.each(LIVE_INDICATORS.map((phrase) => [phrase.id, phrase.example]))(
    "the indicator rule catches %s: %s",
    (_id, example) => {
      const { hits } = scan(INDICATORS, ["probe.tsx"], () => `const a = "${example}";`);
      expect(hits.map((hit) => hit.text)).toEqual([example]);
    },
  );

  it("keeps text that says what a setting does or what a change causes", () => {
    const code = [
      "const a = <p>Om reviews every pull request opened in this repo.</p>;",
      'const b = "Turning Coding off stops new runs; running ones finish.";',
      'const c = "Updates install when the agent is idle.";',
      'const d = "Delivered";',
      'const e = "Live updates stopped. Retrying…";',
      "const f = <Link href={href}>Open in Runs</Link>;",
    ].join("\n");
    expect(scan(HINTS, ["probe.tsx"], () => code).hits).toEqual([]);
    expect(
      scan(INDICATORS, ["apps/web/src/app/probe.tsx"], () => code).hits.map((hit) => hit.text),
    ).toEqual(["Live updates stopped. Retrying…"]);
    expect(scan(INDICATORS, ["packages/ui/src/feedback/live-notice.tsx"], () => code).hits).toEqual(
      [],
    );
  });

  it('finds "… ago" only in files that render a refresh control', () => {
    const withRefresh = [
      'import { IconRefresh } from "@tabler/icons-react";',
      "const a = <span>{`${minutes}m ago`}</span>;",
      'const b = <IconButton icon={IconRefresh} label="Reload" />;',
    ].join("\n");
    const without = "const a = <span>{`${minutes}m ago`}</span>;";
    expect(agoNextToRefresh(["a.tsx"], () => withRefresh).map((hit) => hit.text)).toEqual([
      "m ago",
    ]);
    expect(agoNextToRefresh(["b.tsx"], () => without)).toEqual([]);
  });
});
