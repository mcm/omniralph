// Tests scripts/check-agent-changeset.ts, the CI check that agent changes come with a
// changeset. It lives at the repo root (CI runs it with tsx); it's tested here so
// `pnpm turbo run test` covers it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  agentPackageDirs,
  changesetReleases,
  checkAgentChangeset,
  isChangesetPath,
  main,
  touchedPackageDirs,
} from "../../../../scripts/check-agent-changeset.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const PACKAGE_DIRS = [
  "apps/agent",
  "packages/engine",
  "packages/tasks",
  "packages/ralph",
  "packages/shared",
];

const agentPatch = {
  path: ".changeset/brave-dogs-run.md",
  content: '---\n"@omniralph/agent": patch\n---\n\nFix the thing.\n',
};
const legacyMinor = {
  path: ".changeset/calm-owls-sing.md",
  content: '---\n"@omniralph/harness": minor\n---\n\nAdd the thing.\n',
};
const empty = { path: ".changeset/open-meals-thank.md", content: "---\n---\n" };

describe("changesetReleases", () => {
  it("reads the package names in the front matter", () => {
    expect(
      changesetReleases(
        "---\n\"@omniralph/agent\": minor\n'@omniralph/web': patch\nplain: major\n---\n\nSummary\n",
      ),
    ).toEqual(["@omniralph/agent", "@omniralph/web", "plain"]);
  });

  it("returns no packages for an empty changeset", () => {
    expect(changesetReleases("---\n---\n")).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    expect(changesetReleases('---\r\n"@omniralph/agent": patch\r\n---\r\n\r\nFix\r\n')).toEqual([
      "@omniralph/agent",
    ]);
  });

  it("returns undefined without front matter", () => {
    expect(changesetReleases("# Changesets\n\nHello\n")).toBeUndefined();
    expect(changesetReleases("Intro\n---\n---\n")).toBeUndefined();
  });

  it("ignores package names that only appear in the summary", () => {
    expect(changesetReleases('---\n---\n\n"@omniralph/agent": patch\n')).toEqual([]);
  });
});

describe("isChangesetPath", () => {
  it("matches .changeset/*.md except the README", () => {
    expect(isChangesetPath(".changeset/brave-dogs-run.md")).toBe(true);
    expect(isChangesetPath(".changeset/README.md")).toBe(false);
    expect(isChangesetPath(".changeset/config.json")).toBe(false);
    expect(isChangesetPath("docs/.changeset/x.md")).toBe(false);
    expect(isChangesetPath(".changeset/nested/x.md")).toBe(false);
  });
});

describe("touchedPackageDirs", () => {
  it("matches whole directory names only", () => {
    expect(
      touchedPackageDirs(
        ["packages/engine/src/a.ts", "packages/engine-extra/b.ts", "apps/agent"],
        PACKAGE_DIRS,
      ),
    ).toEqual(["packages/engine"]);
  });
});

describe("checkAgentChangeset", () => {
  it("passes when the agent and its workspace packages are untouched", () => {
    const result = checkAgentChangeset({
      changedFiles: ["apps/web/src/page.tsx", "packages/db/src/schema.ts", "README.md"],
      packageDirs: PACKAGE_DIRS,
      changesets: [],
    });
    expect(result.ok).toBe(true);
  });

  it("fails an agent change without a changeset", () => {
    const result = checkAgentChangeset({
      changedFiles: ["apps/agent/src/cli.ts"],
      packageDirs: PACKAGE_DIRS,
      changesets: [],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("apps/agent");
    expect(result.message).toContain("pick @omniralph/agent");
    expect(result.message).toContain("pnpm changeset --empty");
  });

  it("fails a change to a bundled workspace package without an agent changeset", () => {
    const result = checkAgentChangeset({
      changedFiles: ["packages/shared/src/index.ts", "packages/tasks/src/x.ts"],
      packageDirs: PACKAGE_DIRS,
      changesets: [],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("packages/tasks, packages/shared");
  });

  it("passes with a changeset that names the agent", () => {
    const result = checkAgentChangeset({
      changedFiles: ["packages/engine/src/run.ts", agentPatch.path],
      packageDirs: PACKAGE_DIRS,
      changesets: [agentPatch],
    });
    expect(result).toEqual({
      ok: true,
      message: ".changeset/brave-dogs-run.md adds a changeset for @omniralph/agent.",
    });
  });

  it("fails when the only changeset names the package's old name", () => {
    const result = checkAgentChangeset({
      changedFiles: ["apps/agent/src/cli.ts", legacyMinor.path],
      packageDirs: PACKAGE_DIRS,
      changesets: [legacyMinor],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("adds no changeset for @omniralph/agent");
  });

  it("accepts an empty changeset as a deliberate opt-out", () => {
    const result = checkAgentChangeset({
      changedFiles: ["apps/agent/src/cli.test.ts", empty.path],
      packageDirs: PACKAGE_DIRS,
      changesets: [empty],
    });
    expect(result.ok).toBe(true);
  });

  it("fails when the only changeset names another package", () => {
    const result = checkAgentChangeset({
      changedFiles: ["apps/agent/src/cli.ts"],
      packageDirs: PACKAGE_DIRS,
      changesets: [{ path: ".changeset/x.md", content: '---\n"other-pkg": patch\n---\n\nX\n' }],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("pick @omniralph/agent");
  });

  it("ignores files without front matter", () => {
    const result = checkAgentChangeset({
      changedFiles: ["apps/agent/src/cli.ts"],
      packageDirs: PACKAGE_DIRS,
      changesets: [{ path: ".changeset/notes.md", content: "Just notes\n" }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("agentPackageDirs", () => {
  const dirs = agentPackageDirs(REPO_ROOT);

  it("lists the agent and every workspace package it bundles, packages/ui among them", () => {
    expect(dirs).toEqual([
      "apps/agent",
      "packages/engine",
      "packages/ralph",
      "packages/shared",
      "packages/tasks",
      "packages/ui",
    ]);
  });

  it("fails a change only under packages/ui without an agent changeset", () => {
    const result = checkAgentChangeset({
      changedFiles: ["packages/ui/src/x.tsx"],
      packageDirs: dirs,
      changesets: [],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("changes packages/ui, which @omniralph/agent bundles");
    expect(result.message).toContain(
      "@omniralph/agent bundles apps/agent, packages/engine, packages/ralph, packages/shared, packages/tasks, packages/ui.",
    );
  });

  it.each([
    ["an @omniralph/agent changeset", agentPatch],
    ["an empty changeset", empty],
  ])("passes a change only under packages/ui with %s", (_name, changeset) => {
    const result = checkAgentChangeset({
      changedFiles: ["packages/ui/src/x.tsx", changeset.path],
      packageDirs: dirs,
      changesets: [changeset],
    });
    expect(result.ok).toBe(true);
  });
});

describe("main", () => {
  it("returns 2 with a usage message when the base ref is missing", () => {
    expect(main([])).toBe(2);
  });

  it("returns 0 when nothing changed since the base ref", () => {
    expect(main(["HEAD"])).toBe(0);
  });
});
