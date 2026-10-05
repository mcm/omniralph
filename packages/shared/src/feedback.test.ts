import { describe, expect, it } from "vitest";
import { DismissFindingInput, MAX_FEEDBACK_NOTE_LENGTH } from "./feedback.js";

describe("DismissFindingInput", () => {
  it("accepts every reason, with or without a note", () => {
    for (const reason of ["false_positive", "wont_fix", "not_relevant", "other"] as const) {
      expect(DismissFindingInput.parse({ reason })).toEqual({ reason });
    }
    expect(DismissFindingInput.parse({ reason: "other", note: "  vendored  " })).toEqual({
      reason: "other",
      note: "vendored",
    });
  });

  it("rejects unknown reasons and overlong notes", () => {
    expect(DismissFindingInput.safeParse({ reason: "meh" }).success).toBe(false);
    expect(
      DismissFindingInput.safeParse({
        reason: "other",
        note: "x".repeat(MAX_FEEDBACK_NOTE_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});
