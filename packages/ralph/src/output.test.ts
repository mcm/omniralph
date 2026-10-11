import { describe, expect, it } from "vitest";
import { fitPullRequestDescription, fitTitle, MAX_PULL_REQUEST_BODY_LENGTH } from "./output.js";

describe("fitTitle", () => {
  it("keeps a short title on one line", () => {
    expect(fitTitle("Short")).toBe("Short");
    expect(fitTitle("  Add\n the   runs ")).toBe("Add the runs");
  });

  it("cuts a long title at a word boundary within 72 characters", () => {
    const long =
      "Add the ralph capability with Linear delegations, branch worktrees and pull requests";
    expect(fitTitle(long)).toBe(
      "Add the ralph capability with Linear delegations, branch worktrees and…",
    );
    expect(fitTitle(long).length).toBeLessThanOrEqual(72);
  });

  it("cuts a title without spaces at the limit", () => {
    expect(fitTitle("x".repeat(100))).toHaveLength(72);
    expect(fitTitle("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("fitPullRequestDescription", () => {
  it("fits the title and cuts an over-long body", () => {
    const text = fitPullRequestDescription({
      title: "x".repeat(100),
      body: "y".repeat(MAX_PULL_REQUEST_BODY_LENGTH + 10),
    });
    expect(text.title).toHaveLength(72);
    expect(text.body).toHaveLength(MAX_PULL_REQUEST_BODY_LENGTH);
    expect(text.body.endsWith("…")).toBe(true);
    expect(fitPullRequestDescription({ title: "Add runs", body: "Adds runs." })).toEqual({
      title: "Add runs",
      body: "Adds runs.",
    });
  });
});
