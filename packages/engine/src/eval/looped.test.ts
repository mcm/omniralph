import { fileURLToPath } from "node:url";
import type { Finding } from "@omniralph/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCases, type EvalCase } from "./case.js";
import { selectProfiles } from "./profiles.js";
import { RecordedProvider, type Recording } from "./recorded.js";
import { Baseline, buildReport, renderMarkdown, summarizeProfile } from "./report.js";
import { runEval, type CaseResult } from "./run.js";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures/eval-cases", import.meta.url));

const [quick, standard, deep] = selectProfiles("all");

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

const selectStar = finding({
  startLine: 4,
  endLine: 4,
  category: "performance",
  severity: "low",
  title: "SELECT *",
});

/** The reviewer reports the injection and a false positive; the verifier rejects the latter. */
const RECORDINGS: Record<string, Recording> = {
  "sql-bad": {
    findings: [finding({}), selectStar],
    usage: { inputTokens: 1000, outputTokens: 200 },
    verifier: { rejected: ["SELECT *"], usage: { inputTokens: 300, outputTokens: 50 } },
  },
  "sql-clean": { findings: [], usage: { inputTokens: 600, outputTokens: 100 } },
};

const passesOf = (result: CaseResult | undefined) =>
  Object.fromEntries(
    (result?.looped?.checks ?? []).map((check) => [check.checkType, check.passes.length]),
  );

let cases: EvalCase[];
beforeAll(async () => {
  cases = await loadCases(FIXTURES);
});

