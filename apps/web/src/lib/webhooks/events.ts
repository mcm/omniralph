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
