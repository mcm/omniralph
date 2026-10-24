// Release helpers for .github/workflows/publish-agent.yml.
//
// Usage (run after `pnpm install`):
//   tsx scripts/harness-release.ts status
//     Prints whether apps/harness/package.json's version should be published now, and writes
//     `version`, `tag` and `publish` (true|false) to $GITHUB_OUTPUT when it is set. It should
//     when no changeset that releases a package is pending (they belong in the Version Packages
//     pull request first) and that version isn't on npm yet.
//   tsx scripts/harness-release.ts notes <version> <out-file>
//     Writes that version's section of apps/harness/CHANGELOG.md to out-file (the GitHub
//     Release notes). Fails when the changelog has no section for the version.
import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changesetReleases } from "./check-harness-changeset.js";

export const HARNESS = "@omniralph/harness";

export function releaseTag(version: string): string {
  return `agent-v${version}`;
}

/**
 * One version's section of a changesets CHANGELOG.md, without its `## <version>` heading:
 * everything up to the next `## ` heading. Undefined when there is no such section.
 */
export function changelogSection(changelog: string, version: string): string | undefined {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

export interface NpmViewResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Whether `npm view <package>@<version> version` says the version is on the registry. npm
 * prints nothing for an unknown version of a known package and fails with E404 for an unknown
 * package; any other failure (network, registry) is thrown rather than read as "unpublished".
 */
export function isPublished(result: NpmViewResult, version: string): boolean {
  if (result.status !== 0) {
    if (/\bE404\b/.test(result.stderr)) return false;
    throw new Error(`npm view failed (exit ${result.status}):\n${result.stderr.trim()}`);
  }
  const output = result.stdout.trim();
  if (output === "") return false;
  // --json prints a string for one match and an array for several.
  const versions: unknown = JSON.parse(output);
  return Array.isArray(versions) ? versions.includes(version) : versions === version;
}

/**
 * The pending changesets that release a package. Empty changesets don't count: changesets/action
 * opens no Version Packages pull request for them, so they must not hold a release back.
 */
export function pendingReleaseChangesets(
  changesets: { path: string; content: string }[],
): string[] {
  return changesets
    .filter((changeset) => (changesetReleases(changeset.content) ?? []).length > 0)
    .map((changeset) => changeset.path);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const harnessDir = path.join(repoRoot, "apps/harness");

function harnessVersion(): string {
  const manifest = JSON.parse(readFileSync(path.join(harnessDir, "package.json"), "utf8")) as {
    version: string;
  };
  return manifest.version;
}

function readPendingChangesets(): { path: string; content: string }[] {
  const dir = path.join(repoRoot, ".changeset");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .map((name) => ({
      path: `.changeset/${name}`,
      content: readFileSync(path.join(dir, name), "utf8"),
    }));
}

function writeOutputs(outputs: Record<string, string | boolean>): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`);
  appendFileSync(outputFile, lines.join(""));
}

function status(): void {
  const version = harnessVersion();
  const tag = releaseTag(version);
  const pending = pendingReleaseChangesets(readPendingChangesets());
  if (pending.length > 0) {
    console.log(
      `Changesets are pending (${pending.join(", ")}): the Version Packages pull request releases them.`,
    );
    writeOutputs({ version, tag, publish: false });
    return;
  }
  const result = spawnSync("npm", ["view", `${HARNESS}@${version}`, "version", "--json"], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  const publish = !isPublished(result, version);
  console.log(
    publish
      ? `${HARNESS}@${version} isn't on npm yet: releasing it as ${tag}.`
      : `${HARNESS}@${version} is already on npm: nothing to release.`,
  );
  writeOutputs({ version, tag, publish });
}

function notes(version: string | undefined, outFile: string | undefined): void {
  if (!version || !outFile) {
    console.error("Usage: harness-release.ts notes <version> <out-file>");
    process.exit(2);
  }
  const changelog = readFileSync(path.join(harnessDir, "CHANGELOG.md"), "utf8");
  const section = changelogSection(changelog, version);
  if (section === undefined) {
    console.error(`::error::apps/harness/CHANGELOG.md has no section for ${version}`);
    process.exit(1);
  }
  writeFileSync(outFile, `${section}\n`);
  console.log(`Wrote the ${version} release notes to ${outFile}`);
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "status":
      return status();
    case "notes":
      return notes(args[0], args[1]);
    default:
      console.error("Usage: harness-release.ts status | notes <version> <out-file>");
      process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