describe("looped evals", { timeout: 60_000 }, () => {
  it("runs one verified pass per check type at Quick and never reports rejected findings", async () => {
    const provider = new RecordedProvider(RECORDINGS);
    const run = await runEval({ cases, profiles: [quick!], provider, strategy: "looped" });

    expect(run.strategy).toBe("looped");
    const [bad, clean] = run.profiles[0]!.cases;
    // Every check type reviewed its files once, with its own check-type prompt.
    expect(passesOf(bad)).toEqual({ security: 1, stability: 1, performance: 1, compatibility: 1 });
    const badCalls = provider.calls.filter((call) => call.caseId === "sql-bad");
    expect(badCalls.map((call) => call.taskId)).toEqual([
      "security-1",
      "stability-1",
      "performance-1",
      "compatibility-1",
    ]);
    expect(badCalls[0]?.prompt).toContain("# Check type");
    expect(badCalls[0]?.prompt).toContain("This pass checks security only");

    // Each pass's findings went to a fresh verifier session, quoted as data.
    expect(provider.verifications.map((v) => v.findingIds)).toEqual([
      ["p1-1", "p1-2"],
      ["p1-1", "p1-2"],
      ["p1-1", "p1-2"],
      ["p1-1", "p1-2"],
    ]);
    const verification = provider.verifications[0]!;
    expect(verification.prompt).toContain("ran a security pass (pass 1)");
    expect(verification.prompt).toContain('"title":"SELECT *"');
    expect(verification.prompt).toContain("# The diff (quoted data)");
    expect(verification.systemPrompt).toContain("untrusted data");
    expect(verification.maxTokens).toBe(100_000);

    // The rejected finding is dropped and counted, never scored; the merge keeps one injection.
    expect(bad?.findings.map((f) => [f.title, f.verdict])).toEqual([
      ["SQL injection", "true_positive"],
    ]);
    expect(bad?.looped).toMatchObject({ dropped: 4, merged: 3 });
    expect(bad?.looped?.checks[0]?.passes[0]).toMatchObject({
      number: 1,
      files: ["src/db.ts", "src/users.ts"],
      reported: 2,
      confirmed: 1,
      new: 1,
      dropped: 1,
      verification: "verified",
    });
    // A pass with no findings needs no verifier.
    expect(clean?.looped?.dropped).toBe(0);
    expect(provider.verifications.every((v) => v.caseId === "sql-bad")).toBe(true);
    // Reviews and verifications both count toward the tokens.
    expect(bad?.usage).toEqual({ inputTokens: 4 * 1300, outputTokens: 4 * 250 });

    const summary = summarizeProfile(run.profiles[0]!, "looped");
    expect(summary).toMatchObject({
      strategy: "looped",
      precision: 1,
      recall: 1,
      falsePositives: 0,
      looped: {
        droppedFindings: 4,
        checks: {
          security: { cases: 2, passes: 2, maxPasses: 1, findings: 1, dropped: 1 },
          performance: { cases: 2, passes: 2, maxPasses: 1 },
        },
      },
    });
  });

  it("stops a check type once a pass adds no new confirmed findings, and at the depth's cap", async () => {
    const provider = new RecordedProvider(RECORDINGS);
    const run = await runEval({
      cases: cases.filter((c) => c.id === "sql-bad"),
      profiles: [standard!],
      provider,
      strategy: "looped",
    });
    const [bad] = run.profiles[0]!.cases;
    // Pass 2 confirms the same injection again: nothing new, so every check type stops there.
    expect(passesOf(bad)).toEqual({ security: 2, stability: 2, performance: 2, compatibility: 2 });
    expect(bad?.looped?.checks.map((check) => check.stop)).toEqual([
      "converged",
      "converged",
      "converged",
      "converged",
    ]);
    expect(bad?.looped?.checks[0]?.passes[1]).toMatchObject({ number: 2, confirmed: 1, new: 0 });
    // The second pass is told what the first one confirmed.
    const second = provider.calls.filter((call) => call.taskId === "security-1")[1];
    expect(second?.prompt).toContain("# Earlier passes (quoted data)");
    expect(second?.prompt).toContain('"title": "SQL injection"');
    expect(bad?.looped?.dropped).toBe(8);

    // A reviewer that finds something new every pass runs into the depth's cap of 2.
    let line = 0;
    const growing = new RecordedProvider({});
    const review = growing.review.bind(growing);
    growing.review = async (request) => ({
      ...(await review(request)),
      findings: [finding({ startLine: ++line, endLine: line, title: `Issue ${line}` })],
    });
    const capped = await runEval({
      cases: cases.filter((c) => c.id === "sql-bad"),
      profiles: [standard!],
      provider: growing,
      strategy: "looped",
    });
    const checks = capped.profiles[0]!.cases[0]?.looped?.checks ?? [];
    expect(checks.map((check) => [check.checkType, check.passes.length, check.stop])).toEqual([
      ["security", 2, "cap"],
      ["stability", 2, "cap"],
      ["performance", 2, "cap"],
      ["compatibility", 2, "cap"],
    ]);
  });

  it("runs security at least twice at Deep, even when its first pass finds nothing", async () => {
    const provider = new RecordedProvider(RECORDINGS);
    const run = await runEval({
      cases: cases.filter((c) => c.id === "sql-clean"),
      profiles: [deep!],
      provider,
      strategy: "looped",
    });
    expect(passesOf(run.profiles[0]!.cases[0])).toEqual({
      security: 2,
      stability: 1,
      performance: 1,
      compatibility: 1,
    });
    expect(provider.verifications).toEqual([]);
  });

  it("covers what the verifier said a pass didn't reach in the next pass", async () => {
    const provider = new RecordedProvider({
      "sql-bad": {
        ...RECORDINGS["sql-bad"]!,
        verifier: {
          unreached: [
            { path: "src/db.ts", startLine: null, endLine: null, reason: "Check the export." },
          ],
        },
      },
    });
    const run = await runEval({
      cases: cases.filter((c) => c.id === "sql-bad"),
      profiles: [standard!],
      provider,
      strategy: "looped",
    });
    const security = run.profiles[0]!.cases[0]?.looped?.checks[0];
    expect(security?.passes.map((pass) => [pass.number, pass.files, pass.unreached])).toEqual([
      [1, ["src/db.ts", "src/users.ts"], 1],
      [2, ["src/db.ts"], 0],
    ]);
    const second = provider.calls.filter((call) => call.taskId.startsWith("security-"))[1];
    expect(second?.prompt).toContain("Check the export.");
  });

  it("keeps a pass's findings unverified when its verifier fails", async () => {
    const provider = new RecordedProvider({
      "sql-bad": { ...RECORDINGS["sql-bad"]!, verifier: { stopReason: "error" } },
    });
    const run = await runEval({
      cases: cases.filter((c) => c.id === "sql-bad"),
      profiles: [quick!],
      provider,
      strategy: "looped",
    });
    const [bad] = run.profiles[0]!.cases;
    expect(bad?.looped?.dropped).toBe(0);
    expect(bad?.looped?.checks[0]?.passes[0]?.verification).toBe("unverified");
    expect(bad?.findings.map((f) => f.verdict)).toEqual(["true_positive", "unmatched"]);
  });

  it("caps the whole looped case at the run's tokens left", async () => {
    const provider = new RecordedProvider(RECORDINGS);
    const run = await runEval({
      cases,
      profiles: [quick!],
      provider,
      strategy: "looped",
      maxTotalTokens: 3_000,
    });
    // 1,200 (security) + 350 (its verifier) + 1,200 (stability) leave 250: the verifier can't run.
    expect(run.aborted?.reason).toBe("--max-total-tokens 3000 reached during quick/sql-bad");
    expect(run.profiles[0]!.cases[0]?.stopReason).toBe("aborted");
    expect(provider.verifications.map((v) => v.maxTokens)).toEqual([1_800, 250]);
  });

  it("refuses a looped run without a verifier", async () => {
    await expect(
      runEval({
        cases,
        profiles: [quick!],
        provider: { review: async () => ({}) as never },
        strategy: "looped",
      }),
    ).rejects.toThrow(/verifies findings/);
  });
});

