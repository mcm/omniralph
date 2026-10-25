import { describe, expect, it } from "vitest";
import { legacyJobRouting } from "./protocol.js";
import { TRIAGE_JOB_TYPES, TRIAGE_RUN_JOB_TYPE, TriageRunResult } from "./triage-job.js";

const outcome = {
  outcome: "prd",
  size: "L",
  title: "Triage capability: unattended PRD triage",
  description: "## Introduction\n\n…",
  openQuestions: ["Which label triggers triage?"],
};

const result = {
  summary: "Sized L; 3 stories; 1 open question.",
  outcome,
  usage: { inputTokens: 1000, outputTokens: 200 },
  durationMs: 30_000,
};

describe("triage jobs", () => {
  it("have one job type, a query task", () => {
    expect(TRIAGE_RUN_JOB_TYPE).toBe("triage.run");
    expect(TRIAGE_JOB_TYPES).toEqual(["triage.run"]);
    expect(legacyJobRouting(TRIAGE_RUN_JOB_TYPE)).toEqual({ taskType: "query" });
  });
});

describe("TriageRunResult", () => {
  it("parses an outcome", () => {
    const parsed = TriageRunResult.parse({
      ...result,
      outcome: {
        ...outcome,
        stories: [{ title: "Add the capability", body: "As an admin…", priority: 2 }],
        subIssueUpdates: [
          { id: "child-1", title: "Add the capability", body: "As an admin…", priority: 2 },
        ],
      },
    });
    expect(parsed.error).toBeNull();
    expect(parsed.outcome?.size).toBe("L");
    expect(parsed.outcome?.stories[0]).toMatchObject({ dependsOn: [], manual: false });
    expect(parsed.outcome?.subIssueUpdates[0]!.blockedBy).toEqual([]);
  });

  it("parses a failure", () => {
    const parsed = TriageRunResult.parse({ ...result, outcome: null, error: "session failed" });
    expect(parsed.outcome).toBeNull();
  });

  it("rejects invalid results", () => {
    const invalid = [
      { ...result, outcome: null },
      { ...result, error: "session failed" },
      { ...result, outcome: { ...outcome, size: "XXL" } },
      { ...result, outcome: { ...outcome, title: "  " } },
      { ...result, outcome: { ...outcome, openQuestions: [""] } },
      { ...result, usage: { inputTokens: -1, outputTokens: 0 } },
      { ...result, durationMs: 1.5 },
    ];
    for (const value of invalid) {
      expect(TriageRunResult.safeParse(value).success).toBe(false);
    }
  });
});
