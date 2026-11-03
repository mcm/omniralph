import { randomBytes } from "node:crypto";
import {
  agents,
  claimJob,
  closeDb,
  completeJob,
  connectRepository,
  createDb,
  createReview,
  createReviewRun,
  documentationRequests,
  findLaneByPullRequest,
  getJob,
  getMainLane,
  getRun,
  jobs,
  listDocumentationRequests,
  organizations,
  ralphRuns,
  repositories,
  reviewRuns,
  reviews,
  stickyComments,
  upsertScmConnection,
  type Database,
  type Job,
} from "@omniralph/db";
import {
  createTestDatabase,
  setCodingEnabled,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import {
  MAX_JOB_DELIVERIES,
  RalphRequestPayload,
  TRACKER_PROTOCOL_MIN_AGENT_VERSION,
  type RalphRequestResult,
} from "@omniralph/shared";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import type * as Adapters from "@/lib/scm/adapters";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { onDocumentationCheckForRalph, onRalphJobFinished, onRalphJobStarted } from "./jobs";
import { ralphJobPayload } from "./coding";
import { respondToDocumentationCheck } from "./pull-request-requests";
import type { RalphDeps } from "./run";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ scm: undefined as unknown as FakeScmAdapter }));
// The documentation comment is written through the repo's adapter.
vi.mock("@/lib/scm/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  scmAdapterFor: () => state.scm.asAdapter(),
}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
process.env.APP_URL ??= "https://omniralph.example.com";

const databaseAvailable = testDatabaseAvailable();

const sha = (n: number) => n.toString(16).padStart(40, "0");
const HEAD = sha(1);
const MOVED = sha(99);
const BRANCH = "feature/docs";

const README = {
  path: "README.md",
  reason: "Shows the old `--fast` flag.",
  suggestion: "Run `tool --quick`.",
};
const SETUP = { path: "docs/setup.md", reason: "Describes the removed `cache` setting." };

