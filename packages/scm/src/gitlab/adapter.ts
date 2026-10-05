import { createHash, timingSafeEqual } from "node:crypto";
import { AccessLevel, Gitlab } from "@gitbeaker/rest";
import { capLength, fencedBlock, summaryWithFallbacks } from "../comment-body.js";
import { MemoryCredentialCache, type CachedCredential, type CredentialCache } from "../credential-cache.js";
import {
  getHeader,
  type ChangeRequest,
  type CloneCredential,
  type InlineComment,
  type PostedReview,
  type RepoRef,
  type ReviewSubmission,
  type ScmAdapter,
  type WebhookHeaders,
} from "../types.js";
import {
  buildGitLabDiffIndex,
  buildPosition,
  type DiffRefs,
  type GitLabDiffFile,
  type TextPosition,
} from "./positions.js";

export const GITLAB_URL = "https://gitlab.com";

/** GitLab rejects note bodies longer than this. */
const MAX_NOTE_LENGTH = 1_000_000;
/** Scope of the cached clone token (also its `scm_credential_cache.scope`). */
export const READ_REPOSITORY_SCOPE = "read_repository";
/** Cached clone tokens are rotated once they're this close to expiry. */
export const CLONE_TOKEN_ROTATE_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type GitlabClient = Gitlab<false>;

export interface GitLabAdapterOptions {
  /** Group or project access token of the bot identity (`api` scope). */
  token: string;
  /** Secret configured on the project/group webhook (`X-Gitlab-Token`). */
  webhookSecret: string;
  /** Instance URL, e.g. `https://gitlab.example.com`. Defaults to gitlab.com. */
  baseUrl?: string;
  /** Where minted clone tokens are kept; defaults to an in-memory cache. */
  credentialCache?: CredentialCache;
  now?: () => number;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const cause = (error as { cause?: { response?: { status?: unknown } } }).cause;
  const status = cause?.response?.status;
  return typeof status === "number" ? status : undefined;
}

/** GitLab project ID (preferred) or URL path. */
function projectId(repo: RepoRef): string | number {
  if (repo.externalId && /^\d+$/.test(repo.externalId)) return Number(repo.externalId);
  return repo.externalId ?? repo.fullPath;
}

