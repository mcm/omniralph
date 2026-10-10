import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Finding } from "@omniralph/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCases, type EvalCase } from "./case.js";
import { parseEvalArgs, reportTimestamp } from "./cli.js";
import { EVAL_PROFILES, selectProfiles } from "./profiles.js";
import { RecordedProvider, type Recording } from "./recorded.js";
import {
  Baseline,
  buildReport,
  EMPTY_BASELINE,
  renderMarkdown,
  summarizeProfile,
  tokenStats,
  updatedBaseline,
  type ProfileSummary,
} from "./report.js";
import { runEval } from "./run.js";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures/eval-cases", import.meta.url));
const BASELINE = fileURLToPath(new URL("../../../../evals/baseline.json", import.meta.url));

const [quick, standard] = selectProfiles("all");
const clock = () => {
  let t = Date.parse("2026-10-05T12:00:00.000Z");
  return () => new Date((t += 1000));
};

function finding(overrides: Partial<Finding>): Finding {
  return {
    path: "src/users.ts",
    startLine: 9,
    endLine: 9,
    severity: "critical",
    category: "security",
    title: "SQL injection",
    body: "name is concatenated into the query.",
    confidence: 0.9,
    ...overrides,
  };
}

/** What a reviewer said about the fixture cases, as recorded from a real run. */
const RECORDINGS: Record<string, Recording> = {
  "sql-bad": {
    findings: [
      finding({}),
      finding({
        startLine: 4,
        endLine: 4,
        category: "performance",
        severity: "low",
        title: "SELECT *",
      }),
    ],
    usage: { inputTokens: 1000, outputTokens: 200 },
  },
  "sql-clean": { findings: [], usage: { inputTokens: 600, outputTokens: 100 } },
};

let cases: EvalCase[];
beforeAll(async () => {
  cases = await loadCases(FIXTURES);
});