describe.skipIf(!databaseAvailable)("documentation updates on people's pull requests", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  const repoIds = { github: "", gitlab: "" };
  let agentId: string;
  let dispatcher: PostgresDispatcher;
  let scm: FakeScmAdapter;

  const deps = (): RalphDeps => ({
    db,
    organizationId: orgId,
    tracker: new FakeLinearGateway(),
    dispatcher,
    adapterFor: () => scm.asAdapter(),
  });

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    for (const provider of ["github", "gitlab"] as const) {
      const connection = (await upsertScmConnection(
        db,
        {
          organizationId: orgId,
          provider,
          name: `acme-${provider}`,
          baseUrl: provider === "github" ? "https://api.github.com" : "https://gitlab.example.com",
          externalId: provider,
          credentials: {},
        },
        randomBytes(32),
      ))!;
      repoIds[provider] = (
        await connectRepository(db, {
          connectionId: connection.id,
          provider,
          externalId: "1",
          fullPath: "acme/api",
        })
      ).id;
    }
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
    await db.delete(reviews);
    await db.delete(documentationRequests);
    await db.delete(stickyComments);
    await db.delete(agents);
    [{ id: agentId }] = (await db
      .insert(agents)
      .values({
        organizationId: orgId,
        name: "agent-a",
        reportedAcceptedTaskTypes: ["query", "review", "coding"],
      })
      .returning({ id: agents.id })) as [{ id: string }];
    for (const id of Object.values(repoIds)) {
      await setCodingEnabled(db, id);
      await db
        .update(repositories)
        .set({
          requestPlaybookId: "builtin:handle-request",
          documentationCheck: "update",
          documentationUpdateTargets: "same-repo",
        })
        .where(eq(repositories.id, id));
    }
    dispatcher = new PostgresDispatcher({ db });
  });

  /** A person's open PR/MR #5 of `acme/api` from `feature/docs` (in the repo unless `fork`) at `HEAD`. */
  function personsPullRequest(provider: "github" | "gitlab", options: { fork?: boolean } = {}) {
    scm = new FakeScmAdapter(provider);
    state.scm = scm;
    const url =
      provider === "gitlab"
        ? "https://gitlab.example.com/acme/api/-/merge_requests/5"
        : "https://github.com/acme/api/pull/5";
    scm.changeRequests.push({
      number: 5,
      url,
      fullPath: "acme/api",
      sourceBranch: BRANCH,
      targetBranch: "main",
      title: "Rename the fast flag",
      body: "",
      draft: false,
      state: "open",
      headSha: HEAD,
      sameRepository: !options.fork,
    });
    return { url, repoId: repoIds[provider] };
  }

  /** PR/MR #5 (and its branch) moved to `headSha`. */
  const pushTo = (headSha: string) => {
    scm.changeRequests[0]!.headSha = headSha;
  };

  /** A documentation check of #5 at `headSha` that ended with `updates` confirmed. */
  async function docsCheck(
    repoId: string,
    options: { headSha?: string; updates?: { path: string; reason: string }[] } = {},
  ): Promise<string> {
    const target = {
      repositoryId: repoId,
      prNumber: 5,
      headSha: options.headSha ?? HEAD,
      baseSha: sha(9),
      trigger: "webhook" as const,
      depth: "standard" as const,
    };
    const reviewRun = await createReviewRun(db, { ...target, organizationId: orgId, mode: "full" });
    await db.update(reviewRuns).set({ status: "completed" }).where(eq(reviewRuns.id, reviewRun.id));
    const created = await createReview(db, {
      ...target,
      reviewRunId: reviewRun.id,
      taskId: "builtin:check-docs",
      model: null,
      budget: 200_000,
    });
    await db
      .update(reviews)
      .set({ status: "completed", documentationUpdates: options.updates ?? [README, SETUP] })
      .where(eq(reviews.id, created.id));
    return created.id;
  }

  const runJobs = (runId: string, statuses?: Job["status"][]) =>
    db
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.ralphRunId, runId), statuses ? inArray(jobs.status, statuses) : undefined),
      );

  async function start(runId: string): Promise<Job> {
    const [job, ...more] = await runJobs(runId, ["queued", "running"]);
    expect(job, "the run has a queued job").toBeDefined();
    expect(more).toEqual([]);
    const started = await claimJob(db, {
      organizationId: orgId,
      agentId,
      acceptedTaskTypes: ["query", "coding"],
      pools: ["short", "long"],
      agentVersion: TRACKER_PROTOCOL_MIN_AGENT_VERSION,
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(started.claim?.job.id).toBe(job!.id);
    expect(await onRalphJobStarted(db, job!, agentId)).toEqual({ skip: false });
    return job!;
  }

  async function finish(job: Job, result: RalphRequestResult): Promise<void> {
    expect(await completeJob(db, { jobId: job.id, agentId, result: { ...result } })).toEqual({
      status: "completed",
    });
    await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
  }

  const requestResult = (overrides: Partial<RalphRequestResult> = {}): RalphRequestResult => ({
    summary: "Updated the docs.",
    error: null,
    sessionId: "claude-req-1",
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 10,
    ...overrides,
  });

  const runOf = async (response: unknown) =>
    (await getRun(db, (response as { runId: string }).runId))!;

  const lastComment = () => scm.upserts.at(-1)?.body ?? "";

  describe.each(["github", "gitlab"] as const)("on %s", (provider) => {
    it("starts a pull-request run on the PR/MR's head branch whose first request is the docs request", async () => {
      const { url, repoId } = personsPullRequest(provider);
      const reviewId = await docsCheck(repoId);

      const response = await onDocumentationCheckForRalph(db, reviewId, deps());
      expect(response).toMatchObject({
        status: "handed_off",
        paths: ["README.md", "docs/setup.md"],
        delivery: "started",
      });
      const run = await runOf(response);
      expect(run).toMatchObject({
        origin: "pull-request",
        mode: "request",
        kind: "single",
        repositoryId: repoId,
        status: "running",
      });
      // Bound to the PR/MR's own branch, linked by URL only: never taken for one of Om's PRs/MRs.
      expect(await getMainLane(db, run)).toMatchObject({
        branch: BRANCH,
        baseBranch: "main",
        prUrl: url,
        prNumber: null,
      });
      expect(await findLaneByPullRequest(db, repoId, 5)).toBeNull();
      expect(await listDocumentationRequests(db, repoId, 5)).toMatchObject([
        { headSha: HEAD, reviewId, ralphRunId: run.id, paths: ["README.md", "docs/setup.md"] },
      ]);

      const [job, ...more] = await runJobs(run.id);
      expect(more).toEqual([]);
      expect(job!.type).toBe("ralph.request");
      const payload = RalphRequestPayload.parse(ralphJobPayload(job!));
      expect(payload).toMatchObject({
        branch: BRANCH,
        baseBranch: "main",
        prUrl: url,
        expectedHeadSha: HEAD,
        historyRewrite: "never",
        ship: false,
      });
      expect(payload.hiddenRef).toBeUndefined();
      const [request, ...others] = payload.requests;
      expect(others).toEqual([]);
      const term = provider === "gitlab" ? "merge request !5" : "pull request #5";
      expect(request!.text).toContain(
        `Omniralph's documentation check found 2 documentation files that ${term} (${url}) makes wrong or incomplete.`,
      );
      expect(request!.text).toContain("1. `README.md`: Shows the old `--fast` flag.");
      expect(request!.text).toContain("call the `ship` tool once");
      expect(request!.text).toContain("Never force-push, rewrite its history, open a");

      // The session ships one commit: the run completes, and nothing touches the PR/MR.
      await finish(
        await start(run.id),
        requestResult({
          commitSha: sha(2),
          pushed: true,
          pullRequest: { action: "update", title: "Changed by Om" },
        }),
      );
      expect((await getRun(db, run.id))?.status).toBe("completed");
      expect(scm.calls).not.toContain("updateChangeRequest");
      expect(scm.calls).not.toContain("createChangeRequest");
      expect(scm.changeRequests[0]!.title).toBe("Rename the fast flag");
    });

    it("fails without a job when the branch moved before the run could start, and the comment says so", async () => {
      const { repoId } = personsPullRequest(provider);
      scm.branchHeads.set(`acme/api:${BRANCH}`, MOVED);
      const response = await respondToDocumentationCheck(deps(), await docsCheck(repoId));
      // What the check's own comment then says.
      expect(response).toEqual({
        status: "not_applied",
        paths: ["README.md", "docs/setup.md"],
        reason: `the branch \`${BRANCH}\` moved since the checked commit \`${HEAD.slice(0, 12)}\``,
      });

      const [run] = await db.select().from(ralphRuns);
      expect(run).toBeDefined();
      expect(run!.origin).toBe("pull-request");
      expect(run!.status).toBe("failed");
      expect(run!.error).toContain(
        `The documentation updates weren't applied: the branch \`${BRANCH}\` moved since the checked commit \`${HEAD.slice(0, 12)}\``,
      );
      expect(await runJobs(run!.id)).toEqual([]);
      expect(lastComment()).toContain("`README.md`");
      expect(lastComment()).toContain(
        `Om couldn't commit these updates to this change, so they weren't applied: the branch \`${BRANCH}\` moved since the checked commit \`${HEAD.slice(0, 12)}\`.`,
      );
    });

    it("fails without retry when the branch moved while the run worked, and the comment says so", async () => {
      const { repoId } = personsPullRequest(provider);
      const run = await runOf(await respondToDocumentationCheck(deps(), await docsCheck(repoId)));
      const job = await start(run.id);
      // Someone pushed meanwhile: the agent refused to ship on top of it.
      pushTo(MOVED);
      await finish(
        job,
        requestResult({
          summary: "",
          error: "the branch moved since the checked commit, so nothing was committed or pushed",
          pushed: false,
        }),
      );

      const failed = (await getRun(db, run.id))!;
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain(`the branch \`${BRANCH}\` moved since the checked commit`);
      expect(await runJobs(run.id, ["queued", "running"])).toEqual([]);
      expect(lastComment()).toContain("so they weren't applied: the branch");
    });
  });

  it("gives fork PRs, Om-only update targets and repos with Coding off the comment only", async () => {
    let { repoId } = personsPullRequest("github", { fork: true });
    expect(await respondToDocumentationCheck(deps(), await docsCheck(repoId))).toEqual({
      status: "ignored",
      reason: "fork",
    });

    ({ repoId } = personsPullRequest("gitlab", { fork: true }));
    expect(await respondToDocumentationCheck(deps(), await docsCheck(repoId))).toEqual({
      status: "ignored",
      reason: "fork",
    });

    ({ repoId } = personsPullRequest("github"));
    await db
      .update(repositories)
      .set({ documentationUpdateTargets: "omniralph" })
      .where(eq(repositories.id, repoId));
    expect(await respondToDocumentationCheck(deps(), await docsCheck(repoId))).toEqual({
      status: "ignored",
      reason: "targets",
    });

    ({ repoId } = personsPullRequest("gitlab"));
    await setCodingEnabled(db, repoId, false);
    expect(await respondToDocumentationCheck(deps(), await docsCheck(repoId))).toEqual({
      status: "ignored",
      reason: "repository_unavailable",
    });

    expect(await db.select().from(ralphRuns)).toEqual([]);
    expect(await db.select().from(documentationRequests)).toEqual([]);
  });

  it("asks once per head and at most three times per PR/MR", async () => {
    const { repoId } = personsPullRequest("github");
    const first = await respondToDocumentationCheck(deps(), await docsCheck(repoId));
    const run = await runOf(first);
    // Another check of the same head doesn't start another run.
    expect(
      await respondToDocumentationCheck(deps(), await docsCheck(repoId, { updates: [SETUP] })),
    ).toEqual({
      status: "handed_off",
      paths: ["README.md", "docs/setup.md"],
      delivery: "earlier",
      runId: run.id,
    });
    await finish(await start(run.id), requestResult({ commitSha: sha(2), pushed: true }));

    for (const n of [2, 3]) {
      pushTo(sha(n));
      const response = await respondToDocumentationCheck(
        deps(),
        await docsCheck(repoId, {
          headSha: sha(n),
          updates: [{ path: `doc-${n}.md`, reason: "Out of date." }],
        }),
      );
      expect(response).toMatchObject({ status: "handed_off", delivery: "started" });
      await finish(
        await start((await runOf(response)).id),
        requestResult({ commitSha: sha(n + 10), pushed: true }),
      );
    }
    pushTo(sha(4));
    expect(
      await respondToDocumentationCheck(
        deps(),
        await docsCheck(repoId, {
          headSha: sha(4),
          updates: [{ path: "doc-4.md", reason: "Out of date." }],
        }),
      ),
    ).toEqual({ status: "limit", requests: 3 });
    expect(await listDocumentationRequests(db, repoId, 5)).toHaveLength(3);
    expect(await db.select().from(ralphRuns)).toHaveLength(3);
  });
});
