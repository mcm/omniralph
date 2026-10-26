import { z } from "zod";

/**
 * A PR/MR event that may trigger a review: `open` covers opened, reopened and
 * ready-for-review (the `onOpen` trigger), `push` new commits (`onPush`).
 */
export interface ChangeRequestEvent {
  kind: "open" | "push";
  number: number;
  draft: boolean;
  headSha: string;
  /** Target-branch commit to diff against (GitLab events carry none; it's looked up). */
  baseSha: string | null;
  title: string;
  description: string | null;
  /** Author username (GitLab events only carry the acting user; it's looked up). */
  author: string | null;
  /** The repository's default branch (`repository.default_branch` / `project.default_branch`). */
  defaultBranch: string | null;
}

/** A delivery's repository (GitHub) or project (GitLab) default branch, when it names one. */
const GitHubRepositoryBranch = z.object({
  repository: z.object({ default_branch: z.string().min(1) }),
});
const GitLabProjectBranch = z.object({
  project: z.object({ default_branch: z.string().min(1) }),
});

/** The default branch a delivery body names (every repository/project payload does), or null. */
export function webhookDefaultBranch(provider: "github" | "gitlab", body: unknown): string | null {
  if (provider === "github") {
    const parsed = GitHubRepositoryBranch.safeParse(body);
    return parsed.success ? parsed.data.repository.default_branch : null;
  }
  const parsed = GitLabProjectBranch.safeParse(body);
  return parsed.success ? parsed.data.project.default_branch : null;
}

const GitHubPullRequestEvent = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number().int().positive(),
    state: z.string(),
    draft: z.boolean().optional(),
    title: z.string(),
    body: z.string().nullish(),
    user: z.object({ login: z.string() }).nullish(),
    head: z.object({ sha: z.string().min(1) }),
    base: z.object({ sha: z.string().min(1) }),
  }),
});

const GITHUB_ACTIONS: Record<string, ChangeRequestEvent["kind"]> = {
  opened: "open",
  reopened: "open",
  ready_for_review: "open",
  synchronize: "push",
};

/** The review-triggering event of a GitHub delivery (`X-GitHub-Event`), or null. */
export function parseGitHubEvent(
  eventName: string | null,
  body: unknown,
): ChangeRequestEvent | null {
  if (eventName !== "pull_request") return null;
  const parsed = GitHubPullRequestEvent.safeParse(body);
  if (!parsed.success) return null;
  const { action, pull_request: pr } = parsed.data;
  const kind = GITHUB_ACTIONS[action];
  if (!kind || pr.state !== "open") return null;
  return {
    kind,
    number: pr.number,
    draft: pr.draft ?? false,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    title: pr.title,
    description: pr.body ?? null,
    author: pr.user?.login ?? null,
    defaultBranch: webhookDefaultBranch("github", body),
  };
}

const DraftChange = z.object({ previous: z.boolean().nullish(), current: z.boolean().nullish() });

const GitLabMergeRequestEvent = z.object({
  object_kind: z.literal("merge_request"),
  object_attributes: z.object({
    iid: z.number().int().positive(),
    action: z.string().optional(),
    state: z.string(),
    title: z.string(),
    description: z.string().nullish(),
    draft: z.boolean().optional(),
    work_in_progress: z.boolean().optional(),
    oldrev: z.string().nullish(),
    last_commit: z.object({ id: z.string().min(1) }),
  }),
  changes: z
    .object({ draft: DraftChange.optional(), work_in_progress: DraftChange.optional() })
    .optional(),
});

function readyForReview(changes: z.infer<typeof GitLabMergeRequestEvent>["changes"]): boolean {
  const change = changes?.draft ?? changes?.work_in_progress;
  return change?.previous === true && change.current === false;
}

