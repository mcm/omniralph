import { describe, expect, it } from "vitest";
import {
  parseGitHubCiEvent,
  parseGitHubCommentEvent,
  parseGitHubInstallationDeleted,
  parseGitHubMergeEvent,
  parseGitLabCiEvent,
  parseGitLabCommentEvent,
  parseGitLabMergeEvent,
} from "./events";

const user = { login: "octocat", type: "User" };

describe("parseGitHubCommentEvent", () => {
  it("parses a PR conversation comment (issue_comment)", () => {
    const body = {
      action: "created",
      issue: { number: 7, pull_request: { url: "https://api.github.com/…" } },
      comment: { id: 11, body: "@omniralph review", user },
    };
    expect(parseGitHubCommentEvent("issue_comment", body)).toEqual({
      number: 7,
      commentId: "11",
      body: "@omniralph review",
      author: { username: "octocat", isBot: false },
      threadIds: [],
      replyTo: { kind: "conversation" },
    });
  });

  it("ignores issue comments on issues, and edits", () => {
    const comment = { id: 11, body: "@omniralph review", user };
    expect(
      parseGitHubCommentEvent("issue_comment", {
        action: "created",
        issue: { number: 7 },
        comment,
      }),
    ).toBeNull();
    expect(
      parseGitHubCommentEvent("issue_comment", {
        action: "edited",
        issue: { number: 7, pull_request: {} },
        comment,
      }),
    ).toBeNull();
  });

  it("parses a reply in an inline thread, keyed by the thread's first comment", () => {
    const body = {
      action: "created",
      pull_request: { number: 7 },
      comment: { id: 22, in_reply_to_id: 20, body: "@omniralph dismiss", user },
    };
    expect(parseGitHubCommentEvent("pull_request_review_comment", body)).toMatchObject({
      number: 7,
      commentId: "22",
      threadIds: ["20"],
      replyTo: { kind: "thread", commentId: "20" },
    });
    const root = { ...body, comment: { ...body.comment, in_reply_to_id: null } };
    expect(parseGitHubCommentEvent("pull_request_review_comment", root)).toMatchObject({
      threadIds: ["22"],
      replyTo: { kind: "thread", commentId: "22" },
    });
  });

  it("flags bot authors and ignores other events", () => {
    const body = {
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { id: 11, body: "x", user: { login: "omniralph[bot]", type: "Bot" } },
    };
    expect(parseGitHubCommentEvent("issue_comment", body)?.author).toEqual({
      username: "omniralph[bot]",
      isBot: true,
    });
    expect(parseGitHubCommentEvent("pull_request", body)).toBeNull();
    expect(parseGitHubCommentEvent("issue_comment", { action: "created" })).toBeNull();
  });
});

describe("parseGitLabCommentEvent", () => {
  const note = (attrs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    object_kind: "note",
    user: { username: "dev" },
    project: { id: 200 },
    merge_request: { iid: 9 },
    object_attributes: {
      id: 501,
      note: "@omniralph why?",
      noteable_type: "MergeRequest",
      action: "create",
      type: "DiffNote",
      discussion_id: "d".repeat(40),
      ...attrs,
    },
    ...extra,
  });

  it("parses a note in a diff discussion", () => {
    expect(parseGitLabCommentEvent("Note Hook", note())).toEqual({
      number: 9,
      commentId: "501",
      body: "@omniralph why?",
      author: { username: "dev", isBot: false },
      threadIds: ["d".repeat(40), "501"],
      replyTo: { kind: "thread", commentId: "d".repeat(40) },
    });
  });

  it("replies to top-level notes in the MR conversation", () => {
    expect(parseGitLabCommentEvent("Note Hook", note({ type: null }))).toMatchObject({
      replyTo: { kind: "conversation" },
    });
  });

  it("ignores system notes, edits, other noteables and other events", () => {
    expect(parseGitLabCommentEvent("Note Hook", note({ system: true }))).toBeNull();
    expect(parseGitLabCommentEvent("Note Hook", note({ action: "update" }))).toBeNull();
    expect(parseGitLabCommentEvent("Note Hook", note({ noteable_type: "Issue" }))).toBeNull();
    expect(parseGitLabCommentEvent("Note Hook", note({}, { merge_request: undefined }))).toBeNull();
    expect(parseGitLabCommentEvent("Merge Request Hook", note())).toBeNull();
    // Older GitLab versions send no action.
    expect(parseGitLabCommentEvent("Note Hook", note({ action: undefined }))).not.toBeNull();
  });
});

