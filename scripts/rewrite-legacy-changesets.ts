// Renames the package's old name, @omniralph/harness, to @omniralph/agent in the front matter of
// every pending changeset. `pnpm changeset version` rejects a changeset for a package that isn't
// in the workspace, and other 2.0 epics still write @omniralph/harness changesets until the
// cutover, so .github/workflows/publish-agent.yml runs this right before it. Epic 14 removes it
// along with the legacy name.
//
// Only the front matter changes: the release note is left as written. When a changeset names
// both packages, the one @omniralph/agent key keeps the larger bump. Running it again changes
// nothing.
//
// Usage: tsx scripts/rewrite-legacy-changesets.ts   (prints each file it changes)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT, isChangesetPath, LEGACY_AGENT } from "./check-agent-changeset.js";

const BUMPS = ["none", "patch", "minor", "major"];

function largerBump(a: string, b: string): string {
  return BUMPS.indexOf(b) > BUMPS.indexOf(a) ? b : a;
}

/**
 * The changeset with its @omniralph/harness key renamed to @omniralph/agent (merged with an
 * existing @omniralph/agent key, keeping the larger bump), or undefined when it names no
 * @omniralph/harness release or has no front matter.
 */
export function rewriteLegacyChangeset(content: string): string | undefined {
  const match = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*$/m.exec(content);
  if (!match || match.index !== 0) return undefined;
  const frontMatter = match[1]!;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = frontMatter.split(/\r?\n/);
  // The split leaves an empty last element for the front matter's final line break.
  if (lines.at(-1) === "") lines.pop();

  let legacy = false;
  let bump: string | undefined;
  let agentLine: number | undefined;
  const kept: (string | undefined)[] = [];
  for (const line of lines) {
    const release = /^\s*(["']?)(.+?)\1\s*:\s*(\S+)\s*$/.exec(line);
    if (!release || (release[2] !== AGENT && release[2] !== LEGACY_AGENT)) {
      kept.push(line);
      continue;
    }
    if (release[2] === LEGACY_AGENT) legacy = true;
    bump = bump === undefined ? release[3]! : largerBump(bump, release[3]!);
    agentLine ??= kept.length;
    kept.push(undefined);
  }
  if (!legacy || agentLine === undefined) return undefined;

  kept[agentLine] = `"${AGENT}": ${bump}`;
  const rewritten = kept.filter((line) => line !== undefined).join(eol);
  // The front matter starts on the line after the opening `---`.
  const start = content.indexOf("\n") + 1;
  return `${content.slice(0, start)}${rewritten}${eol}${content.slice(start + frontMatter.length)}`;
}

/**
 * Rewrites the pending changesets in `changesetDir` and returns the repo-relative paths it
 * changed, in name order.
 */
export function rewriteLegacyChangesets(changesetDir: string): string[] {
  const changed: string[] = [];
  for (const name of readdirSync(changesetDir).sort()) {
    const file = `.changeset/${name}`;
    if (!isChangesetPath(file)) continue;
    const fullPath = path.join(changesetDir, name);
    const rewritten = rewriteLegacyChangeset(readFileSync(fullPath, "utf8"));
    if (rewritten === undefined) continue;
    writeFileSync(fullPath, rewritten);
    changed.push(file);
  }
  return changed;
}

function main(): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const changed = rewriteLegacyChangesets(path.join(repoRoot, ".changeset"));
  for (const file of changed) {
    console.log(`rewrite-legacy-changesets: ${file} now releases ${AGENT}`);
  }
  if (changed.length === 0) {
    console.log(`rewrite-legacy-changesets: no ${LEGACY_AGENT} changesets`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
