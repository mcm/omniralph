import { describe, expect, it } from "vitest";
import type { RunStep } from "@/lib/api/runs";
import { findingFacts, lineRange, noFindingsText, openFindingsTotal } from "./findings";

type ReviewPassStep = Extract<RunStep, { kind: "review_pass" }>;

describe("lineRange", () => {
  it("reads one line or a range", () => {
    expect(lineRange({ startLine: 12, endLine: 12 })).toBe("L12");
    expect(lineRange({ startLine: 12, endLine: 14 })).toBe("L12–14");
  });
});

describe("findingFacts", () => {
  it("names the category and the rounded confidence", () => {
    expect(findingFacts({ category: "bug", confidence: 0.826 })).toBe("bug · 83% confidence");
  });
});

describe("openFindingsTotal", () => {
  it("sums the open findings of every severity", () => {
    const step = {
      openFindings: { critical: 1, high: 2, medium: 0, low: 3, info: 1 },
    } as ReviewPassStep;
    expect(openFindingsTotal(step)).toBe(7);
  });
});

describe("noFindingsText", () => {
  it("depends on whether the pass has finished", () => {
    expect(noFindingsText("queued")).toBe("Findings appear here when the pass finishes.");
    expect(noFindingsText("running")).toBe("Findings appear here when the pass finishes.");
    expect(noFindingsText("completed")).toBe("Om found nothing to report.");
    expect(noFindingsText("budget_exhausted")).toBe("Om found nothing to report.");
    expect(noFindingsText("failed")).toBe("This pass produced no findings.");
    expect(noFindingsText("skipped")).toBe("This pass produced no findings.");
  });
});