describe("runEval", { timeout: 30_000 }, () => {
  it("reviews every case with the recorded provider and scores the findings", async () => {
    const provider = new RecordedProvider(RECORDINGS);
    const run = await runEval({ cases, profiles: [quick!], provider, now: clock() });

    expect(run.aborted).toBeNull();
    expect(run.totalTokens).toBe(1900);
    expect(provider.calls.map((c) => [c.caseId, c.budget])).toEqual([
      ["sql-bad", quick!.maxTokensPerReview],
      ["sql-clean", quick!.maxTokensPerReview],
    ]);
    // The reviewer sees the PR title, never the case description (it gives the answer away).
    expect(provider.calls[0]?.prompt).toContain("Find users by name");
    expect(provider.calls[0]?.prompt).not.toContain("Fixture:");

    const [bad, clean] = run.profiles[0]!.cases;
    expect(bad).toMatchObject({
      id: "sql-bad",
      clean: false,
      stopReason: "completed",
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 0,
      missed: [],
    });
    expect(bad?.findings.map((f) => [f.startLine, f.verdict])).toEqual([
      [9, "true_positive"],
      [4, "unmatched"],
    ]);
    expect(clean).toMatchObject({
      id: "sql-clean",
      clean: true,
      truePositives: 0,
      falsePositives: 0,
    });

    const summary = summarizeProfile(run.profiles[0]!);
    expect(summary).toMatchObject({
      profileId: "quick",
      model: quick!.model,
      cases: 2,
      unscored: 0,
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 0,
      precision: 0.5,
      recall: 1,
      cleanFalsePositives: 0,
      cleanCasesFlagged: 0,
      cleanCases: 1,
      inputTokens: { mean: 800, p50: 800, max: 1000 },
      outputTokens: { mean: 150, p50: 150, max: 200 },
      totalTokens: 1900,
    });
  });

  it("scores a flagged clean case and a missed bad case", async () => {
    const provider = new RecordedProvider({
      "sql-bad": { findings: [] },
      "sql-clean": { findings: [finding({ title: "Looks injectable" })] },
    });
    const run = await runEval({ cases, profiles: [quick!], provider });
    const summary = summarizeProfile(run.profiles[0]!);
    expect(summary).toMatchObject({
      truePositives: 0,
      falsePositives: 1,
      falseNegatives: 1,
      precision: 0,
      recall: 0,
      cleanFalsePositives: 1,
      cleanCasesFlagged: 1,
    });
    // The clean case's finding sits on its mustNotFlag line.
    expect(run.profiles[0]!.cases[1]?.findings[0]).toMatchObject({
      verdict: "must_not_flag",
      mustNotFlagNote: "Parameterized.",
    });
    expect(run.profiles[0]!.cases[0]?.missed).toEqual(cases[0]!.expected);
  });

  it("runs every selected profile and leaves errored cases out of the metrics", async () => {
    const provider = new RecordedProvider({
      ...RECORDINGS,
      "sql-clean": { findings: [], stopReason: "rate_limited" },
    });
    const run = await runEval({ cases, profiles: [quick!, standard!], provider });
    expect(run.profiles.map((p) => p.profile.id)).toEqual(["quick", "standard"]);
    expect(provider.calls).toHaveLength(4);
    const summary = summarizeProfile(run.profiles[1]!);
    expect(summary).toMatchObject({ cases: 1, caseIds: ["sql-bad"], unscored: 1 });
  });

  it("caps the last case at the tokens left and aborts when the cap cuts it short", async () => {
    const provider = new RecordedProvider(RECORDINGS);
    const run = await runEval({
      cases,
      profiles: [quick!, standard!],
      provider,
      maxTotalTokens: 1500,
    });
    // 1,200 tokens spent on the first case leave 300 for the second, which needs 700.
    expect(provider.calls.map((c) => [c.caseId, c.budget])).toEqual([
      ["sql-bad", 1500],
      ["sql-clean", 300],
    ]);
    expect(run.aborted?.reason).toBe("--max-total-tokens 1500 reached during quick/sql-clean");
    expect(run.totalTokens).toBe(1900);
    expect(run.profiles).toHaveLength(1);
    expect(run.profiles[0]!.cases[1]?.stopReason).toBe("aborted");
    expect(summarizeProfile(run.profiles[0]!)).toMatchObject({ cases: 1, unscored: 1 });
  });

  it("stops before a case when no tokens are left", async () => {
    const provider = new RecordedProvider(RECORDINGS);
    const run = await runEval({ cases, profiles: [quick!], provider, maxTotalTokens: 1200 });
    expect(provider.calls).toHaveLength(1);
    expect(run.aborted?.reason).toBe("--max-total-tokens 1200 reached before quick/sql-clean");
    expect(run.profiles[0]!.cases).toHaveLength(1);
  });
});

