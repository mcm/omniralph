import type { Octokit } from "@octokit/rest";
import { verify } from "@octokit/webhooks-methods";
import { ciLogTail, type ChangeRequestStatus, type CiFailedJob, type CiStatus } from "../ci.js";
import { capLength, capTitle, renderInlineComment, summaryWithFallbacks } from "../comment-body.js";
import { buildDiffLineIndex, isCommentInDiff } from "../diff-lines.js";
import {
  ChangeRequestNotFoundError,
  getHeader,
  type ChangeRequest,
  type ChangeRequestUpdate,
  type CloneCredential,
  type CreatedChangeRequest,
  type NewChangeRequest,
  type OpenChangeRequest,
  type InlineComment,
  type PostedReview,
  type RepoRef,
  type ReviewSubmission,
  type ScmAdapter,
  type WebhookHeaders,
} from "../types.js";
import { GitHubAppAuth, GITHUB_API_URL } from "./app-auth.js";
import type { AppJwtSigner } from "./app-jwt.js";

/** GitHub rejects comment, review and PR bodies longer than this. */
const MAX_BODY_LENGTH = 65_536;
/** GitHub rejects PR titles longer than this. */
const MAX_TITLE_LENGTH = 256;

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

const MARK_READY_MUTATION = /* GraphQL */ `
  mutation ($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
      pullRequest {
        isDraft
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

/** The 422 GitHub returns when an open PR already exists for the head branch. */
function isPullRequestExists(error: unknown): boolean {
  if (!hasStatus(error, 422)) return false;
  const data = (error as { response?: { data?: { message?: unknown; errors?: { message?: unknown }[] } } }).response
    ?.data;
  const messages = [data?.message, ...(data?.errors ?? []).map((e) => e.message)];
  return messages.some((m) => typeof m === "string" && /pull request already exists/i.test(m));
}

/** Workflow run and job conclusions that count as a CI failure. */
const GITHUB_FAILED = new Set(["failure", "timed_out", "startup_failure"]);

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
      state: data.merged ? "merged" : data.state === "closed" ? "closed" : "open",
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

  async postComment(repo: RepoRef, number: number, body: string): Promise<{ id: string }> {
    const { owner, repo: name } = splitRepoPath(repo);
    const octokit = await this.client(repo);
    const { data } = await octokit.issues.createComment({
      owner,
      repo: name,
      issue_number: number,
      body: capLength(body, MAX_BODY_LENGTH),
    });
    return { id: String(data.id) };
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
    return this.cloneCredential(repo, "read");
  }

  /**
   * An installation token limited to `contents: write` on this one
   * repository. GitHub expires installation tokens after (at most) 1 hour.
   */
  async getWriteCloneCredential(repo: RepoRef): Promise<CloneCredential> {
    return this.cloneCredential(repo, "write");
  }

  private async cloneCredential(repo: RepoRef, contents: "read" | "write"): Promise<CloneCredential> {
    const { owner, repo: name } = splitRepoPath(repo);
    const installationId = await this.resolveInstallationId(owner, name);
    const { token, expiresAt } = await this.auth.getInstallationToken(installationId, {
      repositories: [name],
      permissions: { contents },
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

  async getDefaultBranch(repo: RepoRef): Promise<string> {
    const { owner, repo: name } = splitRepoPath(repo);
    const octokit = await this.client(repo);
    const { data } = await octokit.repos.get({ owner, repo: name });
    return data.default_branch;
  }

  async findOpenChangeRequest(repo: RepoRef, sourceBranch: string): Promise<OpenChangeRequest | null> {
    const { owner, repo: name } = splitRepoPath(repo);
    const octokit = await this.client(repo);
    // `head` is `owner:branch`, so PRs from forks with the same branch name don't match.
    const { data } = await octokit.pulls.list({
      owner,
      repo: name,
      state: "open",
      head: `${owner}:${sourceBranch}`,
      per_page: 1,
    });
    const pr = data[0];
    return pr ? { number: pr.number, url: pr.html_url, draft: pr.draft ?? false } : null;
  }

  async createChangeRequest(repo: RepoRef, request: NewChangeRequest): Promise<CreatedChangeRequest> {
    const { owner, repo: name } = splitRepoPath(repo);
    const octokit = await this.client(repo);
    try {
      const { data } = await octokit.pulls.create({
        owner,
        repo: name,
        head: request.sourceBranch,
        base: request.targetBranch,
        title: capTitle(request.title, MAX_TITLE_LENGTH),
        body: capLength(request.body, MAX_BODY_LENGTH),
        draft: request.draft,
      });
      return { number: data.number, url: data.html_url, created: true };
    } catch (error) {
      if (!isPullRequestExists(error)) throw error;
      const existing = await this.findOpenChangeRequest(repo, request.sourceBranch);
      if (!existing) throw error;
      return { number: existing.number, url: existing.url, created: false };
    }
  }

  async updateChangeRequest(repo: RepoRef, number: number, update: ChangeRequestUpdate): Promise<void> {
    const { owner, repo: name } = splitRepoPath(repo);
    const octokit = await this.client(repo);
    try {
      await octokit.pulls.update({
        owner,
        repo: name,
        pull_number: number,
        ...(update.title !== undefined ? { title: capTitle(update.title, MAX_TITLE_LENGTH) } : {}),
        ...(update.body !== undefined ? { body: capLength(update.body, MAX_BODY_LENGTH) } : {}),
      });
    } catch (error) {
      if (hasStatus(error, 404)) throw new ChangeRequestNotFoundError(repo, number, { cause: error });
      throw error;
    }
  }

  /** GraphQL `markPullRequestReadyForReview` (REST can't undraft a PR). */
  async markChangeRequestReady(repo: RepoRef, number: number): Promise<void> {
    const { owner, repo: name } = splitRepoPath(repo);
    const octokit = await this.client(repo);
    let pr: { node_id: string; draft?: boolean };
    try {
      ({ data: pr } = await octokit.pulls.get({ owner, repo: name, pull_number: number }));
    } catch (error) {
      if (hasStatus(error, 404)) throw new ChangeRequestNotFoundError(repo, number, { cause: error });
      throw error;
    }
    if (!pr.draft) return;
    await octokit.graphql(MARK_READY_MUTATION, { pullRequestId: pr.node_id });
  }

  /**
   * GitHub Actions runs of the head commit, the newest per workflow and
   * event (a re-run or a second trigger counts once). Any incomplete run is
   * `pending`; otherwise `failure`, `timed_out` and `startup_failure` runs
   * fail it, listing their failed jobs (or the run itself, as `noLog`, when
   * it has none).
   */
  async getCiStatus(repo: RepoRef, number: number): Promise<CiStatus> {
    const { owner, repo: name } = splitRepoPath(repo);
    const octokit = await this.client(repo);
    const pr = await this.pullRequest(octokit, repo, number);
    const headSha = pr.head.sha;
    const { data } = await octokit.actions.listWorkflowRunsForRepo({
      owner,
      repo: name,
      head_sha: headSha,
      per_page: 100,
    });
    const latest = new Map<string, (typeof data.workflow_runs)[number]>();
    for (const run of data.workflow_runs) {
      const key = `${String(run.workflow_id ?? run.name)}:${run.event}`;
      const seen = latest.get(key);
      if (!seen || run.id > seen.id) latest.set(key, run);
    }
    const runs = [...latest.values()];
    if (runs.length === 0) return { state: "none", headSha, failedJobs: [] };
    if (runs.some((run) => run.status !== "completed"))
      return { state: "pending", headSha, failedJobs: [] };
    const failed = runs.filter((run) => GITHUB_FAILED.has(String(run.conclusion)));
    if (failed.length === 0) return { state: "passed", headSha, failedJobs: [] };
    const failedJobs: CiFailedJob[] = [];
    for (const run of failed) {
      const runName = run.name ?? "workflow";
      const { data: jobs } = await octokit.actions.listJobsForWorkflowRun({
        owner,
        repo: name,
        run_id: run.id,
        filter: "latest",
        per_page: 100,
      });
      const failedRunJobs = jobs.jobs.filter((job) => GITHUB_FAILED.has(String(job.conclusion)));
      if (failedRunJobs.length === 0) {
        failedJobs.push({ id: String(run.id), name: runName, url: run.html_url, noLog: true });
      }
      for (const job of failedRunJobs) {
        failedJobs.push({
          id: String(job.id),
          name: `${runName} / ${job.name}`,
          url: job.html_url,
          noLog: false,
        });
      }
    }
    return { state: "failed", headSha, failedJobs };
  }

  /** The job's log from the jobs log API (a redirect to the plain-text log). */
  async getCiJobLog(repo: RepoRef, jobId: string): Promise<string> {
    const { owner, repo: name } = splitRepoPath(repo);
    const octokit = await this.client(repo);
    const { data } = await octokit.actions.downloadJobLogsForWorkflowRun({
      owner,
      repo: name,
      job_id: Number(jobId),
    });
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
    return ciLogTail(text);
  }

  async getChangeRequestState(repo: RepoRef, number: number): Promise<ChangeRequestStatus> {
    const octokit = await this.client(repo);
    const pr = await this.pullRequest(octokit, repo, number);
    const merged = pr.merged === true || Boolean(pr.merged_at);
    return {
      state: merged ? "merged" : pr.state === "closed" ? "closed" : "open",
      headSha: pr.head.sha,
      mergeSha: merged ? (pr.merge_commit_sha ?? null) : null,
    };
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

  private async pullRequest(octokit: Octokit, repo: RepoRef, number: number) {
    const { owner, repo: name } = splitRepoPath(repo);
    try {
      return (await octokit.pulls.get({ owner, repo: name, pull_number: number })).data;
    } catch (error) {
      if (hasStatus(error, 404))
        throw new ChangeRequestNotFoundError(repo, number, { cause: error });
      throw error;
    }
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