/** Date (UTC, `YYYY-MM-DD`) of a timestamp. */
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Discussion IDs are 40-character hex strings; note IDs are numeric. */
const DISCUSSION_ID = /^[0-9a-f]{40}$/i;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Inline comment body for GitLab: the suggestion becomes a
 * `suggestion:-N+0` block covering the commented range (head side only;
 * GitLab can't apply suggestions to removed lines).
 */
export function renderGitLabComment(comment: InlineComment): string {
  if (comment.suggestion === undefined) return comment.body;
  if (comment.side === "old") return `${comment.body}\n\n${fencedBlock("", comment.suggestion)}`;
  const above =
    comment.startLine !== undefined && comment.startLine < comment.line ? comment.line - comment.startLine : 0;
  return `${comment.body}\n\n${fencedBlock(`suggestion:-${above}+0`, comment.suggestion)}`;
}

/**
 * {@link ScmAdapter} for GitLab (gitlab.com or self-managed), acting as a
 * group/project access token's bot user.
 */
export class GitLabAdapter implements ScmAdapter {
  readonly provider = "gitlab" as const;
  readonly baseUrl: string;
  readonly api: GitlabClient;
  private readonly webhookSecret: string;
  private readonly credentialCache: CredentialCache;
  private readonly now: () => number;
  private readonly pendingTokens = new Map<string, Promise<CachedCredential>>();

  constructor(options: GitLabAdapterOptions) {
    this.baseUrl = (options.baseUrl ?? GITLAB_URL).replace(/\/+$/, "").replace(/\/api\/v4$/, "");
    this.api = new Gitlab<false>({ host: this.baseUrl, token: options.token });
    this.webhookSecret = options.webhookSecret;
    this.credentialCache = options.credentialCache ?? new MemoryCredentialCache();
    this.now = options.now ?? Date.now;
  }

  async getChangeRequest(repo: RepoRef, number: number): Promise<ChangeRequest> {
    const mr = await this.api.MergeRequests.show(projectId(repo), number);
    const refs = mr.diff_refs as Partial<{ base_sha: string; start_sha: string; head_sha: string }> | null;
    if (!refs?.base_sha || !refs.head_sha) {
      throw new Error(`Merge request ${repo.fullPath}!${number} has no diff yet (diff_refs is empty)`);
    }
    return {
      number: mr.iid,
      title: mr.title,
      description: mr.description ?? "",
      author: mr.author.username,
      draft: Boolean(mr.draft ?? mr.work_in_progress),
      state: mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "open",
      baseSha: refs.base_sha,
      startSha: refs.start_sha,
      headSha: refs.head_sha,
      baseRef: mr.target_branch,
      headRef: mr.source_branch,
      url: mr.web_url,
    };
  }

  /**
   * Creates one discussion per inline comment, then one note with the
   * summary. Comments whose lines aren't in the diff (at `commitSha`), or
   * whose position GitLab rejects, are appended to the summary instead.
   */
  async postReview(repo: RepoRef, number: number, review: ReviewSubmission): Promise<PostedReview> {
    const project = projectId(repo);
    const target = await this.diffAt(repo, number, review.commitSha);
    const index = buildGitLabDiffIndex(target?.files ?? []);

    const inlineCommentIds: (string | null)[] = review.inlineComments.map(() => null);
    const fallbacks: InlineComment[] = [];
    for (const [i, comment] of review.inlineComments.entries()) {
      const position = target ? buildPosition(index, target.refs, comment) : null;
      if (!position) {
        fallbacks.push(comment);
        continue;
      }
      try {
        const discussion = await this.createDiffDiscussion(
          project,
          number,
          capLength(renderGitLabComment(comment), MAX_NOTE_LENGTH),
          position,
        );
        inlineCommentIds[i] = String(discussion.id);
      } catch (error) {
        const status = statusOf(error);
        if (status !== 400 && status !== 422) throw error;
        fallbacks.push(comment);
      }
    }

    const body = capLength(summaryWithFallbacks(review.summary, fallbacks), MAX_NOTE_LENGTH);
    const note = await this.api.MergeRequestNotes.create(project, number, body);
    return { reviewId: String(note.id), summaryCommentId: String(note.id), inlineCommentIds };
  }

  /** Adds a top-level note to the MR. */
  async postComment(repo: RepoRef, number: number, body: string): Promise<{ id: string }> {
    const note = await this.api.MergeRequestNotes.create(projectId(repo), number, capLength(body, MAX_NOTE_LENGTH));
    return { id: String(note.id) };
  }

  /** Adds a note to the discussion (`commentId` = discussion ID or note ID). */
  async replyToComment(
    repo: RepoRef,
    number: number,
    commentId: string,
    body: string,
  ): Promise<{ id: string }> {
    const discussionId = await this.discussionIdFor(repo, number, commentId);
    const note = await this.api.MergeRequestDiscussions.addNote(
      projectId(repo),
      number,
      discussionId,
      capLength(body, MAX_NOTE_LENGTH),
    );
    return { id: String(note.id) };
  }

  /** Resolves the discussion (`commentId` = discussion ID or note ID). */
  async resolveThread(repo: RepoRef, number: number, commentId: string): Promise<void> {
    const discussionId = await this.discussionIdFor(repo, number, commentId);
    await this.api.MergeRequestDiscussions.resolve(projectId(repo), number, discussionId, true);
  }

  /**
   * A `read_repository` project access token (Reporter role) expiring the
   * next day (UTC). It's cached via the {@link CredentialCache} and reused
   * until it's within 2 hours of expiry; then a new token is created. The
   * previous token isn't revoked so clones still using it can finish; it
   * expires on its own within those 2 hours.
   */
  async getReadOnlyCloneCredential(repo: RepoRef): Promise<CloneCredential> {
    const credential = await this.readRepositoryToken(repo);
    return {
      cloneUrl: `${this.baseUrl}/${repo.fullPath}.git`,
      // Any non-empty username works with an access token.
      username: "oauth2",
      token: credential.token,
      expiresAt: credential.expiresAt,
    };
  }

  /** Whether `username` has at least Developer access (incl. inherited membership). */
  async hasWriteAccess(repo: RepoRef, username: string): Promise<boolean> {
    const users = await this.api.Users.all({ username });
    const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return false;
    try {
      const member = await this.api.ProjectMembers.show(projectId(repo), user.id, { includeInherited: true });
      return member.access_level >= AccessLevel.DEVELOPER;
    } catch (error) {
      if (statusOf(error) === 404) return false;
      throw error;
    }
  }

  /** Compares `X-Gitlab-Token` with the webhook secret in constant time. */
  async verifyWebhook(headers: WebhookHeaders, _rawBody: string | Uint8Array): Promise<boolean> {
    const token = getHeader(headers, "x-gitlab-token");
    if (!token || !this.webhookSecret) return false;
    // Hash both sides so the comparison doesn't leak the secret's length.
    return timingSafeEqual(sha256(token), sha256(this.webhookSecret));
  }

  private async readRepositoryToken(repo: RepoRef): Promise<CachedCredential> {
    const cached = await this.credentialCache.get(repo, READ_REPOSITORY_SCOPE);
    if (cached && cached.expiresAt.getTime() - this.now() > CLONE_TOKEN_ROTATE_MS) return cached;

    const key = String(projectId(repo));
    const pending = this.pendingTokens.get(key);
    if (pending) return pending;
    const created = this.createReadRepositoryToken(repo).finally(() => this.pendingTokens.delete(key));
    this.pendingTokens.set(key, created);
    return created;
  }

  private async createReadRepositoryToken(repo: RepoRef): Promise<CachedCredential> {
    const now = this.now();
    // Tokens expire at 00:00 UTC on `expires_at`. Use tomorrow, or the day
    // after when tomorrow would already be inside the rotation window.
    let expiresOn = utcDate(now + DAY_MS);
    if (Date.parse(`${expiresOn}T00:00:00Z`) - now <= CLONE_TOKEN_ROTATE_MS) {
      expiresOn = utcDate(now + 2 * DAY_MS);
    }
    const created = await this.api.ProjectAccessTokens.create(
      projectId(repo),
      "omniralph-read-repository",
      [READ_REPOSITORY_SCOPE],
      expiresOn,
      { accessLevel: AccessLevel.REPORTER },
    );
    const credential: CachedCredential = {
      token: created.token,
      expiresAt: new Date(`${created.expires_at || expiresOn}T00:00:00Z`),
      externalId: String(created.id),
    };
    await this.credentialCache.set(repo, READ_REPOSITORY_SCOPE, credential);
    return credential;
  }

  /**
   * Diff refs and files at `commitSha`: the MR's current diff, or the diff
   * version whose head is `commitSha`. `null` when no version matches (the
   * commit was force-pushed away), so every comment falls back.
   */
  private async diffAt(
    repo: RepoRef,
    number: number,
    commitSha: string | undefined,
  ): Promise<{ refs: DiffRefs; files: GitLabDiffFile[] } | null> {
    const project = projectId(repo);
    const mr = await this.getChangeRequest(repo, number);
    if (commitSha === undefined || commitSha === mr.headSha) {
      const files = await this.api.MergeRequests.allDiffs(project, number, { perPage: 100 });
      return {
        refs: { baseSha: mr.baseSha, startSha: mr.startSha ?? mr.baseSha, headSha: mr.headSha },
        files,
      };
    }
    const versions = await this.api.MergeRequests.allDiffVersions(project, number);
    const match = versions.find((v) => v.head_commit_sha === commitSha);
    if (!match) return null;
    const version = await this.api.MergeRequests.showDiffVersion(project, number, match.id);
    return {
      refs: {
        baseSha: version.base_commit_sha,
        startSha: version.start_commit_sha,
        headSha: version.head_commit_sha,
      },
      files: version.diffs as unknown as GitLabDiffFile[],
    };
  }

  /**
   * `POST …/discussions` with a JSON body. gitbeaker's `create` form-encodes
   * positions, and multipart encoding turns `\n` into `\r\n`, which would
   * end up inside applied suggestions.
   */
  private async createDiffDiscussion(
    project: string | number,
    number: number,
    body: string,
    position: TextPosition,
  ): Promise<{ id: string }> {
    const discussions = this.api.MergeRequestDiscussions;
    const response = await discussions.requester.post(
      `${encodeURIComponent(String(project))}/merge_requests/${number}/discussions`,
      { body: { body, position } },
    );
    return response.body as { id: string };
  }

  private async discussionIdFor(repo: RepoRef, number: number, commentId: string): Promise<string> {
    if (DISCUSSION_ID.test(commentId)) return commentId;
    const noteId = Number(commentId);
    const discussions = await this.api.MergeRequestDiscussions.all(projectId(repo), number, { perPage: 100 });
    const discussion = discussions.find((d) => d.notes?.some((n) => n.id === noteId));
    if (!discussion) {
      throw new Error(`No discussion contains note ${commentId} on ${repo.fullPath}!${number}`);
    }
    return String(discussion.id);
  }
}
