import type { Octokit } from "@octokit/rest";
import { verify } from "@octokit/webhooks-methods";
import { capLength, renderInlineComment, summaryWithFallbacks } from "../comment-body.js";
import { buildDiffLineIndex, isCommentInDiff } from "../diff-lines.js";
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
import { GitHubAppAuth, GITHUB_API_URL } from "./app-auth.js";
import type { AppJwtSigner } from "./app-jwt.js";

/** GitHub rejects comment and review bodies longer than this. */
const MAX_BODY_LENGTH = 65_536;

export interface GitHubAdapterOptions {
  appId: string;
  signer: AppJwtSigner;
  /** Secret configured on the GitHub App's webhook. */
  webhookSecret: string;
  /**
   * Installation to act as. When omitted it's looked up per repository with
   * `GET /repos/{owner}/{repo}/installation`.
   */
  installationId?: number;
  /** REST API base URL; `https://<host>/api/v3` for GitHub Enterprise Server. */
  baseUrl?: string;
  /** Web/git base URL; derived from `baseUrl` when omitted. */
  webUrl?: string;
  now?: () => number;
}

interface ReviewThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          isResolved: boolean;
          comments: { nodes: { databaseId: number | null }[] };
        }[];
      };
    } | null;
  } | null;
}

const REVIEW_THREADS_QUERY = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes {
                databaseId
              }
            }
          }
        }
      }
    }
  }
`;

const RESOLVE_THREAD_MUTATION = /* GraphQL */ `
  mutation ($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
      }
    }
  }