/** The review-triggering event of a GitLab delivery (`X-Gitlab-Event`), or null. */
export function parseGitLabEvent(
  eventName: string | null,
  body: unknown,
): ChangeRequestEvent | null {
  if (eventName !== "Merge Request Hook") return null;
  const parsed = GitLabMergeRequestEvent.safeParse(body);
  if (!parsed.success) return null;
  const { object_attributes: mr, changes } = parsed.data;
  if (mr.state !== "opened") return null;
  let kind: ChangeRequestEvent["kind"] | null = null;
  if (mr.action === "open" || mr.action === "reopen") kind = "open";
  else if (mr.action === "update" && mr.oldrev) kind = "push";
  else if (mr.action === "update" && readyForReview(changes)) kind = "open";
  if (!kind) return null;
  return {
    kind,
    number: mr.iid,
    draft: mr.draft ?? mr.work_in_progress ?? false,
    headSha: mr.last_commit.id,
    baseSha: null,
    title: mr.title,
    description: mr.description ?? null,
    author: null,
    defaultBranch: webhookDefaultBranch("gitlab", body),
  };
}

/**
 * A PR/MR that was closed, merged or not (GitHub `pull_request` `closed`,
 * GitLab MR `merge` or `close`).
 */
export interface ClosedEvent {
  number: number;
  merged: boolean;
}

const GitHubClosedEvent = z.object({
  action: z.literal("closed"),
  pull_request: z.object({ number: z.number().int().positive(), merged: z.boolean().nullish() }),
});

/** The closing (or merge) of a GitHub delivery (`X-GitHub-Event: pull_request`), or null. */
export function parseGitHubClosedEvent(
  eventName: string | null,
  body: unknown,
): ClosedEvent | null {
  if (eventName !== "pull_request") return null;
  const parsed = GitHubClosedEvent.safeParse(body);
  if (!parsed.success) return null;
  const pr = parsed.data.pull_request;
  return { number: pr.number, merged: pr.merged === true };
}

const GitLabClosedEvent = z.object({
  object_kind: z.literal("merge_request"),
  object_attributes: z.object({
    iid: z.number().int().positive(),
    action: z.string().optional(),
    state: z.string(),
  }),
});

/** The closing (or merge) of a GitLab delivery (`X-Gitlab-Event: Merge Request Hook`), or null. */
export function parseGitLabClosedEvent(
  eventName: string | null,
  body: unknown,
): ClosedEvent | null {
  if (eventName !== "Merge Request Hook") return null;
  const parsed = GitLabClosedEvent.safeParse(body);
  if (!parsed.success) return null;
  const mr = parsed.data.object_attributes;
  // Older GitLab versions send no action: the state says it.
  const action =
    mr.action ?? (mr.state === "merged" ? "merge" : mr.state === "closed" ? "close" : undefined);
  if (action !== "merge" && action !== "close") return null;
  return { number: mr.iid, merged: action === "merge" };
}

/**
 * A new comment on a PR/MR that may hold a `@bot` command: GitHub
 * `issue_comment` (conversation) and `pull_request_review_comment` (inline
 * threads), GitLab Note Hook on merge requests.
 */
export interface CommentEvent {
  /** PR number (GitHub) or MR IID (GitLab). */
  number: number;
  /** The comment's own ID. */
  commentId: string;
  body: string;
  author: { username: string; isBot: boolean };
  /**
   * IDs a finding's `scm_comment_id` would have if the comment is in its
   * thread (GitHub: the thread's first comment; GitLab: the discussion).
   */
  threadIds: string[];
  /** Where replies go: the comment's thread, or the PR/MR conversation. */
  replyTo: { kind: "thread"; commentId: string } | { kind: "conversation" };
}

const GitHubUser = z.object({ login: z.string().min(1), type: z.string().optional() });
const GitHubIssueCommentEvent = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.object({}).loose().nullish(),
  }),
  comment: z.object({ id: z.number().int(), body: z.string().nullish(), user: GitHubUser }),
});
const GitHubReviewCommentEvent = z.object({
  action: z.string(),
  pull_request: z.object({ number: z.number().int().positive() }),
  comment: z.object({
    id: z.number().int(),
    in_reply_to_id: z.number().int().nullish(),
    body: z.string().nullish(),
    user: GitHubUser,
  }),
});

