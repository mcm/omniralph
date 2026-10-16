import { describe, expect, it } from "vitest";
import {
  buildPullRequestCommentRequest,
  buildReviewRequest,
  MAX_FINDING_BODY,
  type ReviewFindingText,
} from "./reviews.js";

const finding = (n: number, overrides: Partial<ReviewFindingText> = {}): ReviewFindingText => ({
  path: `src/f${n}.ts`,
  startLine: n,
  severity: "high",
  title: `Finding ${n}`,
  body: `Body ${n}`,
  suggestion: null,
  ...overrides,
});

describe("buildReviewRequest", () => {
  it("lists each finding with path:line, severity, title, body and suggestion", () => {
    const text = buildReviewRequest({
      findings: [
        finding(3, {
          path: "src/a.ts",
          title: "Possible null dereference",
          body: "`load()` can return undefined. <!-- hidden -->",
          suggestion: "if (!x) return;",
        }),
      ],
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      branch: "eng-1-task-priority",
    });
    expect(text).toContain(
      "Omniralph reviewed pull request #7 (https://github.com/acme/app/pull/7) and left 1 open finding.",
    );
    expect(text).toContain("push `eng-1-task-priority`");
    expect(text).toContain("Don't comment on, reply to, resolve or dismiss");
    expect(text).toContain("1. `src/a.ts:3` (high): **Possible null dereference**");
    expect(text).toContain("`load()` can return undefined.");
    expect(text).not.toContain("hidden");
    expect(text).toContain("Suggested change:\n```\nif (!x) return;\n```");
  });

  it("lists finding IDs and asks the session to report each finding's outcome", () => {
    const text = buildReviewRequest({
      findings: [finding(3, { id: "11111111-1111-4111-8111-111111111111" }), finding(4)],
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      branch: "b",
    });
    expect(text).toContain(
      "1. `src/f3.ts:3` (high): **Finding 3** [finding `11111111-1111-4111-8111-111111111111`]",
    );
    expect(text).toContain("2. `src/f4.ts:4` (high): **Finding 4**\n");
    expect(text).toContain(
      "- Report every finding listed below in your structured result's `findings`, by its ID: `fixed` with a short comment on the change, or `skipped` with why. Omniralph replies in each finding's thread on the pull request with your comment and resolves the fixed ones.",
    );
  });

  it("caps bodies at 1,500 chars and lists at most 25 findings", () => {
    const findings = Array.from({ length: 27 }, (_, i) =>
      finding(i + 1, { body: "x".repeat(MAX_FINDING_BODY + 100) }),
    );
    const text = buildReviewRequest({
      findings,
      prNumber: 3,
      prUrl: "https://gitlab.com/acme/app/-/merge_requests/3",
      branch: "b",
      term: "merge request",
    });
    expect(text).toContain("merge request !3");
    expect(text).toContain(`${"x".repeat(MAX_FINDING_BODY)}…`);
    expect(text).not.toContain("x".repeat(MAX_FINDING_BODY + 1));
    expect(text).toContain("25. `src/f25.ts:25`");
    expect(text).not.toContain("26. ");
    expect(text).toContain("(2 more findings not shown; see the review on the merge request.)");
  });
});

describe("buildPullRequestCommentRequest", () => {
  it("passes on the person's text", () => {
    const text = buildPullRequestCommentRequest({
      author: "maintainer",
      text: "rename the flag to --dry-run",
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      branch: "eng-1",
    });
    expect(text).toContain(
      "@maintainer asked on pull request #7 (https://github.com/acme/app/pull/7):",
    );
    expect(text).toContain("rename the flag to --dry-run");
    expect(text).toContain("push `eng-1`");
    expect(text).not.toContain("The finding:");
  });

  it("includes the finding of the thread, and fixes it when nothing else is asked", () => {
    const text = buildPullRequestCommentRequest({
      author: "maintainer",
      text: null,
      finding: finding(4, { title: "Missing null check" }),
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      branch: "eng-1",
    });
    expect(text).toContain("in the thread of one of Omniralph's review findings:");
    expect(text).toContain("Fix this finding.");
    expect(text).toContain("The finding:\n`src/f4.ts:4` (high): **Missing null check**");
    expect(text).not.toContain("structured result's `findings`");
  });

  it("asks for the outcome of the thread's finding by its ID", () => {
    const text = buildPullRequestCommentRequest({
      author: "maintainer",
      text: null,
      finding: finding(4, { id: "11111111-1111-4111-8111-111111111111" }),
      prNumber: 3,
      prUrl: "https://gitlab.com/acme/app/-/merge_requests/3",
      branch: "eng-1",
      term: "merge request",
    });
    expect(text).toContain(
      "Report the finding in your structured result's `findings`, by its ID: `fixed` with a short comment on the change, or `skipped` with why. Omniralph replies in each finding's thread on the merge request with your comment and resolves the fixed ones.",
    );
    expect(text).toContain("[finding `11111111-1111-4111-8111-111111111111`]");
  });

  it("adds the rest of the finding's review as context", () => {
    const thread = finding(4, { id: "a", title: "Missing null check" });
    const text = buildPullRequestCommentRequest({
      author: "maintainer",
      text: "fix this one only",
      finding: thread,
      review: {
        summary: "Loader problems.",
        findings: [thread, finding(9, { id: "b", title: "Unbounded retry" })],
      },
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      branch: "eng-1",
    });
    expect(text).toContain("If @maintainer only asked a question, answer it in your summary");
    expect(text).toContain("Report each finding you worked on in your structured result's");
    expect(text).toContain(
      "The review it's from, for context (work only on what @maintainer asked for):\n\nSummary:\nLoader problems.\n\nIts other open findings (1):\n1. `src/f9.ts:9` (high): **Unbounded retry** [finding `b`]",
    );
    expect(text.match(/Missing null check/g)).toHaveLength(1);
  });

  it("says when the review has no other open findings, and ignores it outside a finding's thread", () => {
    const thread = finding(4, { id: "a" });
    const args = {
      author: "maintainer",
      text: null,
      review: { findings: [thread] },
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      branch: "eng-1",
    };
    const text = buildPullRequestCommentRequest({ ...args, finding: thread });
    expect(text).toContain("It has no other open findings.");
    expect(text).not.toContain("Summary:");
    expect(buildPullRequestCommentRequest(args)).not.toContain("The review it's from");
  });
});
