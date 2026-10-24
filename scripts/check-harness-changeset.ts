// Fails a pull request that changes @omniralph/harness, or a workspace package it bundles,
// without adding a changeset that names @omniralph/harness or an empty changeset
// (`pnpm changeset --empty`, the deliberate "no release note" opt-out).
//
// The bundled packages are private devDependencies, so `changeset status` doesn't map their
// changes to the harness: this check does, from the workspace graph.
//
// Usage: tsx scripts/check-harness-changeset.ts <base-ref>   (e.g. origin/main; run after `pnpm install`)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS = "@omniralph/harness";

export interface Changeset {
  path: string;
  content: string;
}

export interface CheckInput {
  /** Repo-relative paths the pull request changes. */
  changedFiles: string[];
  /** Repo-relative directories of the harness and the workspace packages it depends on. */
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

export function checkHarnessChangeset({
  changedFiles,
  packageDirs,
  changesets,
}: CheckInput): CheckResult {
  const touched = touchedPackageDirs(changedFiles, packageDirs);
  if (touched.length === 0) {
    return { ok: true, message: `No changes to ${HARNESS} or its workspace packages.` };
  }

  for (const changeset of changesets) {
    const releases = changesetReleases(changeset.content);
    if (releases === undefined) continue;
    if (releases.length === 0) {
      return { ok: true, message: `${changeset.path} is an empty changeset: no release note.` };
    }
    if (releases.includes(HARNESS)) {
      return { ok: true, message: `${changeset.path} adds a changeset for ${HARNESS}.` };
    }
  }

  return {
    ok: false,
    message: [
      `This pull request changes ${touched.join(", ")}, which ${HARNESS} bundles,`,
      `but adds no changeset for ${HARNESS}.`,
      `Run \`pnpm changeset\` and pick ${HARNESS} (also for changes made only in a bundled`,
      "workspace package), or `pnpm changeset --empty` if the change needs no release note.",
      "See apps/harness/README.md › Releasing.",
    ].join("\n"),
  };
}

function git(repoRoot: string, args: string[]): string[] {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");
}

function harnessPackageDirs(repoRoot: string): string[] {
  const output = execFileSync(
    "pnpm",
    ["--filter", `${HARNESS}...`, "ls", "--depth", "-1", "--json"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const packages = JSON.parse(output) as { name: string; path: string }[];
  return packages.map((pkg) => path.relative(repoRoot, pkg.path).split(path.sep).join("/"));
}

function main(): void {
  const base = process.argv[2];
  if (!base) {
    console.error("Usage: check-harness-changeset.ts <base-ref>");
    process.exit(2);
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  // `base...HEAD` diffs against the merge base: only what the pull request itself changes.
  const changedFiles = git(repoRoot, ["diff", "--name-only", "--no-renames", `${base}...HEAD`]);
  const changesets = changedFiles
    .filter(isChangesetPath)
    .filter((file) => existsSync(path.join(repoRoot, file)))
    .map((file) => ({ path: file, content: readFileSync(path.join(repoRoot, file), "utf8") }));

  const packageDirs = harnessPackageDirs(repoRoot);
  const result = checkHarnessChangeset({ changedFiles, packageDirs, changesets });
  if (result.ok) {
    console.log(`check-harness-changeset: ${result.message}`);
  } else {
    console.error(`::error title=Missing changeset::${result.message.replaceAll("\n", "%0A")}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
