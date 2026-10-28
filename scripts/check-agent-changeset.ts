// Fails a pull request that changes @omniralph/agent, or a workspace package it bundles,
// without adding a changeset that names @omniralph/agent or an empty changeset
// (`pnpm changeset --empty`, the deliberate "no release note" opt-out).
//
// The bundled directories are apps/agent, packages/engine, packages/ralph, packages/shared,
// packages/tasks and packages/ui: tsup bundles the first five into dist/cli.js and Vite bundles
// packages/ui into the agent page (dist/ui). They are derived from the workspace graph
// (`agentPackageDirs`), devDependencies included, so a new one counts as soon as it's added.
//
// Until the 2.0 cutover (Epic 14), a changeset naming the package's old name,
// @omniralph/harness, passes too: other 2.0 epics still write those, and
// scripts/rewrite-legacy-changesets.ts renames them before `pnpm changeset version`.
//
// The bundled packages are private devDependencies, so `changeset status` doesn't map their
// changes to the agent: this check does.
//
// Usage: tsx scripts/check-agent-changeset.ts <base-ref>   (e.g. origin/main; run after `pnpm install`)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_PACKAGE } from "../packages/shared/src/agent-version.js";

export const AGENT = AGENT_PACKAGE;
/** The package's name before 2.0. Epic 14 stops accepting it. */
export const LEGACY_AGENT = "@omniralph/harness";

export interface Changeset {
  path: string;
  content: string;
}

export interface CheckInput {
  /** Repo-relative paths the pull request changes. */
  changedFiles: string[];
  /** Repo-relative directories of the agent and the workspace packages it depends on. */
  packageDirs: string[];
  /** The `.changeset/*.md` files the pull request adds or edits. */
  changesets: Changeset[];
}

export interface CheckResult {
  ok: boolean;
  message: string;
}

/**
 * The package names a changeset's front matter releases (an empty changeset releases none),
 * or undefined when the file has no front matter.
 */
export function changesetReleases(content: string): string[] | undefined {
  const match = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*$/m.exec(content);
  if (!match || match.index !== 0) return undefined;
  const names: string[] = [];
  for (const line of match[1]!.split(/\r?\n/)) {
    const release = /^\s*(["']?)(.+?)\1\s*:\s*\S+\s*$/.exec(line);
    if (release) names.push(release[2]!);
  }
  return names;
}

/** Whether a repo-relative path is a changeset (not the README changesets writes). */
export function isChangesetPath(file: string): boolean {
  return /^\.changeset\/[^/]+\.md$/.test(file) && file !== ".changeset/README.md";
}

/** The package directories the changed files fall under, in `packageDirs` order. */
export function touchedPackageDirs(changedFiles: string[], packageDirs: string[]): string[] {
  return packageDirs.filter((dir) => {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    return changedFiles.some((file) => file.startsWith(prefix));
  });
}

export function checkAgentChangeset({
  changedFiles,
  packageDirs,
  changesets,
}: CheckInput): CheckResult {
  const touched = touchedPackageDirs(changedFiles, packageDirs);
  if (touched.length === 0) {
    return { ok: true, message: `No changes to ${AGENT} or its workspace packages.` };
  }

  for (const changeset of changesets) {
    const releases = changesetReleases(changeset.content);
    if (releases === undefined) continue;
    if (releases.length === 0) {
      return { ok: true, message: `${changeset.path} is an empty changeset: no release note.` };
    }
    const named = [AGENT, LEGACY_AGENT].find((name) => releases.includes(name));
    if (named) {
      return { ok: true, message: `${changeset.path} adds a changeset for ${named}.` };
    }
  }

  return {
    ok: false,
    message: [
      `This pull request changes ${touched.join(", ")}, which ${AGENT} bundles,`,
      `but adds no changeset for ${AGENT}.`,
      `${AGENT} bundles ${packageDirs.join(", ")}.`,
      `Run \`pnpm changeset\` and pick ${AGENT} (also for changes made only in a bundled`,
      "workspace package), or `pnpm changeset --empty` if the change needs no release note.",
      "See apps/agent/README.md › Releasing.",
    ].join("\n"),
  };
}

function git(repoRoot: string, args: string[]): string[] {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");
}

/**
 * The repo-relative directories of the agent and every workspace package it bundles, from
 * `pnpm --filter @omniralph/agent... ls`: all dependency types, so the devDependencies tsup
 * and Vite bundle count (never `--filter-prod`, which would leave them out).
 */
export function agentPackageDirs(repoRoot: string): string[] {
  const output = execFileSync(
    "pnpm",
    ["--filter", `${AGENT}...`, "ls", "--depth", "-1", "--json"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const packages = JSON.parse(output) as { name: string; path: string }[];
  return packages.map((pkg) => path.relative(repoRoot, pkg.path).split(path.sep).join("/")).sort();
}

/** Runs the check against `<base-ref>` (args[0]) and returns the exit code. */
export function main(args: string[]): number {
  const base = args[0];
  if (!base) {
    console.error("Usage: check-agent-changeset.ts <base-ref>");
    return 2;
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  // `base...HEAD` diffs against the merge base: only what the pull request itself changes.
  const changedFiles = git(repoRoot, ["diff", "--name-only", "--no-renames", `${base}...HEAD`]);
  const changesets = changedFiles
    .filter(isChangesetPath)
    .filter((file) => existsSync(path.join(repoRoot, file)))
    .map((file) => ({ path: file, content: readFileSync(path.join(repoRoot, file), "utf8") }));

  const packageDirs = agentPackageDirs(repoRoot);
  const result = checkAgentChangeset({ changedFiles, packageDirs, changesets });
  if (result.ok) {
    console.log(`check-agent-changeset: ${result.message}`);
    return 0;
  }
  console.error(`::error title=Missing changeset::${result.message.replaceAll("\n", "%0A")}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
