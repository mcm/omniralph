import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// docs/env.md and .env.example must list the same variables, and every variable the
// control panel or the agent reads must be in them.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** Variables assigned in .env.example, commented out (`# NAME=`) or not. */
function envExampleVars(text: string): Set<string> {
  const names = text
    .split("\n")
    .map((line) => /^#?\s?([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
  return new Set(names);
}

/** Variables in the first column of docs/env.md's tables (`| \`NAME\` | …`). */
function envDocVars(text: string): Set<string> {
  const names = text
    .split("\n")
    .map((line) => /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
  return new Set(names);
}

/** Variables read via `process.env.X`, `env.X` or `env["X"]` in non-test source. */
function sourceEnvVars(dirs: string[]): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
      const file = path.join(dir, entry);
      if (statSync(file).isDirectory()) {
        walk(file);
      } else if (
        /\.tsx?$/.test(entry) &&
        !/\.test\.tsx?$/.test(entry) &&
        !file.includes(`${path.sep}test${path.sep}`)
      ) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(
          /\benv(?:\.([A-Z][A-Z0-9_]*)\b|\[\s*"([A-Z][A-Z0-9_]*)"\s*\])/g,
        )) {
          names.add((match[1] ?? match[2])!);
        }
      }
    }
  };
  for (const dir of dirs) walk(path.join(root, dir));
  return names;
}

/** Read by the code but set by the platform or by the agent itself, so not configured by operators. */
const NOT_CONFIGURED = new Set([
  "VERCEL_ENV",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL",
  "VERCEL_OIDC_TOKEN",
  "OMNIRALPH_JOB_ID",
  "OMNIRALPH_JOB_TOKEN",
  "HOME",
  "GIT_ASKPASS",
  "GIT_TERMINAL_PROMPT",
]);

const sorted = (set: Set<string>) => [...set].sort();

describe("docs/env.md", () => {
  const example = envExampleVars(read(".env.example"));
  const docs = envDocVars(read("docs/env.md"));

  it("parses a plausible number of variables from both files", () => {
    expect(example.size).toBeGreaterThan(20);
    expect(docs.size).toBeGreaterThan(20);
  });

  it("lists exactly the variables in .env.example", () => {
    expect(sorted(docs)).toEqual(sorted(example));
  });

  it("documents every variable the control panel and the agent read", () => {
    const used = sourceEnvVars(["apps/web/src", "apps/harness/src", "packages"]);
    const undocumented = sorted(used).filter(
      (name) => !docs.has(name) && !NOT_CONFIGURED.has(name),
    );
    expect(undocumented).toEqual([]);
  });

  it("mentions the platform- and agent-set variables it doesn't list", () => {
    const text = read("docs/env.md");
    for (const name of [
      "VERCEL_ENV",
      "VERCEL_PROJECT_PRODUCTION_URL",
      "OMNIRALPH_JOB_TOKEN",
      "OMNIRALPH_JOB_ID",
    ]) {
      expect(text).toContain(`\`${name}\``);
    }
  });
});