const githubAuthor = (user: z.infer<typeof GitHubUser>) => ({
  username: user.login,
  isBot: user.type === "Bot",
});

/** A new PR comment of a GitHub delivery (`X-GitHub-Event`), or null. */
export function parseGitHubCommentEvent(
  eventName: string | null,
  body: unknown,
): CommentEvent | null {
  if (eventName === "issue_comment") {
    const parsed = GitHubIssueCommentEvent.safeParse(body);
    if (!parsed.success || parsed.data.action !== "created" || !parsed.data.issue.pull_request) {
      return null;
    }
    const { issue, comment } = parsed.data;
    return {
      number: issue.number,
      commentId: String(comment.id),
      body: comment.body ?? "",
      author: githubAuthor(comment.user),
      threadIds: [],
      replyTo: { kind: "conversation" },
    };
  }
  if (eventName === "pull_request_review_comment") {
    const parsed = GitHubReviewCommentEvent.safeParse(body);
    if (!parsed.success || parsed.data.action !== "created") return null;
    const { pull_request: pr, comment } = parsed.data;
    // Replies can only be made to a thread's first comment.
    const root = String(comment.in_reply_to_id ?? comment.id);
    return {
      number: pr.number,
      commentId: String(comment.id),
      body: comment.body ?? "",
      author: githubAuthor(comment.user),
      threadIds: [root],
      replyTo: { kind: "thread", commentId: root },
    };
  }
  return null;
}

const GitLabNoteEvent = z.object({
  object_kind: z.literal("note"),
  user: z.object({ username: z.string().min(1) }),
  merge_request: z.object({ iid: z.number().int().positive() }).nullish(),
  object_attributes: z.object({
    id: z.number().int(),
    note: z.string().nullish(),
    noteable_type: z.string(),
    action: z.string().optional(),
    system: z.boolean().optional(),
    type: z.string().nullish(),
    discussion_id: z.string().nullish(),
  }),
});

/** A new MR note of a GitLab delivery (`X-Gitlab-Event`), or null. */
export function parseGitLabCommentEvent(
  eventName: string | null,
  body: unknown,
): CommentEvent | null {
  if (eventName !== "Note Hook") return null;
  const parsed = GitLabNoteEvent.safeParse(body);
  if (!parsed.success) return null;
  const { object_attributes: note, merge_request: mr, user } = parsed.data;
  if (note.noteable_type !== "MergeRequest" || !mr || note.system) return null;
  // Older GitLab versions send no action; edits ("update") are ignored.
  if (note.action !== undefined && note.action !== "create") return null;
  const threaded =
    (note.type === "DiffNote" || note.type === "DiscussionNote") && note.discussion_id;
  return {
    number: mr.iid,
    commentId: String(note.id),
    body: note.note ?? "",
    author: { username: user.username, isBot: false },
    threadIds: [note.discussion_id, String(note.id)].filter((id): id is string => Boolean(id)),
    replyTo: threaded
      ? { kind: "thread", commentId: note.discussion_id! }
      : { kind: "conversation" },
  };
}

/** Where a PR/MR's human review stands (`ralph_lanes.pr_review_state`). */
export type PullRequestReviewState =
  "none" | "review_requested" | "commented" | "changes_requested" | "approved";

/**
 * A change to an open PR/MR's draft or review state (GitHub `pull_request`
 * and `pull_request_review`, GitLab Merge Request Hook), for ralph lanes.
 */
