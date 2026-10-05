import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parseDiff } from "../diff.js";
import { diff, showFile } from "../git.js";
import { hunkLineSets } from "../providers/findings-output.js";
import { isCleanCase, loadCases, type EvalCase } from "./case.js";
import { selectProfiles } from "./profiles.js";
import { RecordedProvider, type Recording } from "./recorded.js";
import { buildCaseRepo } from "./repo.js";
import { summarizeProfile } from "./report.js";
import { runEval } from "./run.js";

/** The committed seed corpus. */
const CASES_DIR = fileURLToPath(new URL("../../../../evals/cases", import.meta.url));

/** One known-bad case per pattern the corpus must cover (by tag). */
const REQUIRED_BAD_TAGS = [
  "sql-injection",
  "authorization",
  "floating-promise",
  "async-foreach",
  "leak",
  "swallowed-error",
  "n-plus-one",
  "removed-export",
  "migration",
  "secret",
  "prompt-injection",
];

let cases: EvalCase[];
beforeAll(async () => {
  cases = await loadCases(CASES_DIR);
});

describe("eval corpus", { timeout: 120_000 }, () => {
  it("has at least 20 cases: 12+ known-bad and 8+ clean, mostly TypeScript", () => {
    const bad = cases.filter((c) => !isCleanCase(c));
    const clean = cases.filter(isCleanCase);
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(bad.length).toBeGreaterThanOrEqual(12);
    expect(clean.length).toBeGreaterThanOrEqual(8);
    expect(cases.filter((c) => c.language === "typescript").length).toBeGreaterThan(
      cases.length / 2,
    );
    for (const c of cases) {
      expect(c.id, "case IDs start with bad- or clean-").toMatch(
        isCleanCase(c) ? /^clean-/ : /^bad-/,
      );
    }
  });

  it("covers every required bad pattern", () => {
    const badTags = new Set(cases.filter((c) => !isCleanCase(c)).flatMap((c) => c.tags));
    expect(REQUIRED_BAD_TAGS.filter((tag) => !badTags.has(tag))).toEqual([]);
    const injection = cases.find((c) => c.id === "bad-prompt-injection");
    expect(injection?.expected.some((e) => e.category === "security")).toBe(true);
  });

  it("builds every case and keeps expected findings inside the diff", async () => {
    const problems: string[] = [];
    for (const evalCase of cases) {
      const repo = await buildCaseRepo(evalCase);
      try {
        const files = parseDiff(await diff(repo.dir, `${repo.baseSha}...${repo.headSha}`));
        if (files.length === 0) problems.push(`${evalCase.id}: empty diff`);
        for (const item of evalCase.expected) {
          const where = `${evalCase.id}: expected ${item.path}:${item.startLine}-${item.endLine}`;
          const file = files.find((f) => f.path === item.path);
          if (!file) {
            problems.push(`${where} is not in the diff`);
            continue;
          }
          // A perfect finding must be postable: the whole range inside one hunk.
          const fits = hunkLineSets(file).some((lines) => {
            for (let n = item.startLine; n <= item.endLine; n++) if (!lines.has(n)) return false;
            return true;
          });
          if (!fits) problems.push(`${where} is not inside one hunk`);
        }
        for (const item of evalCase.mustNotFlag ?? []) {
          const text = await showFile(repo.dir, repo.headSha, item.path);
          const where = `${evalCase.id}: mustNotFlag ${item.path}`;
          if (text === undefined) problems.push(`${where} does not exist at head`);
          else if ((item.endLine ?? item.startLine ?? 1) > text.split("\n").length) {
            problems.push(`${where} is past the end of the file`);
          }
        }
      } finally {
        await repo.cleanup();
      }
    }
    expect(problems).toEqual([]);
  });

  it("scores perfectly when a recorded review reports exactly the expected findings", async () => {
    const recordings: Record<string, Recording> = Object.fromEntries(
      cases.map((c) => [
        c.id,
        {
          findings: c.expected.map((e) => ({
            path: e.path,
            startLine: e.startLine,
            endLine: e.endLine,
            severity: e.minSeverity,
            category: e.category,
            title: "Expected finding",
            body: "Recorded answer.",
            confidence: 1,
          })),
          usage: { inputTokens: 1000, outputTokens: 100 },
        },
      ]),
    );
    const run = await runEval({
      cases,
      profiles: selectProfiles("quick"),
      provider: new RecordedProvider(recordings),
    });
    expect(summarizeProfile(run.profiles[0]!)).toMatchObject({
      cases: cases.length,
      unscored: 0,
      precision: 1,
      recall: 1,
      falsePositives: 0,
      falseNegatives: 0,
      cleanFalsePositives: 0,
    });
  });
});