describe("CI events", () => {
  const workflowRun = (action: string, conclusion: string | null, prs: number[] = [7]) => ({
    action,
    workflow_run: {
      head_sha: "abc",
      head_branch: "eng-1-x",
      conclusion,
      pull_requests: prs.map((number) => ({ number })),
    },
  });

  it("parses completed GitHub workflow runs", () => {
    expect(parseGitHubCiEvent("workflow_run", workflowRun("completed", "failure"))).toEqual({
      prNumbers: [7],
      branch: "eng-1-x",
      headSha: "abc",
      failed: true,
    });
    for (const conclusion of ["timed_out", "startup_failure"]) {
      expect(parseGitHubCiEvent("workflow_run", workflowRun("completed", conclusion))?.failed).toBe(
        true,
      );
    }
    for (const conclusion of ["success", "cancelled", "skipped"]) {
      expect(parseGitHubCiEvent("workflow_run", workflowRun("completed", conclusion))?.failed).toBe(
        false,
      );
    }
    expect(parseGitHubCiEvent("workflow_run", workflowRun("requested", null))).toBeNull();
    expect(parseGitHubCiEvent("pull_request", workflowRun("completed", "failure"))).toBeNull();
  });

  it("parses GitLab pipeline events", () => {
    const pipeline = (status: string, mr: { iid: number } | null, tag = false) => ({
      object_kind: "pipeline",
      object_attributes: { id: 1, ref: "eng-1-x", tag, sha: "abc", status },
      merge_request: mr,
    });
    expect(parseGitLabCiEvent("Pipeline Hook", pipeline("failed", { iid: 3 }))).toEqual({
      prNumbers: [3],
      branch: "eng-1-x",
      headSha: "abc",
      failed: true,
    });
    expect(parseGitLabCiEvent("Pipeline Hook", pipeline("failed", null))).toMatchObject({
      prNumbers: [],
      branch: "eng-1-x",
    });
    expect(parseGitLabCiEvent("Pipeline Hook", pipeline("failed", null, true))?.branch).toBeNull();
    expect(parseGitLabCiEvent("Pipeline Hook", pipeline("running", null))?.failed).toBe(false);
    expect(parseGitLabCiEvent("Note Hook", pipeline("failed", null))).toBeNull();
  });
});

describe("merge events", () => {
  it("parses merged GitHub pull requests only", () => {
    const closed = (merged: boolean | null) => ({
      action: "closed",
      pull_request: { number: 4, merged, state: "closed" },
    });
    expect(parseGitHubMergeEvent("pull_request", closed(true))).toEqual({ number: 4 });
    expect(parseGitHubMergeEvent("pull_request", closed(false))).toBeNull();
    expect(parseGitHubMergeEvent("pull_request", closed(null))).toBeNull();
    expect(
      parseGitHubMergeEvent("pull_request", { ...closed(true), action: "synchronize" }),
    ).toBeNull();
    expect(parseGitHubMergeEvent("issue_comment", closed(true))).toBeNull();
  });

  it("parses merged GitLab merge requests only", () => {
    const mr = (action: string | undefined, state: string) => ({
      object_kind: "merge_request",
      object_attributes: { iid: 9, state, ...(action && { action }) },
    });
    expect(parseGitLabMergeEvent("Merge Request Hook", mr("merge", "merged"))).toEqual({
      number: 9,
    });
    // Older GitLab versions send no action.
    expect(parseGitLabMergeEvent("Merge Request Hook", mr(undefined, "merged"))).toEqual({
      number: 9,
    });
    expect(parseGitLabMergeEvent("Merge Request Hook", mr("close", "closed"))).toBeNull();
    expect(parseGitLabMergeEvent("Merge Request Hook", mr("update", "merged"))).toBeNull();
    expect(parseGitLabMergeEvent("Pipeline Hook", mr("merge", "merged"))).toBeNull();
  });
});

describe("parseGitHubInstallationDeleted", () => {
  it("returns the installation ID of an uninstall only", () => {
    const body = (action: string) => ({ action, installation: { id: 42 } });
    expect(parseGitHubInstallationDeleted("installation", body("deleted"))).toBe("42");
    expect(parseGitHubInstallationDeleted("installation", body("suspend"))).toBeNull();
    expect(parseGitHubInstallationDeleted("installation", body("created"))).toBeNull();
    expect(parseGitHubInstallationDeleted("pull_request", body("deleted"))).toBeNull();
    expect(parseGitHubInstallationDeleted("installation", { action: "deleted" })).toBeNull();
  });
});