export interface PullRequestStateEvent {
  number: number;
  /** Whether it's a draft now. */
  draft: boolean;
  /**
   * The review state it moves to, if any; `from` limits the move to those
   * states (a comment doesn't undo an approval, say).
   */
  reviewState?: { to: PullRequestReviewState; from?: readonly PullRequestReviewState[] };
  /** Who reviewed, approved or unapproved, for review events: the bot's own are ignored. */
  reviewer: { username: string; isBot: boolean } | null;
  /**
   * When the code host says the change happened, if the payload says: a lane
   * whose state is newer ignores it (an out-of-order delivery).
   */
  occurredAt: Date | null;
}

/** A webhook timestamp (ISO 8601, or GitLab's `2026-10-25 12:00:00 UTC`) as a Date, or null. */
function webhookTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const time = new Date(value.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/, "$1T$2Z"));
  return Number.isNaN(time.getTime()) ? null : time;
}

const GitHubStatePullRequest = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  draft: z.boolean().optional(),
  requested_reviewers: z.array(z.unknown()).nullish(),
  requested_teams: z.array(z.unknown()).nullish(),
  updated_at: z.string().nullish(),
});
const GitHubPullRequestStateEvent = z.object({
  action: z.string(),
  pull_request: GitHubStatePullRequest,
});
const GitHubPullRequestReviewEvent = z.object({
  action: z.string(),
  review: z.object({
    state: z.string(),
    user: GitHubUser.nullish(),
    submitted_at: z.string().nullish(),
  }),
  pull_request: GitHubStatePullRequest,
});

/** Whether a GitHub PR still has reviewers (users or teams) asked to review it. */
const githubAwaitsReview = (pr: z.infer<typeof GitHubStatePullRequest>) =>
  (pr.requested_reviewers?.length ?? 0) + (pr.requested_teams?.length ?? 0) > 0;

type ReviewMove = PullRequestStateEvent["reviewState"];

const GITHUB_PULL_REQUEST_STATE_ACTIONS: Record<string, (awaitsReview: boolean) => ReviewMove> = {
  opened: (awaits) => ({ to: awaits ? "review_requested" : "none" }),
  reopened: (awaits) => (awaits ? { to: "review_requested", from: ["none"] } : undefined),
  ready_for_review: (awaits) => (awaits ? { to: "review_requested", from: ["none"] } : undefined),
  converted_to_draft: () => undefined,
  review_requested: () => ({ to: "review_requested" }),
  review_request_removed: (awaits) =>
    awaits ? undefined : { to: "none", from: ["review_requested"] },
};

const GITHUB_REVIEW_STATES: Record<string, NonNullable<ReviewMove>> = {
  approved: { to: "approved" },
  changes_requested: { to: "changes_requested" },
  // A comment doesn't undo an approval or a change request.
  commented: { to: "commented", from: ["none", "review_requested"] },
};

/**
 * The draft or review state change of a GitHub delivery (`X-GitHub-Event`
 * `pull_request` or `pull_request_review`) on an open PR, or null.
 */
export function parseGitHubPullRequestStateEvent(
  eventName: string | null,
  body: unknown,
): PullRequestStateEvent | null {
  if (eventName === "pull_request") {
    const parsed = GitHubPullRequestStateEvent.safeParse(body);
    if (!parsed.success) return null;
    const { action, pull_request: pr } = parsed.data;
    const move = Object.hasOwn(GITHUB_PULL_REQUEST_STATE_ACTIONS, action)
      ? GITHUB_PULL_REQUEST_STATE_ACTIONS[action]
      : undefined;
    if (!move || pr.state !== "open") return null;
    return {
      number: pr.number,
      draft: pr.draft ?? false,
      reviewState: move(githubAwaitsReview(pr)),
      reviewer: null,
      occurredAt: webhookTime(pr.updated_at),
    };
  }
  if (eventName === "pull_request_review") {
    const parsed = GitHubPullRequestReviewEvent.safeParse(body);
    if (!parsed.success) return null;
    const { action, review, pull_request: pr } = parsed.data;
    if (pr.state !== "open") return null;
    const awaits = githubAwaitsReview(pr);
    let reviewState: ReviewMove;
    if (action === "submitted") {
      const state = review.state.toLowerCase();
      if (!Object.hasOwn(GITHUB_REVIEW_STATES, state)) return null;
      reviewState = GITHUB_REVIEW_STATES[state];
    } else if (action === "dismissed") {
      reviewState = {
        to: awaits ? "review_requested" : "none",
        from: ["approved", "changes_requested"],
      };
    } else return null;
    return {
      number: pr.number,
      draft: pr.draft ?? false,
      reviewState,
      reviewer: review.user ? githubAuthor(review.user) : null,
      // A dismissal has no time of its own: the PR's last update is when it happened.
      occurredAt: webhookTime(action === "submitted" ? review.submitted_at : pr.updated_at),
    };
  }
  return null;
}

