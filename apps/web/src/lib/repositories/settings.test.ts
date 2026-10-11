import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { reviewTaskChoices } = await import("./settings");

describe("reviewTaskChoices", () => {
  it("offers every built-in review task, the summary-only PR summary too", () => {
    expect(reviewTaskChoices().map((task) => task.id)).toEqual([
      "builtin:review-pr",
      "builtin:summarize-pr",
    ]);
  });
});
