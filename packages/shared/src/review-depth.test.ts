import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_DEPTH,
  isReviewDepth,
  REVIEW_DEPTH_IDS,
  REVIEW_DEPTHS,
  reviewProfileConfigForDepth,
} from "./review-depth.js";
import { ReviewProfileConfig } from "./review-job.js";

describe("REVIEW_DEPTHS", () => {
  it("defines Quick, Standard and Deep with the built-in limits", () => {
    expect(REVIEW_DEPTH_IDS).toEqual(["quick", "standard", "deep"]);
    expect(DEFAULT_REVIEW_DEPTH).toBe("standard");
    expect(REVIEW_DEPTHS).toEqual({
      quick: {
        id: "quick",
        label: "Quick",
        summary: "Reads only the change and flags clear problems. Fastest and cheapest.",
        model: "claude-haiku-5-5",
        maxTokensPerReview: 60_000,
        maxFiles: 15,
        allowRepoExploration: false,
        details: {
          modelLabel: "Haiku 5.5",
          tokenCapLabel: "60k per review",
          reads: "The diff only",
          comments: "Inline findings plus a summary",
          typicalTime: "Shortest",
        },
      },
      standard: {
        id: "standard",
        label: "Standard",
        summary: "Reads the change and the files around it before commenting.",
        model: "claude-sonnet-5-5",
        maxTokensPerReview: 200_000,
        maxFiles: 40,
        allowRepoExploration: true,
        details: {
          modelLabel: "Sonnet 5.5",
          tokenCapLabel: "200k per review",
          reads: "The diff and related files",
          comments: "Inline findings plus a summary",
          typicalTime: "Baseline",
        },
      },
      deep: {
        id: "deep",
        label: "Deep",
        summary:
          "Reads the change and the code around it across the repo before commenting. Slowest, most thorough.",
        model: "claude-opus-5-5",
        maxTokensPerReview: 500_000,
        maxFiles: 100,
        allowRepoExploration: true,
        details: {
          modelLabel: "Opus 5.5",
          tokenCapLabel: "500k per review",
          reads: "The diff, related files and their tests across the repo",
          comments: "Inline findings plus a summary",
          typicalTime: "About 2× Standard",
        },
      },
    });
  });

  it("tells depths from other values", () => {
    expect(REVIEW_DEPTH_IDS.every(isReviewDepth)).toBe(true);
    expect(isReviewDepth("thorough")).toBe(false);
    expect(isReviewDepth(null)).toBe(false);
  });
});

describe("reviewProfileConfigForDepth", () => {
  it("gives the review lifecycle the preset as a profile", () => {
    const config = reviewProfileConfigForDepth("quick");
    expect(ReviewProfileConfig.parse(config)).toEqual({
      id: "quick",
      name: "Quick",
      model: "claude-haiku-5-5",
      maxTokensPerReview: 60_000,
      maxFiles: 15,
      allowRepoExploration: false,
    });
  });
});