const GitLabUser = z.object({ id: z.number().int().optional(), username: z.string().min(1) });
const ReviewersChange = z.object({
  previous: z.array(GitLabUser).nullish(),
  current: z.array(GitLabUser).nullish(),
});
const GitLabMergeRequestStateEvent = z.object({
  object_kind: z.literal("merge_request"),
  user: GitLabUser.nullish(),
  reviewers: z.array(GitLabUser).nullish(),
  object_attributes: z.object({
    iid: z.number().int().positive(),
    action: z.string().optional(),
    state: z.string(),
    draft: z.boolean().optional(),
    work_in_progress: z.boolean().optional(),
    updated_at: z.string().nullish(),
  }),
  changes: z
    .object({
      draft: DraftChange.optional(),
      work_in_progress: DraftChange.optional(),
      reviewers: ReviewersChange.optional(),
    })
    .optional(),
});

const gitlabUserKey = (user: z.infer<typeof GitLabUser>) => user.id ?? user.username;

/**
 * The draft or review state change of a GitLab delivery (`X-Gitlab-Event:
 * Merge Request Hook`) on an open MR, or null: approvals, opening and
 * reopening, and updates that change the draft flag or the reviewers.
 */
export function parseGitLabPullRequestStateEvent(
  eventName: string | null,
  body: unknown,
): PullRequestStateEvent | null {
  if (eventName !== "Merge Request Hook") return null;
  const parsed = GitLabMergeRequestStateEvent.safeParse(body);
  if (!parsed.success) return null;
  const { object_attributes: mr, changes, user } = parsed.data;
  if (mr.state !== "opened") return null;
  const awaits = (parsed.data.reviewers?.length ?? 0) > 0;
  const actor = user ? { username: user.username, isBot: false } : null;
  const event = (
    reviewState: ReviewMove,
    reviewer: PullRequestStateEvent["reviewer"] = null,
  ): PullRequestStateEvent => ({
    number: mr.iid,
    draft: mr.draft ?? mr.work_in_progress ?? false,
    reviewState,
    reviewer,
    occurredAt: webhookTime(mr.updated_at),
  });
  switch (mr.action) {
    case "open":
      return event({ to: awaits ? "review_requested" : "none" });
    case "reopen":
      return event(awaits ? { to: "review_requested", from: ["none"] } : undefined);
    case "approved":
    case "approval":
      return event({ to: "approved" }, actor);
    case "unapproved":
    case "unapproval":
      return event({ to: awaits ? "review_requested" : "none", from: ["approved"] }, actor);
    case "update": {
      const draftChanged = Boolean(changes?.draft ?? changes?.work_in_progress);
      const reviewers = changes?.reviewers;
      if (!draftChanged && !reviewers) return null;
      let reviewState: ReviewMove;
      if (reviewers) {
        const before = new Set((reviewers.previous ?? []).map(gitlabUserKey));
        const current = reviewers.current ?? [];
        if (current.some((r) => !before.has(gitlabUserKey(r)))) {
          reviewState = { to: "review_requested" };
        } else if (current.length === 0) {
          reviewState = { to: "none", from: ["review_requested"] };
        }
      }
      return event(reviewState);
    }
    default:
      return null;
  }
}

