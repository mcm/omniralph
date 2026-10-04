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

/** A pull request (GitHub) or merge request (GitLab). */
export interface ChangeRequest {
  number: number;
  title: string;
  description: string;
  author: string;
  draft: boolean;
  baseSha: string;
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
   * ID, or `null` when the comment fell back into the summary because its
   * lines aren't part of the diff.
   */
  inlineCommentIds: (string | null)[];
}

/** Short-lived credential for a read-only `git clone`/`fetch`. */
export interface CloneCredential {
  cloneUrl: string;
  username: string;
  token: string;
  expiresAt: Date;
}

/** Webhook request headers, either a Fetch `Headers` or a plain record. */
export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>;

export interface ScmAdapter {
  readonly provider: ScmProvider;
  getChangeRequest(repo: RepoRef, number: number): Promise<ChangeRequest>;
  /** Posts one review: a summary plus inline comments. */
  postReview(repo: RepoRef, number: number, review: ReviewSubmission): Promise<PostedReview>;
  /** Replies in the thread of an inline comment; returns the new comment ID. */
  replyToComment(repo: RepoRef, number: number, commentId: string, body: string): Promise<{ id: string }>;
  /** Resolves the thread containing an inline comment. */
  resolveThread(repo: RepoRef, number: number, commentId: string): Promise<void>;
  getReadOnlyCloneCredential(repo: RepoRef): Promise<CloneCredential>;
  hasWriteAccess(repo: RepoRef, username: string): Promise<boolean>;
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
