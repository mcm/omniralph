// The agent package's name and version floor. No dependencies, so the release scripts in
// scripts/ can import it without building the workspace.

/** The npm package agents run and update themselves to. */
export const AGENT_PACKAGE = "@omniralph/agent";

/** A semantic version (semver 2.0, no leading `v`), e.g. `1.4.0` or `1.5.0-beta.1`. */
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * The lowest `@omniralph/agent` version there is: 2.0.0 starts the line (0.3.1–0.8.0 are older,
 * deprecated releases under the same name). Nothing is published, offered or installed below it.
 */
export const AGENT_MIN_VERSION = "2.0.0";

/**
 * Whether agent `version` is at least `minimum`, comparing major.minor.patch
 * only (a prerelease of `minimum` counts: it's built from the same code).
 * False for a version that isn't semver.
 */
export function harnessVersionAtLeast(version: string, minimum: string): boolean {
  const core = (v: string) => {
    const match = SEMVER_PATTERN.exec(v.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const have = core(version);
  const want = core(minimum);
  if (!have || !want) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== want[i]!) return have[i]! > want[i]!;
  }
  return true;
}
