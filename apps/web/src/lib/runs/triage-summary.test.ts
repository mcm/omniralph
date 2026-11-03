import type { TriageRunWithJobs } from "@omniralph/db";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { triageSummary } = await import("./triage-summary");

/** A completed triage run whose last result sized the work `size` and left `openQuestions`. */
function completedRun(
  size: "fix" | "story" | "epic" | "feature" | null,
  openQuestions: string[] = [],
): TriageRunWithJobs {
  const lastResult = {
    summary: "Triaged the work item.",
    error: null,
    outcome: {
      outcome: size === "feature" ? "unchanged" : "prd",
      size: size === "feature" || size === "epic" ? "XL" : "S",
      sizing: size && { size, reason: "Because." },
      title: "Billing export",
      description: "## Introduction\n\nExport invoices.",
      openQuestions,
      stories: [],
      subIssueUpdates: [],
    },
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 1,
  };
  return {
    run: { status: "completed", lastResult },
    jobs: [],
  } as unknown as TriageRunWithJobs;
}

describe("triageSummary", () => {
  it("shows a Feature-sized triage as needing planning, not Ready to start", () => {
    expect(triageSummary(completedRun("feature"), "member").outcome).toBe("needs_planning");
  });

  it("is ready to start for every other size, and for a triage from before sizing", () => {
    for (const size of ["fix", "story", "epic", null] as const) {
      expect(triageSummary(completedRun(size), "member").outcome, String(size)).toBe("ready");
    }
  });

  it("lets a person answer a Feature-sized triage's open questions first", () => {
    const summary = triageSummary(completedRun("feature", ["Which currency?"]), "member");
    expect(summary.outcome).toBe("needs_answers");
    expect(summary.answerQuestions).toBe(true);
  });
});
