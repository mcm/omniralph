import { describe, expect, it } from "vitest";
import {
  parseGitHubCiEvent,
  parseGitHubCommentEvent,
  parseGitHubEvent,
  parseGitHubInstallationDeleted,
  parseGitHubClosedEvent,
  parseGitHubPullRequestStateEvent,
  parseGitLabCiEvent,
  parseGitLabCommentEvent,
  parseGitLabEvent,
  parseGitLabClosedEvent,
  parseGitLabPullRequestStateEvent,
  webhookDefaultBranch,
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

describe("closed events", () => {
  it("parses closed GitHub pull requests, merged or not", () => {
    const closed = (merged: boolean | null) => ({
      action: "closed",
      pull_request: { number: 4, merged, state: "closed" },
    });
    expect(parseGitHubClosedEvent("pull_request", closed(true))).toEqual({
      number: 4,
      merged: true,
    });
    expect(parseGitHubClosedEvent("pull_request", closed(false))).toEqual({
      number: 4,
      merged: false,
    });
    expect(parseGitHubClosedEvent("pull_request", closed(null))).toEqual({
      number: 4,
      merged: false,
    });
    expect(
      parseGitHubClosedEvent("pull_request", { ...closed(true), action: "synchronize" }),
    ).toBeNull();
    expect(
      parseGitHubClosedEvent("pull_request", { ...closed(false), action: "reopened" }),
    ).toBeNull();
    expect(parseGitHubClosedEvent("issue_comment", closed(true))).toBeNull();
  });

  it("parses merged and closed GitLab merge requests", () => {
    const mr = (action: string | undefined, state: string) => ({
      object_kind: "merge_request",
      object_attributes: { iid: 9, state, ...(action && { action }) },
    });
    const hook = "Merge Request Hook";
    expect(parseGitLabClosedEvent(hook, mr("merge", "merged"))).toEqual({
      number: 9,
      merged: true,
    });
    expect(parseGitLabClosedEvent(hook, mr("close", "closed"))).toEqual({
      number: 9,
      merged: false,
    });
    // Older GitLab versions send no action.
    expect(parseGitLabClosedEvent(hook, mr(undefined, "merged"))).toEqual({
      number: 9,
      merged: true,
    });
    expect(parseGitLabClosedEvent(hook, mr(undefined, "closed"))).toEqual({
      number: 9,
      merged: false,
    });
    expect(parseGitLabClosedEvent(hook, mr(undefined, "opened"))).toBeNull();
    expect(parseGitLabClosedEvent(hook, mr("update", "merged"))).toBeNull();
    expect(parseGitLabClosedEvent(hook, mr("update", "closed"))).toBeNull();
    expect(parseGitLabClosedEvent(hook, mr("reopen", "opened"))).toBeNull();
    expect(parseGitLabClosedEvent("Pipeline Hook", mr("merge", "merged"))).toBeNull();
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

describe("parseGitHubPullRequestStateEvent", () => {
  const pr = (overrides: Record<string, unknown> = {}) => ({
    number: 7,
    state: "open",
    draft: false,
    requested_reviewers: [],
    requested_teams: [],
    ...overrides,
  });
  const parse = (action: string, overrides: Record<string, unknown> = {}) =>
    parseGitHubPullRequestStateEvent("pull_request", { action, pull_request: pr(overrides) });

  it("reads the draft flag and requested reviewers of pull_request actions", () => {
    expect(parse("opened", { draft: true })).toEqual({
      number: 7,
      draft: true,
      reviewState: { to: "none" },
      reviewer: null,
      occurredAt: null,
    });
    expect(parse("opened", { requested_reviewers: [user] })?.reviewState).toEqual({
      to: "review_requested",
    });
    expect(parse("reopened", { requested_teams: [{ slug: "web" }] })?.reviewState).toEqual({
      to: "review_requested",
      from: ["none"],
    });
    expect(parse("reopened")?.reviewState).toBeUndefined();
    expect(parse("ready_for_review", { requested_reviewers: [user] })).toEqual({
      number: 7,
      draft: false,
      reviewState: { to: "review_requested", from: ["none"] },
      reviewer: null,
      occurredAt: null,
    });
    expect(parse("converted_to_draft", { draft: true })).toEqual({
      number: 7,
      draft: true,
      reviewState: undefined,
      reviewer: null,
      occurredAt: null,
    });
    expect(parse("review_requested", { requested_reviewers: [user] })?.reviewState).toEqual({
      to: "review_requested",
    });
    // Removing the last requested reviewer: nobody is asked any more.
    expect(parse("review_request_removed")?.reviewState).toEqual({
      to: "none",
      from: ["review_requested"],
    });
    expect(
      parse("review_request_removed", { requested_reviewers: [user] })?.reviewState,
    ).toBeUndefined();
  });

  it("ignores other actions, closed PRs and other events", () => {
    expect(parse("synchronize")).toBeNull();
    expect(parse("closed", { state: "closed" })).toBeNull();
    expect(parse("labeled")).toBeNull();
    expect(parse("constructor")).toBeNull();
    expect(parse("review_requested", { state: "closed" })).toBeNull();
    expect(
      parseGitHubPullRequestStateEvent("issues", { action: "opened", pull_request: pr() }),
    ).toBeNull();
    expect(parseGitHubPullRequestStateEvent("pull_request", { action: "opened" })).toBeNull();
  });

  const review = (action: string, state: string, overrides: Record<string, unknown> = {}) =>
    parseGitHubPullRequestStateEvent("pull_request_review", {
      action,
      review: { state, user },
      pull_request: pr(overrides),
    });

  it("reads submitted and dismissed reviews with their reviewer", () => {
    expect(review("submitted", "approved")).toEqual({
      number: 7,
      draft: false,
      reviewState: { to: "approved" },
      reviewer: { username: "octocat", isBot: false },
      occurredAt: null,
    });
    expect(review("submitted", "CHANGES_REQUESTED")?.reviewState).toEqual({
      to: "changes_requested",
    });
    expect(review("submitted", "commented")?.reviewState).toEqual({
      to: "commented",
      from: ["none", "review_requested"],
    });
    expect(review("dismissed", "dismissed")?.reviewState).toEqual({
      to: "none",
      from: ["approved", "changes_requested"],
    });
    expect(review("dismissed", "dismissed", { requested_reviewers: [user] })?.reviewState).toEqual({
      to: "review_requested",
      from: ["approved", "changes_requested"],
    });
    expect(
      parseGitHubPullRequestStateEvent("pull_request_review", {
        action: "submitted",
        review: { state: "approved", user: { login: "omniralph[bot]", type: "Bot" } },
        pull_request: pr(),
      })?.reviewer,
    ).toEqual({ username: "omniralph[bot]", isBot: true });
  });

  it("reads when the change happened", () => {
    expect(parse("review_requested", { updated_at: "2026-10-25T10:01:00Z" })?.occurredAt).toEqual(
      new Date("2026-10-25T10:01:00Z"),
    );
    expect(
      parseGitHubPullRequestStateEvent("pull_request_review", {
        action: "submitted",
        review: { state: "approved", user, submitted_at: "2026-10-25T10:05:00Z" },
        pull_request: pr({ updated_at: "2026-10-25T10:06:00Z" }),
      })?.occurredAt,
    ).toEqual(new Date("2026-10-25T10:05:00Z"));
    // A dismissal has no time of its own: the PR's update time.
    expect(
      review("dismissed", "dismissed", { updated_at: "2026-10-25T10:09:00Z" })?.occurredAt,
    ).toEqual(new Date("2026-10-25T10:09:00Z"));
    expect(parse("review_requested", { updated_at: "not a time" })?.occurredAt).toBeNull();
  });

  it("ignores pending and edited reviews and reviews of closed PRs", () => {
    expect(review("submitted", "pending")).toBeNull();
    expect(review("submitted", "constructor")).toBeNull();
    expect(review("edited", "approved")).toBeNull();
    expect(review("submitted", "approved", { state: "closed" })).toBeNull();
  });
});

describe("parseGitLabPullRequestStateEvent", () => {
  const reviewer = { id: 3, username: "reviewer" };
  const hook = (
    action: string,
    overrides: { attributes?: Record<string, unknown>; [key: string]: unknown } = {},
  ) => {
    const { attributes, ...rest } = overrides;
    return parseGitLabPullRequestStateEvent("Merge Request Hook", {
      object_kind: "merge_request",
      user: { id: 9, username: "approver" },
      reviewers: [],
      object_attributes: { iid: 4, action, state: "opened", draft: false, ...attributes },
      ...rest,
    });
  };

  it("reads approvals with their approver", () => {
    for (const action of ["approved", "approval"]) {
      expect(hook(action)).toEqual({
        number: 4,
        draft: false,
        reviewState: { to: "approved" },
        reviewer: { username: "approver", isBot: false },
        occurredAt: null,
      });
    }
    for (const action of ["unapproved", "unapproval"]) {
      expect(hook(action)?.reviewState).toEqual({ to: "none", from: ["approved"] });
      expect(hook(action, { reviewers: [reviewer] })?.reviewState).toEqual({
        to: "review_requested",
        from: ["approved"],
      });
    }
  });

  it("reads when the change happened, in either of GitLab's formats", () => {
    expect(
      hook("approved", { attributes: { updated_at: "2026-10-25 10:05:00 UTC" } })?.occurredAt,
    ).toEqual(new Date("2026-10-25T10:05:00Z"));
    expect(
      hook("approved", { attributes: { updated_at: "2026-10-25T10:05:00.000Z" } })?.occurredAt,
    ).toEqual(new Date("2026-10-25T10:05:00Z"));
  });

  it("reads opening and reopening, with reviewers", () => {
    expect(hook("open", { attributes: { draft: true } })).toEqual({
      number: 4,
      draft: true,
      reviewState: { to: "none" },
      reviewer: null,
      occurredAt: null,
    });
    expect(hook("reopen", { reviewers: [reviewer] })?.reviewState).toEqual({
      to: "review_requested",
      from: ["none"],
    });
    expect(hook("reopen")).toMatchObject({
      reviewState: undefined,
      reviewer: null,
      occurredAt: null,
    });
    // Older GitLab versions: work_in_progress.
    expect(hook("open", { attributes: { draft: undefined, work_in_progress: true } })?.draft).toBe(
      true,
    );
  });

  it("reads updates that change the draft flag or the reviewers", () => {
    expect(
      hook("update", {
        attributes: { draft: true },
        changes: { draft: { previous: false, current: true } },
      }),
    ).toEqual({ number: 4, draft: true, reviewState: undefined, reviewer: null, occurredAt: null });
    expect(
      hook("update", {
        reviewers: [reviewer],
        changes: { reviewers: { previous: [], current: [reviewer] } },
      })?.reviewState,
    ).toEqual({ to: "review_requested" });
    expect(
      hook("update", { changes: { reviewers: { previous: [reviewer], current: [] } } })
        ?.reviewState,
    ).toEqual({ to: "none", from: ["review_requested"] });
    // One of two reviewers removed: still waiting on the other.
    expect(
      hook("update", {
        reviewers: [reviewer],
        changes: {
          reviewers: { previous: [reviewer, { id: 5, username: "other" }], current: [reviewer] },
        },
      }),
    ).toMatchObject({ reviewState: undefined });
  });

  it("ignores other updates, other actions, closed MRs and other hooks", () => {
    expect(hook("update", { changes: { title: { previous: "a", current: "b" } } })).toBeNull();
    expect(hook("update")).toBeNull();
    expect(hook("merge", { attributes: { state: "merged" } })).toBeNull();
    expect(hook("approved", { attributes: { state: "closed" } })).toBeNull();
    expect(hook("close")).toBeNull();
    expect(
      parseGitLabPullRequestStateEvent("Note Hook", {
        object_kind: "merge_request",
        object_attributes: { iid: 4, action: "approved", state: "opened" },
      }),
    ).toBeNull();
  });
});

describe("default branch", () => {
  it("reads repository.default_branch from a GitHub pull_request delivery", () => {
    const body = {
      action: "opened",
      repository: { id: 100, full_name: "acme/app", default_branch: "release" },
      pull_request: {
        number: 7,
        state: "open",
        draft: false,
        title: "Add login",
        body: null,
        user: { login: "octocat" },
        head: { sha: "b".repeat(40) },
        base: { sha: "a".repeat(40) },
      },
    };
    expect(parseGitHubEvent("pull_request", body)).toMatchObject({
      kind: "open",
      number: 7,
      defaultBranch: "release",
    });
    expect(webhookDefaultBranch("github", body)).toBe("release");
    const { default_branch: _, ...withoutBranch } = body.repository;
    expect(parseGitHubEvent("pull_request", { ...body, repository: withoutBranch })).toMatchObject({
      defaultBranch: null,
    });
  });

  it("reads project.default_branch from a GitLab Merge Request Hook", () => {
    const body = {
      object_kind: "merge_request",
      project: {
        id: 4211,
        path_with_namespace: "managed-services/customer-portal",
        default_branch: "develop",
      },
      object_attributes: {
        iid: 12,
        action: "open",
        state: "opened",
        title: "Add login",
        description: "",
        draft: false,
        last_commit: { id: "c".repeat(40) },
      },
    };
    expect(parseGitLabEvent("Merge Request Hook", body)).toMatchObject({
      kind: "open",
      number: 12,
      defaultBranch: "develop",
    });
    expect(webhookDefaultBranch("gitlab", body)).toBe("develop");
    expect(webhookDefaultBranch("gitlab", { project: { id: 4211 } })).toBeNull();
    expect(webhookDefaultBranch("github", body)).toBeNull();
  });
});
