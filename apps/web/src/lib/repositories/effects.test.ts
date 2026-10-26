import type { ReviewDepth } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import {
  agentPinnedEffect,
  agentUnpinnedEffect,
  askEnabledEffect,
  codingEnabledEffect,
  codingInstructionsEffect,
  historyRewriteEffect,
  openPullRequestEarlyEffect,
  playbookBindingEffect,
  respondToReviewsAndCiEffect,
  reviewDepthEffect,
  reviewDraftsEffect,
  reviewerInstructionsEffect,
  reviewOnOpenEffect,
  reviewOnPushEffect,
  reviewsEnabledEffect,
  skipPathEffects,
  workItemMatchEffect,
} from "./effects";

describe("Reviews effects", () => {
  it.each([
    ["github", "pull requests"],
    ["gitlab", "merge requests"],
  ] as const)("Reviews off and on (%s)", (provider, requests) => {
    expect(reviewsEnabledEffect(provider, false)).toEqual({
      id: "reviewsEnabled",
      label: "Reviews",
      from: "On",
      to: "Off",
      effect: `New ${requests} won't be reviewed.`,
    });
    expect(reviewsEnabledEffect(provider, true)).toMatchObject({
      from: "Off",
      to: "On",
      effect: `New ${requests} will be reviewed.`,
    });
  });

  it.each([
    ["github", "PR", "pull request"],
    ["gitlab", "MR", "merge request"],
  ] as const)("PR opened / MR opened (%s)", (provider, abbreviation, request) => {
    expect(reviewOnOpenEffect(provider, false)).toEqual({
      id: "onOpen",
      label: `${abbreviation} opened`,
      from: "On",
      to: "Off",
      effect: `Opening a ${request} won't start a review.`,
    });
    expect(reviewOnOpenEffect(provider, true)).toMatchObject({
      label: `${abbreviation} opened`,
      effect: `Opening a ${request} starts a review.`,
    });
  });

  it.each([
    ["github", "pull request"],
    ["gitlab", "merge request"],
  ] as const)("New commits pushed (%s)", (provider, request) => {
    expect(reviewOnPushEffect(provider, false)).toMatchObject({
      label: "New commits pushed",
      effect: `Pushing to an open ${request} won't start a review.`,
    });
    expect(reviewOnPushEffect(provider, true)).toMatchObject({
      label: "New commits pushed",
      effect: `Pushing to an open ${request} starts a review.`,
    });
  });

  it.each([
    ["github", "pull requests"],
    ["gitlab", "merge requests"],
  ] as const)("Drafts too (%s)", (provider, requests) => {
    expect(reviewDraftsEffect(provider, true)).toMatchObject({
      label: "Drafts too",
      from: "Off",
      to: "On",
      effect: `Draft ${requests} are reviewed too.`,
    });
    expect(reviewDraftsEffect(provider, false)).toMatchObject({
      effect: `Draft ${requests} aren't reviewed.`,
    });
  });

  const DEEPER_2 = "New reviews will take about 2× longer and use more tokens.";
  const DEEPER_4 = "New reviews will take about 4× longer and use more tokens.";
  const SHALLOWER = "New reviews will be faster, use fewer tokens and read less of the repo.";

  it.each([
    ["quick", "standard", "Quick", "Standard", DEEPER_2],
    ["standard", "deep", "Standard", "Deep", DEEPER_2],
    ["quick", "deep", "Quick", "Deep", DEEPER_4],
    ["standard", "quick", "Standard", "Quick", SHALLOWER],
    ["deep", "standard", "Deep", "Standard", SHALLOWER],
    ["deep", "quick", "Deep", "Quick", SHALLOWER],
  ] as const)("Depth %s → %s", (from, to, fromLabel, toLabel, effect) => {
    expect(reviewDepthEffect(from as ReviewDepth, to as ReviewDepth)).toEqual({
      id: "depth",
      label: "Depth",
      from: fromLabel,
      to: toLabel,
      effect,
    });
  });

  it("skip paths: one item per glob added, then per glob removed", () => {
    expect(skipPathEffects(["dist/**", "*.lock"], ["*.lock", "vendor/**"])).toEqual([
      {
        id: "pathExcludes:+vendor/**",
        label: "Skip path added",
        to: "vendor/**",
        effect: "Reviews skip files matching vendor/**.",
      },
      {
        id: "pathExcludes:-dist/**",
        label: "Skip path removed",
        from: "dist/**",
        effect: "Reviews read files matching dist/** again.",
      },
    ]);
    expect(skipPathEffects(["a/**"], ["a/**"])).toEqual([]);
  });

  it("reviewer instructions edited", () => {
    expect(reviewerInstructionsEffect()).toEqual({
      id: "reviewerInstructions",
      label: "Reviewer instructions edited",
      effect: "Applies to new reviews.",
    });
  });
});

