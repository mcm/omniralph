import { describe, expect, it } from "vitest";
import { asksForBranchMerge, isBranchMergeFollowUp } from "./merge-follow-ups";

const branch = "omniralph/eng-50-widgets";

describe("asksForBranchMerge", () => {
  it.each([
    "Merge `omniralph/eng-40-auth` into `omniralph/eng-50-widgets`",
    "Please merge the auth branch into this branch so the session helper exists.",
    "Merge origin/main into the feature branch",
    "Someone needs to merge ENG-40's work into the Epic Branch first.",
    "Have a person merging feat/auth into OMNIRALPH/ENG-50-WIDGETS",
    "Merged release-1.2 into this branch",
  ])("catches %j", (text) => {
    expect(asksForBranchMerge(text, branch)).toBe(true);
  });

  it.each([
    "Merge duplicate config keys into one file",
    "Merge the two helpers into one module. Then run the tests on this branch.",
    "Merge the auth branch into main once it is reviewed",
    "Rebase this branch onto main",
    "Emerge the widget into the feature branch",
  ])("lets %j through", (text) => {
    expect(asksForBranchMerge(text, branch)).toBe(false);
  });

  it("only names the lane's branch when it has one", () => {
    expect(asksForBranchMerge("Merge feat/auth into feat/widgets", null)).toBe(false);
    expect(asksForBranchMerge("Merge feat/auth into feat/widgets", "feat/widgets")).toBe(true);
  });
});

describe("isBranchMergeFollowUp", () => {
  it("checks the title and the description", () => {
    expect(
      isBranchMergeFollowUp({ title: "Merge feat/auth into this branch", description: "" }, branch),
    ).toBe(true);
    expect(
      isBranchMergeFollowUp(
        { title: "Bring in the auth work", description: `Merge feat/auth into ${branch}.` },
        branch,
      ),
    ).toBe(true);
    expect(
      isBranchMergeFollowUp(
        { title: "Tidy the config", description: "Merge duplicate keys into one file." },
        branch,
      ),
    ).toBe(false);
  });
});
