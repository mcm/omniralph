// Release helpers for .github/workflows/publish-agent.yml.
//
// Usage (run after `pnpm install`):
//   tsx scripts/agent-release.ts status
//     Prints whether apps/agent/package.json's version should be published now, and writes
//     `version`, `tag` and `publish` (true|false) to $GITHUB_OUTPUT when it is set. It should
//     when no changeset that releases a package is pending (they belong in the Version Packages
//     pull request first) and that version isn't on npm yet. Fails when that version is below
//     AGENT_MIN_VERSION: @omniralph/agent's 0.x releases predate the 2.0.0 line.
//   tsx scripts/agent-release.ts notes <version> <out-file>
//     Writes that version's section of apps/agent/CHANGELOG.md to out-file (the GitHub
//     Release notes). Fails when the changelog has no section for the version.
import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_MIN_VERSION, harnessVersionAtLeast } from "../packages/shared/src/agent-version.js";
import { AGENT, changesetReleases } from "./check-agent-changeset.js";

export { AGENT };

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
const agentDir = path.join(repoRoot, "apps/agent");

function agentVersion(): string {
  const manifest = JSON.parse(readFileSync(path.join(agentDir, "package.json"), "utf8")) as {
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

export interface ReleaseStatus {
  version: string;
  tag: string;
  publish: boolean;
  message: string;
}

export interface ReleaseStatusInput {
  /** apps/agent/package.json's version. */
  version: string;
  /** The pending `.changeset/*.md` files. */
  changesets: { path: string; content: string }[];
  /** Runs `npm view <package>@<version> version --json`. */
  npmView: (spec: string) => NpmViewResult;
}

/**
 * Whether to publish `version` now: not while changesets that release a package are pending,
 * nor when it's already on npm. Throws for a version below AGENT_MIN_VERSION (only once the
 * changesets are consumed: until the Version Packages pull request bumps it, the version on
 * main is the never-published 1.0.0).
 */
export function releaseStatus({ version, changesets, npmView }: ReleaseStatusInput): ReleaseStatus {
  const tag = releaseTag(version);
  const pending = pendingReleaseChangesets(changesets);
  if (pending.length > 0) {
    return {
      version,
      tag,
      publish: false,
      message: `Changesets are pending (${pending.join(", ")}): the Version Packages pull request releases them.`,
    };
  }
  if (!harnessVersionAtLeast(version, AGENT_MIN_VERSION)) {
    throw new Error(
      `${AGENT}@${version} is below ${AGENT_MIN_VERSION}, the first version of ${AGENT} to publish.`,
    );
  }
  const publish = !isPublished(npmView(`${AGENT}@${version}`), version);
  return {
    version,
    tag,
    publish,
    message: publish
      ? `${AGENT}@${version} isn't on npm yet: releasing it as ${tag}.`
      : `${AGENT}@${version} is already on npm: nothing to release.`,
  };
}

function npmView(spec: string): NpmViewResult {
  const result = spawnSync("npm", ["view", spec, "version", "--json"], { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function status(): void {
  let result: ReleaseStatus;
  try {
    result = releaseStatus({
      version: agentVersion(),
      changesets: readPendingChangesets(),
      npmView,
    });
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.log(result.message);
  writeOutputs({ version: result.version, tag: result.tag, publish: result.publish });
}

function notes(version: string | undefined, outFile: string | undefined): void {
  if (!version || !outFile) {
    console.error("Usage: agent-release.ts notes <version> <out-file>");
    process.exit(2);
  }
  const changelog = readFileSync(path.join(agentDir, "CHANGELOG.md"), "utf8");
  const section = changelogSection(changelog, version);
  if (section === undefined) {
    console.error(`::error::apps/agent/CHANGELOG.md has no section for ${version}`);
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
      console.error("Usage: agent-release.ts status | notes <version> <out-file>");
      process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
