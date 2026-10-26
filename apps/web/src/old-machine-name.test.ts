import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The machine that runs jobs was the "harness" until TOOL-570 renamed it to the "agent". This is
// `git grep -il harness` as a test: every tracked file whose path or text says "harness" is listed
// below with the reason it keeps the old word. A whole-file entry covers history and the code that
// has to name the old package; a `text` entry only allows those words, and anything else saying
// "harness" in that file fails.

const root = fileURLToPath(new URL("../../../", import.meta.url));

interface Allowed {
  /** Paths from the repository root: a file, or a directory ending in `/`. */
  paths: (string | RegExp)[];
  /** Only these words may say "harness" in the files (global); without it, the whole file. */
  text?: RegExp;
  reason: string;
}

/** What `import` and the docs about moving a machine name: the old package, binary, env var and config. */
const OLD_INSTALL =
  /@omniralph\/harness|omniralph-harness|OMNIRALPH_HARNESS_CONFIG|harness\.json|moving-from-omniralphharness/gi;
/** Links to ADRs whose filenames keep the old word. */
const ADR_LINKS = /0008-agents-tasks-and-the-harness\.md|0010-harness-becomes-agent\.md/g;

const ALLOWED: Allowed[] = [
  {
    paths: [
      /^packages\/db\/drizzle\/0(0[0-9]{2}|10[0-4])_[^/]*\.sql$/,
      /^packages\/db\/drizzle\/meta\/0(0[0-9]{2}|10[0-2])_snapshot\.json$/,
      "packages/db/drizzle/meta/_journal.json",
    ],
    reason:
      "migrations up to this epic's two (0103, 0104) and their snapshots and journal tags are history",
  },
  {
    paths: ["packages/db/src/migrate.test.ts"],
    reason: "migration tests insert rows under the old table names and check the rename keeps them",
  },
  {
    paths: [/^docs\/adr\/00(0[1-9]|10)-[^/]*\.md$/],
    reason: "ADRs 0001–0009 keep their text as history; ADR 0010 records the rename",
  },
  { paths: ["apps/agent/CHANGELOG.md"], reason: "release history of @omniralph/harness versions" },
  {
    paths: [".impeccable/critique/"],
    reason: "dated design critiques of the screens as they were, kept as history",
  },
  {
    paths: [
      "apps/agent/src/import.ts",
      "apps/agent/src/import.test.ts",
      "apps/agent/src/test/fixtures/import/",
      "scripts/smoke-agent-package.sh",
    ],
    reason: "`omniralph-agent import` reads an @omniralph/harness install; its fixtures are one",
  },
  {
    paths: ["apps/agent/src/main.ts", "apps/agent/src/main.test.ts"],
    text: /@omniralph\/harness|OMNIRALPH_HARNESS_CONFIG|harness\.json|not\.toMatch\(\/harness\/i\)/g,
    reason: "the usage text's `import` section names the old package, env var and config",
  },
  {
    paths: [
      "scripts/check-agent-changeset.ts",
      "scripts/check-harness-changeset.ts",
      "scripts/rewrite-legacy-changesets.ts",
      "apps/agent/src/release/check-agent-changeset.test.ts",
      "apps/agent/src/release/rewrite-legacy-changesets.test.ts",
    ],
    reason:
      "other 2.0 epics write @omniralph/harness changesets until cutover; the check accepts them, the rewrite renames them, the wrapper keeps the old command path (Epic 14 removes all three)",
  },
  {
    paths: [".github/workflows/publish-agent.yml"],
    text: /@omniralph\/harness changesets/g,
    reason: "the comment on the version script that rewrites legacy changesets",
  },
  {
    paths: [/^\.changeset\/[^/]*\.md$/],
    reason: "this epic's pending release notes say what was renamed from what",
  },
  {
    paths: ["apps/web/src/user-facing-wording.test.ts", "apps/web/src/old-machine-name.test.ts"],
    reason: "the tests that keep the old word out of copy and out of the repository",
  },
  {
    paths: [
      "apps/web/src/app/api/agent/agent-auth.test.ts",
      "apps/web/src/app/api/agent/routes.test.ts",
      "apps/web/src/app/api/ui/removed-routes.test.ts",
      "apps/web/src/lib/agent-auth/signer.test.ts",
      "apps/web/src/lib/auth/routes.test.ts",
      "apps/web/src/proxy.test.ts",
      "apps/web/src/lib/run-model/attempt-labels.test.ts",
      "apps/web/src/lib/webhooks/reasons.test.ts",
    ],
    reason:
      "tests that the old routes, token audience, claims and words are gone or rejected name them",
  },
  {
    paths: ["apps/agent/README.md"],
    text: new RegExp(
      `${OLD_INSTALL.source}|${/check-harness-changeset\.ts/.source}`,
      OLD_INSTALL.flags,
    ),
    reason: "the From @omniralph/harness and legacy-changeset sections",
  },
  {
    paths: ["docs/deploy-agent.md", "docs/env.md"],
    text: new RegExp(`${OLD_INSTALL.source}|${ADR_LINKS.source}`, OLD_INSTALL.flags),
    reason: "Moving from @omniralph/harness, and where only `import` reads the old config",
  },
  {
    paths: [
      "README.md",
      "docs/chat.md",
      "docs/definitions.md",
      "docs/installables.md",
      "docs/linear.md",
    ],
    text: new RegExp(`${ADR_LINKS.source}|ADR 0010: the harness becomes the agent`, "g"),
    reason: "links to ADRs by filename, and ADR 0010's title in the README's ADR list",
  },
  {
    paths: ["apps/web/src/definitions-docs.test.ts", "apps/web/src/docs-links.test.ts"],
    text: new RegExp(
      `${ADR_LINKS.source}|Moving from @omniralph\\/harness|${OLD_INSTALL.source}`,
      "gi",
    ),
    reason:
      "docs tests read ADR 0008 by filename and check the Moving from @omniralph/harness anchor",
  },
];

