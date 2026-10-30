import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The web app is built on @omniralph/ui only: TOOL-740 removed @iamthemcmaster/ui (Precision
// Aurora), which today's screens used until the 2.0 epics replaced them. These keep it out.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const SELF = "apps/web/src/ui-library.test.ts";
const OLD_SCOPE = "@iamthemcmaster/";

/** Tracked files under apps/web matching the pattern (`git grep -l`), this test aside. */
function grep(args: string[]): string[] {
  try {
    return execFileSync("git", ["grep", "-l", ...args, "--", "apps/web", `:!${SELF}`], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => line !== "");
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

/** The workspace's package.json files: the root's and every apps/* and packages/* one. */
function workspaceManifests(): string[] {
  return execFileSync(
    "git",
    [
      "ls-files",
      ":(glob)package.json",
      ":(glob)apps/*/package.json",
      ":(glob)packages/*/package.json",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter((line) => line !== "");
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

describe("@iamthemcmaster/ui is gone", () => {
  it("is imported by no file under apps/web (source, config or CSS)", () => {
    expect(grep(["-F", OLD_SCOPE])).toEqual([]);
  });

  it("leaves the toasts to @omniralph/ui: nothing imports notify or SonnerToaster", () => {
    expect(grep(["-w", "SonnerToaster"])).toEqual([]);
    // `notify` imported by name from a package (`@/…` and relative paths are the app's own
    // modules, such as lib/ralph/notify).
    expect(
      grep(["-E", String.raw`import\s*\{[^}]*\bnotify\b[^}]*\}\s*from\s*["']([^.@]|@[^/])`]),
    ).toEqual([]);
  });

  it("is a dependency of no workspace package", () => {
    const manifests = workspaceManifests();
    // Sanity check: the web app, the agent and the UI package are among them.
    expect(manifests).toEqual(
      expect.arrayContaining([
        "package.json",
        "apps/web/package.json",
        "apps/agent/package.json",
        "packages/ui/package.json",
      ]),
    );
    const offenders = manifests.flatMap((manifest) => {
      const pkg = JSON.parse(readFileSync(path.join(root, manifest), "utf8")) as Record<
        string,
        Record<string, string> | undefined
      >;
      return DEPENDENCY_FIELDS.flatMap((field) =>
        Object.keys(pkg[field] ?? {})
          .filter((name) => name.startsWith(OLD_SCOPE))
          .map((name) => `${manifest} ${field}: ${name}`),
      );
    });
    expect(offenders).toEqual([]);
  });
});