`;

export function splitRepoPath(repo: RepoRef): { owner: string; repo: string } {
  const [owner, name, ...rest] = repo.fullPath.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new Error(`Invalid GitHub repository "${repo.fullPath}"; expected owner/repo`);
  }
  return { owner, repo: name };
}

function deriveWebUrl(apiUrl: string): string {
  if (apiUrl === GITHUB_API_URL) return "https://github.com";
  return apiUrl.replace(/\/api\/v3$/, "");
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === status;
}

function commentKey(path: string, side: string, line: number | null | undefined): string {
  return JSON.stringify([path, side, line ?? null]);
}

/** {@link ScmAdapter} for GitHub, authenticating as a GitHub App. */
export class GitHubAdapter implements ScmAdapter {
  readonly provider = "github" as const;
  readonly auth: GitHubAppAuth;
  private readonly webhookSecret: string;
  private readonly installationId: number | undefined;
  private readonly webUrl: string;

  constructor(options: GitHubAdapterOptions) {
    this.auth = new GitHubAppAuth({
      appId: options.appId,
      signer: options.signer,
      baseUrl: options.baseUrl,
      now: options.now,
    });
    this.webhookSecret = options.webhookSecret;
    this.installationId = options.installationId;
    this.webUrl = (options.webUrl ?? deriveWebUrl(this.auth.baseUrl)).replace(/\/+$/, "");
  }

  async getChangeRequest(repo: RepoRef, number: number): Promise<ChangeRequest> {
    const { owner, repo: name } = splitRepoPath(repo);
    const octokit = await this.client(repo);
    const { data } = await octokit.pulls.get({ owner, repo: name, pull_number: number });
    return {
      number: data.number,
      title: data.title,
      description: data.body ?? "",
      author: data.user.login,
      draft: data.draft ?? false,
      baseSha: data.base.sha,
      headSha: data.head.sha,
      baseRef: data.base.ref,
      headRef: data.head.ref,
      url: data.html_url,
    };
  }

  /**
   * Submits one `COMMENT` review. Inline comments whose lines aren't in the
   * diff (at `commitSha`) are appended to the review body instead.
   */
  async postReview(repo: RepoRef, number: number, review: ReviewSubmission): Promise<PostedReview> {
    const { owner, repo: name } = splitRepoPath(repo);
    const octokit = await this.client(repo);

    const { data: pr } = await octokit.pulls.get({ owner, repo: name, pull_number: number });
    const commitSha = review.commitSha ?? pr.head.sha;
    const files = await this.diffFiles(octokit, owner, name, number, pr.base.sha, pr.head.sha, commitSha);
    const index = buildDiffLineIndex(files);

    const inline: { comment: InlineComment; inputIndex: number }[] = [];
    const fallbacks: InlineComment[] = [];
    review.inlineComments.forEach((comment, inputIndex) => {
      if (isCommentInDiff(index, comment)) inline.push({ comment, inputIndex });
      else fallbacks.push(comment);
    });

    const body = capLength(summaryWithFallbacks(review.summary, fallbacks), MAX_BODY_LENGTH);
    const { data: created } = await octokit.pulls.createReview({
      owner,
      repo: name,
      pull_number: number,
      commit_id: commitSha,
      event: "COMMENT",
      body,
      comments: inline.map(({ comment }) => {
        const side = comment.side === "old" ? "LEFT" : "RIGHT";
        const multiLine = comment.startLine !== undefined && comment.startLine !== comment.line;
        return {
          path: comment.path,
          line: comment.line,
          side,
          ...(multiLine ? { start_line: comment.startLine, start_side: side } : {}),
          body: capLength(renderInlineComment(comment), MAX_BODY_LENGTH),
        };
      }),
    });

    const inlineCommentIds: (string | null)[] = review.inlineComments.map(() => null);
    if (inline.length > 0) {
      const posted = await octokit.paginate(octokit.pulls.listCommentsForReview, {
        owner,
        repo: name,
        pull_number: number,
        review_id: created.id,
        per_page: 100,
      });
      // Match posted comments back to inputs by anchor, in creation order.
      const byKey = new Map<string, number[]>();
      for (const comment of [...posted].sort((a, b) => a.id - b.id)) {
        const key = commentKey(comment.path, comment.side ?? "RIGHT", comment.line ?? comment.original_line);
        byKey.set(key, [...(byKey.get(key) ?? []), comment.id]);
      }
      for (const { comment, inputIndex } of inline) {
        const key = commentKey(comment.path, comment.side === "old" ? "LEFT" : "RIGHT", comment.line);
        const id = byKey.get(key)?.shift();
        inlineCommentIds[inputIndex] = id === undefined ? null : String(id);
      }
    }

    return {
      reviewId: String(created.id),
      summaryCommentId: String(created.id),
      inlineCommentIds,
    };
  }

  async replyToComment(
    repo: RepoRef,
    number: number,
    commentId: string,
    body: string,
  ): Promise<{ id: string }> {
    const { owner, repo: name } = splitRepoPath(repo);
    const octokit = await this.client(repo);
    const { data } = await octokit.pulls.createReplyForReviewComment({
      owner,
      repo: name,
      pull_number: number,
      comment_id: Number(commentId),
      body: capLength(body, MAX_BODY_LENGTH),
    });
    return { id: String(data.id) };
  }

  /** Resolves the review thread containing `commentId` (GraphQL; REST can't). */
  async resolveThread(repo: RepoRef, number: number, commentId: string): Promise<void> {
    const { owner, repo: name } = splitRepoPath(repo);
    const octokit = await this.client(repo);
    const wanted = Number(commentId);
    let cursor: string | null = null;
    for (;;) {
      const page: ReviewThreadsPage = await octokit.graphql<ReviewThreadsPage>(REVIEW_THREADS_QUERY, {
        owner,
        repo: name,
        number,
        cursor,
      });
      const threads = page.repository?.pullRequest?.reviewThreads;
      if (!threads) throw new Error(`Pull request ${repo.fullPath}#${number} not found`);
      const thread = threads.nodes.find((t) => t.comments.nodes.some((c) => c.databaseId === wanted));
      if (thread) {
        if (!thread.isResolved) await octokit.graphql(RESOLVE_THREAD_MUTATION, { threadId: thread.id });
        return;
      }
      if (!threads.pageInfo.hasNextPage) break;
      cursor = threads.pageInfo.endCursor;
    }
    throw new Error(`No review thread contains comment ${commentId} on ${repo.fullPath}#${number}`);
  }

  /** An installation token limited to `contents: read` on this one repository. */
  async getReadOnlyCloneCredential(repo: RepoRef): Promise<CloneCredential> {
    const { owner, repo: name } = splitRepoPath(repo);
    const installationId = await this.resolveInstallationId(owner, name);
    const { token, expiresAt } = await this.auth.getInstallationToken(installationId, {
      repositories: [name],
      permissions: { contents: "read" },
    });
    return {
      cloneUrl: `${this.webUrl}/${owner}/${name}.git`,
      username: "x-access-token",
      token,
      expiresAt,
    };
  }

  async hasWriteAccess(repo: RepoRef, username: string): Promise<boolean> {
    const { owner, repo: name } = splitRepoPath(repo);
    const octokit = await this.client(repo);
    try {
      const { data } = await octokit.repos.getCollaboratorPermissionLevel({ owner, repo: name, username });
      return (
        data.permission === "admin" ||
        data.permission === "write" ||
        ["admin", "maintain", "write"].includes(data.role_name)
      );
    } catch (error) {
      if (hasStatus(error, 404)) return false;
      throw error;
    }
  }

  /** Verifies `X-Hub-Signature-256` (HMAC-SHA256 of the raw body). */
  async verifyWebhook(headers: WebhookHeaders, rawBody: string | Uint8Array): Promise<boolean> {
    const signature = getHeader(headers, "x-hub-signature-256");
    if (!signature || !this.webhookSecret) return false;
    const payload = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
    try {
      return await verify(this.webhookSecret, payload, signature);
    } catch {
      return false;
    }
  }

  private async resolveInstallationId(owner: string, repo: string): Promise<number> {
    return this.installationId ?? this.auth.getRepoInstallationId(owner, repo);
  }

  /** Octokit authenticated with the installation's (unscoped) token. */
  private async client(repo: RepoRef): Promise<Octokit> {
    const { owner, repo: name } = splitRepoPath(repo);
    const installationId = await this.resolveInstallationId(owner, name);
    const { token } = await this.auth.getInstallationToken(installationId);
    return this.auth.octokit(token);
  }

  /** Changed files with patches, at the PR head or an older reviewed commit. */
  private async diffFiles(
    octokit: Octokit,
    owner: string,
    repo: string,
    number: number,
    baseSha: string,
    headSha: string,
    commitSha: string,
  ): Promise<{ path: string; patch?: string | null }[]> {
    if (commitSha === headSha) {
      const files = await octokit.paginate(octokit.pulls.listFiles, {
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      });
      return files.map((f) => ({ path: f.filename, patch: f.patch }));
    }
    const { data } = await octokit.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseSha}...${commitSha}`,
    });
    return (data.files ?? []).map((f) => ({ path: f.filename, patch: f.patch }));
  }
}