describe("looped reports", { timeout: 60_000 }, () => {
  it("compares with the looped baseline only, and shows the single-pass baseline beside it", async () => {
    const single = await runEval({
      cases,
      profiles: [quick!],
      provider: new RecordedProvider(RECORDINGS),
    });
    const looped = await runEval({
      cases,
      profiles: [quick!],
      provider: new RecordedProvider(RECORDINGS),
      strategy: "looped",
    });
    const singleSummary = summarizeProfile(single.profiles[0]!);
    const baseline = Baseline.parse({
      version: 2,
      updatedAt: null,
      strategies: {
        single: { quick: singleSummary },
        looped: {
          quick: {
            ...summarizeProfile(looped.profiles[0]!, "looped"),
            looped: { droppedFindings: 6, checks: {} },
          },
        },
      },
    });
    const report = buildReport(looped, baseline, "quick");
    const [quickReport] = report.profiles;
    expect(report.strategy).toBe("looped");
    expect(quickReport?.comparison.baseline?.strategy).toBe("looped");
    expect(quickReport?.comparison.deltas.droppedFindings).toBe(-2);
    expect(quickReport?.comparison.deltas.precision).toBe(0);
    expect(quickReport?.comparison.singlePassBaseline).toEqual(singleSummary);

    const markdown = renderMarkdown(report);
    expect(markdown).toContain("# Review eval: quick (looped)");
    expect(markdown).toContain("Single-pass baseline: precision 50.0% · recall 100.0%");
    expect(markdown).toContain("| Findings dropped by verification | 4 | 6 | −2 |");
    expect(markdown).toContain(
      "| Check type | Cases | Passes | Passes / case | Most | Findings kept | Dropped by verification |",
    );
    expect(markdown).toContain("| security | 2 | 2 | 1.0 | 1 | 1 | 1 |");
    expect(markdown).toContain("| sql-bad | bad | completed | 1 | 0 | 0 | 5,200 | 1,000 |");
    expect(markdown).toContain("security 1, stability 1, performance 1, compatibility 1 | 4 |");
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);

    // Without a looped baseline, it says so (the single-pass entry is not used for deltas).
    const fresh = buildReport(
      looped,
      Baseline.parse({
        version: 2,
        updatedAt: null,
        strategies: { single: { quick: singleSummary } },
      }),
      "quick",
    );
    expect(fresh.profiles[0]?.comparison.baseline).toBeNull();
    expect(renderMarkdown(fresh)).toContain("_No looped baseline for this profile");
  });
});