function matches(pattern: string | RegExp, file: string): boolean {
  if (typeof pattern !== "string") return pattern.test(file);
  return pattern.endsWith("/") ? file.startsWith(pattern) : file === pattern;
}

function allowedFor(file: string): Allowed | undefined {
  return ALLOWED.find((rule) => rule.paths.some((pattern) => matches(pattern, file)));
}

/** Why `file` (path and text) may not say "harness", or [] when it may. */
function problems(file: string, text: string): string[] {
  const rule = allowedFor(file);
  if (rule && !rule.text) return [];
  const found: string[] = [];
  if (/harness/i.test(file)) found.push(`${file}: the path says "harness"`);
  text.split("\n").forEach((line, index) => {
    const rest = rule?.text ? line.replace(rule.text, "") : line;
    if (/harness/i.test(rest)) found.push(`${file}:${index + 1}: ${line.trim().slice(0, 160)}`);
  });
  return found;
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => file && existsSync(path.join(root, file)));
}

describe("the old machine name", () => {
  it("is only in the allowlisted files, as `git grep -il harness` would list them", () => {
    const found = trackedFiles().flatMap((file) =>
      problems(file, readFileSync(path.join(root, file), "utf8")),
    );
    expect(found).toEqual([]);
  });

  it("has no allowlist entry that matches nothing", () => {
    const files = trackedFiles();
    const unused = ALLOWED.flatMap((rule) => rule.paths).filter(
      (pattern) =>
        !files.some((file) => matches(pattern, file)) &&
        !(typeof pattern === "string" && existsSync(path.join(root, pattern))),
    );
    // apps/agent/CHANGELOG.md appears with the first Version Packages pull request.
    expect(unused).toEqual(["apps/agent/CHANGELOG.md"]);
  });

  it("flags a harness word in a file or path that isn't allowlisted", () => {
    expect(problems("apps/web/src/lib/agents/x.ts", 'const a = "Harness";')).toEqual([
      'apps/web/src/lib/agents/x.ts:1: const a = "Harness";',
    ]);
    expect(problems("apps/web/src/harness.ts", "")).toEqual([
      'apps/web/src/harness.ts: the path says "harness"',
    ]);
    expect(problems("packages/db/drizzle/0105_new.sql", "ALTER TABLE harnesses;")).toHaveLength(1);
  });

  it("allows only the listed words in a partly allowlisted file", () => {
    expect(problems("docs/env.md", "Only `import` reads `OMNIRALPH_HARNESS_CONFIG`.")).toEqual([]);
    expect(problems("docs/env.md", "The harness reads it.")).toEqual([
      "docs/env.md:1: The harness reads it.",
    ]);
    expect(
      problems("README.md", "[ADR 0008](docs/adr/0008-agents-tasks-and-the-harness.md)"),
    ).toEqual([]);
  });
});