describe("reports", { timeout: 30_000 }, () => {
  it("reports deltas against the baseline and renders Markdown", async () => {
    const run = await runEval({
      cases,
      profiles: [quick!, standard!],
      provider: new RecordedProvider(RECORDINGS),
      now: clock(),
    });
    const previous: ProfileSummary = {
      ...summarizeProfile(run.profiles[0]!),
      precision: 0.75,
      inputTokens: { mean: 1000, p50: 900, max: 1500 },
      caseIds: ["sql-bad"],
    };
    const baseline: Baseline = {
      version: 1,
      updatedAt: "2026-10-01T00:00:00.000Z",
      profiles: { quick: previous, deep: { ...previous, profileId: "deep" } },
    };
    const report = buildReport(run, baseline, "all");

    const [quickReport, standardReport] = report.profiles;
    expect(quickReport?.comparison.deltas).toMatchObject({
      precision: -0.25,
      recall: 0,
      inputTokensMean: -200,
      inputTokensP50: -100,
      inputTokensMax: -500,
      falsePositives: 0,
    });
    expect(quickReport?.comparison.caseSetChanged).toBe(true);
    expect(standardReport?.comparison.baseline).toBeNull();
    expect(standardReport?.comparison.deltas.precision).toBeNull();

    const markdown = renderMarkdown(report);
    expect(markdown).toContain("# Review eval: all");
    expect(markdown).toContain("## quick (claude-haiku-5-5)");
    expect(markdown).toContain("| Precision | 50.0% | 75.0% | −25.0 pp |");
    expect(markdown).toContain("| Input tokens / case (mean) | 800 | 1,000 | −200 |");
    expect(markdown).toContain("| False positives on clean cases | 0 | 0 | ±0 |");
    expect(markdown).toContain("different set of cases");
    expect(markdown).toContain("_No baseline for this profile");
    expect(markdown).toContain("| sql-bad | bad | completed | 1 | 1 | 0 | 1,000 | 200 |");
    expect(markdown).toContain("- FP (unmatched): `src/users.ts:4-4` low/performance: SELECT *");
    expect(markdown).not.toContain("Aborted");

    // --update-baseline replaces the profiles that ran and keeps the others.
    const next = Baseline.parse(updatedBaseline(baseline, report));
    expect(Object.keys(next.profiles).sort()).toEqual(["deep", "quick", "standard"]);
    expect(next.profiles.quick?.precision).toBe(0.5);
    expect(next.profiles.deep).toEqual(baseline.profiles.deep);
    expect(next.updatedAt).toBe(report.finishedAt);

    // A JSON round trip (the report file) keeps the report intact.
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("marks aborted runs in the Markdown", async () => {
    const run = await runEval({
      cases,
      profiles: [quick!],
      provider: new RecordedProvider(RECORDINGS),
      maxTotalTokens: 1200,
    });
    const markdown = renderMarkdown(buildReport(run, EMPTY_BASELINE, "quick"));
    expect(markdown).toContain(
      "> **Aborted:** --max-total-tokens 1200 reached before quick/sql-clean",
    );
    expect(markdown).toContain("(cap 1,200)");
  });

  it("computes token stats", () => {
    expect(tokenStats([])).toEqual({ mean: 0, p50: 0, max: 0 });
    expect(tokenStats([5, 1, 3])).toEqual({ mean: 3, p50: 3, max: 5 });
    expect(tokenStats([4, 1, 3, 10])).toEqual({ mean: 5, p50: 3.5, max: 10 });
  });

  it("commits a valid baseline", () => {
    expect(() => Baseline.parse(JSON.parse(readFileSync(BASELINE, "utf8")))).not.toThrow();
  });
});

describe("eval CLI arguments", () => {
  it("defaults to every profile and case with no token cap", () => {
    expect(parseEvalArgs([])).toMatchObject({
      profile: "all",
      cases: [],
      maxTotalTokens: undefined,
      updateBaseline: false,
    });
    expect(selectProfiles("all").map((p) => p.id)).toEqual(EVAL_PROFILES.map((p) => p.id));
  });

  it("parses profiles, cases and the token cap", () => {
    expect(
      parseEvalArgs([
        "--profile",
        "quick",
        "--case",
        "a,b",
        "--case",
        "c",
        "--max-total-tokens",
        "2_000_000",
      ]),
    ).toMatchObject({ profile: "quick", cases: ["a", "b", "c"], maxTotalTokens: 2_000_000 });
    expect(() => selectProfiles("turbo")).toThrow(/Unknown profile "turbo"/);
  });

  it("rejects bad values", () => {
    expect(() => parseEvalArgs(["--max-total-tokens", "lots"])).toThrow(/positive integer/);
    expect(() => parseEvalArgs(["--max-total-tokens", "0"])).toThrow(/positive integer/);
    expect(() => parseEvalArgs(["--nope"])).toThrow();
    expect(() => parseEvalArgs(["--update-baseline", "--case", "a"])).toThrow(/full case set/);
  });

  it("names reports with a file-safe timestamp", () => {
    expect(reportTimestamp("2026-10-05T12:30:00.123Z")).toBe("2026-10-05T12-30-00Z");
  });
});
