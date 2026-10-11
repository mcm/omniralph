import {
  ChangeRequestNotFoundError,
  type ChangeRequestStatus,
  type ChangeRequestUpdate,
  type CiStatus,
  type CreatedChangeRequest,
  type NewChangeRequest,
  type OpenChangeRequest,
  type RepoRef,
  type ScmAdapter,
  type ScmProvider,
} from "@omniralph/scm";

/** A PR/MR held by {@link FakeScmAdapter}. */
export interface FakeChangeRequest {
  number: number;
  url: string;
  fullPath: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;
  draft: boolean;
  state: "open" | "closed" | "merged";
  /** Head commit reported by `getChangeRequestState` (default `"head"`). */
  headSha?: string;
  mergeSha?: string | null;
}

/**
 * An in-memory code host for tests of the ralph orchestrator: the default
 * branch and the PR/MR operations, with every call recorded. A method named in
 * `failures` throws instead. Other `ScmAdapter` methods aren't implemented.
 */
export class FakeScmAdapter {
  readonly changeRequests: FakeChangeRequest[] = [];
  readonly calls: string[] = [];
  readonly failures = new Map<string, string>();
  defaultBranch = "develop";
  /** Usernames `hasWriteAccess` says yes to. */
  readonly members = new Set<string>();
  /** `getCiStatus` answers, keyed by `fullPath#number`; `none` when missing. */
  readonly ciStatuses = new Map<string, CiStatus>();
  /** `getCiJobLog` answers by job ID; `""` when missing. */
  readonly ciJobLogs = new Map<string, string>();

  /** Replies made with `replyToComment`, in order. */
  readonly replies: { fullPath: string; number: number; commentId: string; body: string }[] = [];
  /** `upsertComment` calls, in order (`commentId` as passed in; `id` as returned). */
  readonly upserts: {
    fullPath: string;
    number: number;
    commentId: string | null;
    id: string;
    body: string;
  }[] = [];
  /** Top-level comments by ID, as last written by `upsertComment`. */
  readonly comments = new Map<string, { fullPath: string; number: number; body: string }>();
  private commentCount = 0;

  /** Comment IDs whose threads `resolveThread` resolved, in order. */
  readonly resolvedThreads: string[] = [];

  /** What `verifyWebhook` answers. */
  webhookValid = true;

  constructor(readonly provider: ScmProvider = "github") {}

  async verifyWebhook(): Promise<boolean> {
    return this.webhookValid;
  }

  private call(name: string): void {
    this.calls.push(name);
    const failure = this.failures.get(name);
    if (failure) throw new Error(failure);
  }

  private url(repo: RepoRef, number: number): string {
    return this.provider === "gitlab"
      ? `https://gitlab.example.com/${repo.fullPath}/-/merge_requests/${number}`
      : `https://github.com/${repo.fullPath}/pull/${number}`;
  }

  private find(repo: RepoRef, number: number): FakeChangeRequest {
    const found = this.changeRequests.find(
      (c) => c.fullPath === repo.fullPath && c.number === number,
    );
    if (!found) throw new ChangeRequestNotFoundError(repo, number);
    return found;
  }

  async getDefaultBranch(): Promise<string> {
    this.call("getDefaultBranch");
    return this.defaultBranch;
  }

  async hasWriteAccess(_repo: RepoRef, username: string): Promise<boolean> {
    return this.members.has(username);
  }

  async findOpenChangeRequest(
    repo: RepoRef,
    sourceBranch: string,
  ): Promise<OpenChangeRequest | null> {
    this.call("findOpenChangeRequest");
    const open = this.changeRequests.find(
      (c) => c.fullPath === repo.fullPath && c.sourceBranch === sourceBranch && c.state === "open",
    );
    return open ? { number: open.number, url: open.url, draft: open.draft } : null;
  }

  async createChangeRequest(
    repo: RepoRef,
    request: NewChangeRequest,
  ): Promise<CreatedChangeRequest> {
    this.call("createChangeRequest");
    const open = await this.findOpenChangeRequest(repo, request.sourceBranch);
    if (open) return { number: open.number, url: open.url, created: false };
    const number = this.changeRequests.length + 1;
    this.changeRequests.push({
      number,
      url: this.url(repo, number),
      fullPath: repo.fullPath,
      state: "open",
      ...request,
    });
    return { number, url: this.url(repo, number), created: true };
  }

  async updateChangeRequest(
    repo: RepoRef,
    number: number,
    update: ChangeRequestUpdate,
  ): Promise<void> {
    this.call("updateChangeRequest");
    Object.assign(this.find(repo, number), update);
  }

  async markChangeRequestReady(repo: RepoRef, number: number): Promise<void> {
    this.call("markChangeRequestReady");
    this.find(repo, number).draft = false;
  }

  async getCiStatus(repo: RepoRef, number: number): Promise<CiStatus> {
    this.call("getCiStatus");
    const request = this.find(repo, number);
    return (
      this.ciStatuses.get(`${repo.fullPath}#${number}`) ?? {
        state: "none",
        headSha: request.headSha ?? "head",
        failedJobs: [],
      }
    );
  }

  async getCiJobLog(_repo: RepoRef, jobId: string): Promise<string> {
    this.call("getCiJobLog");
    return this.ciJobLogs.get(jobId) ?? "";
  }

  async getChangeRequestState(repo: RepoRef, number: number): Promise<ChangeRequestStatus> {
    this.call("getChangeRequestState");
    const request = this.find(repo, number);
    return {
      state: request.state,
      headSha: request.headSha ?? "head",
      mergeSha: request.state === "merged" ? (request.mergeSha ?? null) : null,
    };
  }

  async replyToComment(
    repo: RepoRef,
    number: number,
    commentId: string,
    body: string,
  ): Promise<{ id: string }> {
    this.call("replyToComment");
    this.replies.push({ fullPath: repo.fullPath, number, commentId, body });
    return { id: `reply-${this.replies.length}` };
  }

  async upsertComment(
    repo: RepoRef,
    number: number,
    body: string,
    commentId: string | null,
  ): Promise<{ id: string }> {
    this.call("upsertComment");
    let id = commentId;
    if (id === null || !this.comments.has(id)) {
      this.commentCount += 1;
      id = `comment-${this.commentCount}`;
    }
    this.comments.set(id, { fullPath: repo.fullPath, number, body });
    this.upserts.push({ fullPath: repo.fullPath, number, commentId, id, body });
    return { id };
  }

  async resolveThread(_repo: RepoRef, _number: number, commentId: string): Promise<void> {
    this.call("resolveThread");
    this.resolvedThreads.push(commentId);
  }

  /** As the `ScmAdapter` the orchestrator expects. */
  asAdapter(): ScmAdapter {
    return this as unknown as ScmAdapter;
  }
}
