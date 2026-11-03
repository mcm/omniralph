import type { TriageRound, TriageRoundDraft } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import { draftText, triageRoundViews } from "./triage-rounds";

function draft(overrides: Partial<TriageRoundDraft> = {}): TriageRoundDraft {
  return {
    outcome: "prd",
    sizing: { size: "story", reason: "One session." },
    size: "M",
    title: "Export invoices",
    description: "## Goal\n\nExport them.",
    openQuestions: [],
    stories: [],
    ...overrides,
  };
}

const passed = { passed: true, problems: [] };
const roundOf = (d: TriageRoundDraft | null): { details: TriageRound } => ({
  details: {
    draft: d,
    lint: d ? passed : { passed: false, problems: ["Not a triage"] },
    critique: null,
  },
});

describe("triageRoundViews", () => {
  it("has no view for an iteration whose checks haven't recorded a round", () => {
    expect(triageRoundViews([{ details: null }, { details: { unexpected: true } }])).toEqual([
      null,
      null,
    ]);
  });

  it("diffs each draft against the last usable one before it, skipping unusable rounds", () => {
    const [first, unusable, third] = triageRoundViews([
      roundOf(draft()),
      roundOf(null),
      roundOf(draft({ title: "Export invoices as CSV" })),
    ]);
    expect(first).toMatchObject({ sizing: { size: "story" }, title: "Export invoices" });
    expect(first!.changes).toBeNull();
    expect(unusable).toMatchObject({ sizing: null, title: null, changes: null });
    expect(unusable!.lint.problems).toEqual(["Not a triage"]);
    expect(third!.changes).toMatchObject({ additions: 1, deletions: 1 });
    expect(third!.changes!.patch).toContain("-# Export invoices\n+# Export invoices as CSV");
  });

  it("shows a resize, new stories and new open questions as changes to the draft", () => {
    const before = draftText(draft());
    const after = draftText(
      draft({
        sizing: { size: "epic", reason: "Two stories." },
        size: "L",
        stories: [{ title: "API", body: "Add the endpoint." }],
        openQuestions: ["Which currency?"],
      }),
    );
    expect(after).toContain("Size: Epic (L). Two stories.");
    expect(after).toContain("## Story 1: API\n\nAdd the endpoint.");
    expect(after).toContain("## Open questions\n- Which currency?");
    expect(before).not.toContain("## Open questions");
  });
});