describe("Coding effects", () => {
  it("Coding on and off", () => {
    expect(codingEnabledEffect(true).effect).toBe("Om starts building work items that match.");
    expect(codingEnabledEffect(false).effect).toBe(
      "Om stops picking up new work items for this repo. Runs already started finish.",
    );
  });

  it("match added, changed and removed, each conflict adding a sentence", () => {
    expect(workItemMatchEffect(null, "Linear team SOC").effect).toBe(
      "Work items matching Linear team SOC route here.",
    );
    expect(workItemMatchEffect("Linear team SOC", "Linear team OPS", ["acme/web"]).effect).toBe(
      "Work items matching Linear team OPS route here instead of Linear team SOC. Om will ask between this repo and acme/web.",
    );
    expect(workItemMatchEffect("Linear team SOC", null).effect).toBe(
      "No work items route here by match.",
    );
  });

  it("extra instructions, draft PR early, review and CI fixes, rewrite history", () => {
    expect(codingInstructionsEffect().effect).toBe("Applies to new stories.");
    expect(openPullRequestEarlyEffect("gitlab", true)).toMatchObject({
      label: "Open a draft MR after the first story",
      effect: "Om opens a draft merge request after the first story.",
    });
    expect(openPullRequestEarlyEffect("github", false).effect).toBe(
      "Om opens the pull request when every story is done.",
    );
    expect(respondToReviewsAndCiEffect("github", true, 3).effect).toBe(
      "Om fixes review comments and CI failures on its pull requests, up to 3 rounds each.",
    );
    expect(respondToReviewsAndCiEffect("gitlab", false, 3).effect).toBe(
      "Om leaves review comments and CI failures to you.",
    );
    expect(historyRewriteEffect("when-asked", "never")).toEqual({
      id: "historyRewrite",
      label: "Rewrite history",
      from: "When asked",
      to: "Never",
      effect: "Om never force-pushes; it merges the base branch instead.",
    });
    expect(historyRewriteEffect("never", "always").effect).toBe(
      "Om rebases instead of merging the base branch, and force-pushes its branch.",
    );
    expect(historyRewriteEffect("always", "when-asked").effect).toBe(
      "Om rebases and force-pushes only when a request asks for it.",
    );
  });
});

describe("Ask, Agents and Playbooks effects", () => {
  it("words each change", () => {
    expect(askEnabledEffect(false).effect).toBe(
      "Om won't answer questions about this repo's code.",
    );
    expect(askEnabledEffect(true).effect).toBe("Om answers questions about this repo's code.");
    const agent = { id: "a1", name: "build-01" };
    expect(agentPinnedEffect(agent).effect).toBe("Work for this repo runs only on pinned agents.");
    expect(agentUnpinnedEffect(agent, false).effect).toBe(
      "build-01 no longer takes this repo's work.",
    );
    expect(agentUnpinnedEffect(agent, true).effect).toBe("Any agent can take this repo's work.");
    expect(
      playbookBindingEffect("story", "Stories playbook", "story", "Built-in", "Careful").effect,
    ).toBe("New story runs use Careful.");
  });
});
