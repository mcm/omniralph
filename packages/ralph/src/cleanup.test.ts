import { describe, expect, it } from "vitest";
import {
  branchExpiredMessage,
  branchQuestion,
  matchCleanupAnswer,
  closedCleanupMessage,
  mergedCleanupMessage,
  stashAnswerMessage,
  stashQuestion,
} from "./cleanup.js";

describe("matchCleanupAnswer", () => {
  const stashes = { kind: "stashes" as const, id: "s" };
  const branch = { kind: "branch" as const, id: "b" };

  it("matches an option's text, newest question first", () => {
    expect(matchCleanupAnswer("Push to a branch on origin", [stashes, branch])).toEqual({
      question: stashes,
      option: "Push to a branch on origin",
    });
    expect(matchCleanupAnswer("push to origin", [stashes, branch])).toEqual({
      question: branch,
      option: "Push to origin",
    });
    expect(matchCleanupAnswer("Delete", [stashes, branch])?.option).toBe("Delete");
  });

  it("takes 1/2 only when one question is open", () => {
    expect(matchCleanupAnswer("2", [stashes])).toEqual({ question: stashes, option: "Drop" });
    expect(matchCleanupAnswer("1", [branch])).toEqual({
      question: branch,
      option: "Push to origin",
    });
    expect(matchCleanupAnswer("1", [stashes, branch])).toBeUndefined();
  });

  it("takes a short reply with a unique first word, never guidance that uses one", () => {
    expect(matchCleanupAnswer("drop", [stashes, branch])).toEqual({
      question: stashes,
      option: "Drop",
    });
    expect(matchCleanupAnswer("delete it", [stashes, branch])?.option).toBe("Delete");
    // "Push" is ambiguous with both questions open.
    expect(matchCleanupAnswer("push", [stashes, branch])).toBeUndefined();
    expect(matchCleanupAnswer("push", [branch])?.option).toBe("Push to origin");
    expect(
      matchCleanupAnswer("Please push the stash to the branch and also update the docs", [stashes]),
    ).toBeUndefined();
    expect(matchCleanupAnswer("", [stashes])).toBeUndefined();
    expect(matchCleanupAnswer("drop", [])).toBeUndefined();
  });
});

describe("cleanup messages", () => {
  it("uses cyralph's wording", () => {
    expect(
      mergedCleanupMessage({
        term: "pull request",
        prUrl: "https://github.com/acme/app/pull/1",
        branch: "eng-1-x",
        keptBranch: false,
        stashed: "0123456789abcdef0123456789abcdef01234567",
      }),
    ).toBe(
      "The pull request https://github.com/acme/app/pull/1 was merged, so I removed its worktree and the local branch `eng-1-x`. Its uncommitted changes are stashed (`0123456789`).",
    );
    expect(
      mergedCleanupMessage({ term: "merge request", prUrl: "u", branch: "b", keptBranch: true }),
    ).toBe(
      "The merge request u was merged, so I removed its worktree, but kept the local branch `b`.",
    );
    expect(
      stashQuestion({
        epic: "ENG-1",
        repository: "acme/app",
        stashBranch: "ralph/stash/eng-1",
        entries: [{ sha: "0123456789abcdef", label: "x cleanup", date: "2026-10-06" }],
      }),
    ).toContain(
      "1 stashed change from ENG-1 was never applied:\n\n- `0123456789` x cleanup (2026-10-06)",
    );
    expect(branchQuestion({ branch: "b", commits: 1, minutes: 60 })).toBe(
      "`b` has 1 commit that wasn't merged.\n\n**Push to origin** pushes it to `origin` and then deletes it here; **Delete** deletes it. Without an answer within 60 minutes I'll delete it.",
    );
    expect(stashAnswerMessage({ option: "Drop", count: 2, epic: "ENG-1", stashBranch: "s" })).toBe(
      "Dropped 2 stashed changes from ENG-1.",
    );
    expect(branchExpiredMessage({ branch: "b", commits: 2, minutes: 1 })).toBe(
      "Nobody answered within 1 minute, so I deleted the local branch `b` with its 2 unmerged commits.",
    );
  });
});

describe("closedCleanupMessage", () => {
  it("says the branch stays", () => {
    expect(
      closedCleanupMessage({
        term: "merge request",
        prUrl: "u",
        branch: "b",
        stashed: "0123456789abcdef0123456789abcdef01234567",
      }),
    ).toBe(
      "The merge request u was closed without merging, so I removed its worktree. The branch `b` stays, here and on origin. Its uncommitted changes are stashed (`0123456789`).",
    );
  });
});