/**
 * A finished CI run (GitHub `workflow_run` completed, GitLab Pipeline Hook)
 * that may need fixing on a ralph PR/MR.
 */
export interface CiEvent {
  /** PRs (GitHub) or the MR (GitLab) it ran for; empty when it names none. */
  prNumbers: number[];
  /** The branch it ran on (`null` for tag pipelines). */
  branch: string | null;
  headSha: string;
  /** Whether it failed; only failures are acted on. */
  failed: boolean;
}

const GITHUB_FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

const GitHubWorkflowRunEvent = z.object({
  action: z.string(),
  workflow_run: z.object({
    head_sha: z.string().min(1),
    head_branch: z.string().nullish(),
    conclusion: z.string().nullish(),
    pull_requests: z.array(z.object({ number: z.number().int().positive() })).nullish(),
  }),
});

/** A completed workflow run of a GitHub delivery (`X-GitHub-Event: workflow_run`), or null. */
export function parseGitHubCiEvent(eventName: string | null, body: unknown): CiEvent | null {
  if (eventName !== "workflow_run") return null;
  const parsed = GitHubWorkflowRunEvent.safeParse(body);
  if (!parsed.success || parsed.data.action !== "completed") return null;
  const run = parsed.data.workflow_run;
  return {
    prNumbers: (run.pull_requests ?? []).map((pr) => pr.number),
    branch: run.head_branch ?? null,
    headSha: run.head_sha,
    failed: GITHUB_FAILED_CONCLUSIONS.has(run.conclusion ?? ""),
  };
}

const GitLabPipelineEvent = z.object({
  object_kind: z.literal("pipeline"),
  object_attributes: z.object({
    ref: z.string().nullish(),
    tag: z.boolean().nullish(),
    sha: z.string().min(1),
    status: z.string(),
  }),
  merge_request: z.object({ iid: z.number().int().positive() }).nullish(),
});

/** A pipeline of a GitLab delivery (`X-Gitlab-Event: Pipeline Hook`), or null. */
export function parseGitLabCiEvent(eventName: string | null, body: unknown): CiEvent | null {
  if (eventName !== "Pipeline Hook") return null;
  const parsed = GitLabPipelineEvent.safeParse(body);
  if (!parsed.success) return null;
  const { object_attributes: pipeline, merge_request: mr } = parsed.data;
  return {
    prNumbers: mr ? [mr.iid] : [],
    branch: pipeline.tag ? null : (pipeline.ref ?? null),
    headSha: pipeline.sha,
    failed: pipeline.status === "failed",
  };
}

/** Provider repository/project ID of a delivery body, if any. */
export function webhookRepositoryId(provider: "github" | "gitlab", body: unknown): string | null {
  const schema =
    provider === "github"
      ? z.object({ repository: z.object({ id: z.number().int() }) })
      : z.object({ project: z.object({ id: z.number().int() }) });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return null;
  return String("repository" in parsed.data ? parsed.data.repository.id : parsed.data.project.id);
}

/** GitHub App installation ID of a delivery body, if any. */
export function githubInstallationId(body: unknown): string | null {
  const parsed = z.object({ installation: z.object({ id: z.number().int() }) }).safeParse(body);
  return parsed.success ? String(parsed.data.installation.id) : null;
}

const GitHubInstallationDeletedEvent = z.object({
  action: z.literal("deleted"),
  installation: z.object({ id: z.number().int() }),
});

/**
 * The installation ID of a GitHub App uninstall (`X-GitHub-Event: installation`, action
 * `deleted`), or null.
 */
export function parseGitHubInstallationDeleted(
  eventName: string | null,
  body: unknown,
): string | null {
  if (eventName !== "installation") return null;
  const parsed = GitHubInstallationDeletedEvent.safeParse(body);
  return parsed.success ? String(parsed.data.installation.id) : null;
}
