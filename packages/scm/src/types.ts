import type { ChangeRequestStatus, CiStatus } from "./ci.js";

/**
 * Provider-neutral SCM types. Review logic talks to code hosts only through
 * {@link ScmAdapter}; GitHub and GitLab implement it.
 */

export type ScmProvider = "github" | "gitlab";

/** A repository on a code host. */
export interface RepoRef {
  /** `owner/repo` on GitHub, `group/subgroup/project` on GitLab. */
  fullPath: string;
  /** Provider repository/project ID, when known. */
  externalId?: string;
}

export type ChangeRequestState = "open" | "closed" | "merged";

/** A pull request (GitHub) or merge request (GitLab). */
export interface ChangeRequest {
  number: number;
  title: string;
  description: string;
  author: string;
  draft: boolean;
  /** `open` (GitLab `opened`/`locked`), `closed` or `merged`. */
  state: ChangeRequestState;
  /** Merge base of the target branch and head (GitLab `diff_refs.base_sha`). */
  baseSha: string;
  /**
   * Target-branch tip the diff was computed against (GitLab
   * `diff_refs.start_sha`); GitLab inline positions need it.
   */
  startSha?: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  url: string;
}

/**
 * Which side of the diff a comment is anchored to: `new` is the head version
 * (added or context lines), `old` the base version (deleted lines).
 */
export type DiffSide = "new" | "old";

export interface InlineComment {
  path: string;
  /** Last (or only) line of the commented range. */
  line: number;
  /** First line of a multi-line range; omit for single-line comments. */
  startLine?: number;
  /** Defaults to `new`. */
  side?: DiffSide;
  /** Markdown body. */
  body: string;
  /** Replacement for lines `startLine..line`, rendered as a suggestion block. */
  suggestion?: string;
}

export interface ReviewSubmission {
  /** Markdown summary; becomes the review body / summary comment. */
  summary: string;
  inlineComments: InlineComment[];
  /** Head SHA the review was computed against. Defaults to the current head. */
  commitSha?: string;
}

export interface PostedReview {
  /** Provider ID of the review (GitHub) or summary note (GitLab). */
  reviewId: string;
  /** ID of the comment holding the summary. */
  summaryCommentId: string;
  /**
   * One entry per `inlineComments` item, in input order: the posted comment
   * ID (GitHub review comment ID, GitLab discussion ID), or `null` when the
   * comment fell back into the summary because its lines aren't part of the
   * diff.
   */
  inlineCommentIds: (string | null)[];
}

/** Short-lived credential for `git clone`/`fetch` (and `push`, when write-scoped). */
export interface CloneCredential {
  cloneUrl: string;
  username: string;
  token: string;
  expiresAt: Date;
}

/** An open PR/MR found by its source branch. */
export interface OpenChangeRequest {
  number: number;
  url: string;
  draft: boolean;
}

export interface NewChangeRequest {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  /** Markdown description; sanitize model-written text before passing it. */
  body: string;
  draft: boolean;
}

export interface CreatedChangeRequest {
  number: number;
  url: string;
  /**
   * `false` when an open PR/MR already existed for the source branch and was
   * returned instead (its title, body and draft state are left as they were).
   */
  created: boolean;
}

export interface ChangeRequestUpdate {
  title?: string;
  body?: string;
}

/** The PR/MR doesn't exist (or the bot can't see it). */
export class ChangeRequestNotFoundError extends Error {
  constructor(
    readonly repo: RepoRef,
    readonly number: number,
    options?: { cause?: unknown },
  ) {
    super(`Change request ${repo.fullPath}#${number} not found`, options);
    this.name = "ChangeRequestNotFoundError";
  }
}

/** Webhook request headers, either a Fetch `Headers` or a plain record. */
export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>;

export interface ScmAdapter {
  readonly provider: ScmProvider;
  getChangeRequest(repo: RepoRef, number: number): Promise<ChangeRequest>;
  /** Posts one review: a summary plus inline comments. */
  postReview(repo: RepoRef, number: number, review: ReviewSubmission): Promise<PostedReview>;
  /** Posts a top-level comment on the PR/MR conversation; returns its ID. */
  postComment(repo: RepoRef, number: number, body: string): Promise<{ id: string }>;
  /** Replies in the thread of an inline comment; returns the new comment ID. */
  replyToComment(repo: RepoRef, number: number, commentId: string, body: string): Promise<{ id: string }>;
  /** Resolves the thread containing an inline comment. */
  resolveThread(repo: RepoRef, number: number, commentId: string): Promise<void>;
  getReadOnlyCloneCredential(repo: RepoRef): Promise<CloneCredential>;
  /**
   * A short-lived credential that can push to this one repository (ralph
   * jobs). Never hand it to review jobs.
   */
  getWriteCloneCredential(repo: RepoRef): Promise<CloneCredential>;
  hasWriteAccess(repo: RepoRef, username: string): Promise<boolean>;
  /** The repository's default branch (the base of ralph runs). */
  getDefaultBranch(repo: RepoRef): Promise<string>;
  /** The open PR/MR whose source is `sourceBranch` (in this repository), if any. */
  findOpenChangeRequest(repo: RepoRef, sourceBranch: string): Promise<OpenChangeRequest | null>;
  /**
   * Opens a PR/MR (a draft when `draft`). When one is already open for the
   * source branch, returns it with `created: false`.
   */
  createChangeRequest(repo: RepoRef, request: NewChangeRequest): Promise<CreatedChangeRequest>;
  /**
   * Updates the title and/or body. Keeps a GitLab draft a draft. Throws
   * {@link ChangeRequestNotFoundError} when the PR/MR doesn't exist.
   */
  updateChangeRequest(repo: RepoRef, number: number, update: ChangeRequestUpdate): Promise<void>;
  /** Takes the PR/MR out of draft; a no-op when it isn't one. */
  markChangeRequestReady(repo: RepoRef, number: number): Promise<void>;
  /**
   * CI state of the PR/MR's current head commit, with its failed jobs.
   * Throws {@link ChangeRequestNotFoundError} when the PR/MR doesn't exist.
   */
  getCiStatus(repo: RepoRef, number: number): Promise<CiStatus>;
  /**
   * Log of a failed CI job (`CiFailedJob.id`): cleaned of ANSI codes and
   * GitLab section markers, only its last 4,000 chars (prefixed with "…").
   */
  getCiJobLog(repo: RepoRef, jobId: string): Promise<string>;
  /**
   * Whether the PR/MR is open, merged or closed, with its head and merge
   * commits. Throws {@link ChangeRequestNotFoundError} when it doesn't exist.
   */
  getChangeRequestState(repo: RepoRef, number: number): Promise<ChangeRequestStatus>;
  /** Verifies a webhook delivery's signature against the raw request body. */
  verifyWebhook(headers: WebhookHeaders, rawBody: string | Uint8Array): Promise<boolean>;
}

export function getHeader(headers: WebhookHeaders, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}
