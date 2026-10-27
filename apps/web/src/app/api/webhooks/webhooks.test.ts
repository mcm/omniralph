import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  captureChanges,
  connectRepository,
  closeDb,
  createRun,
  getLane,
  getMainLane,
  updateLane,
  updateRun,
  deleteScmConnection,
  getScmConnection,
  createDb,
  getRepository,
  jobs,
  repositories,
  reviews,
  upsertScmConnection,
  webhookDeliveries,
  type Database,
  type RecordedChange,
  organizations,
} from "@omniralph/db";
import { reviewTriggerContext } from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Dispatch from "@/lib/dispatch";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  failDispatch: false,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/dispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof Dispatch>();
  return {
    ...actual,
    getDispatcher: (): Dispatch.JobDispatcher => {
      const dispatcher = new actual.PostgresDispatcher({ db: state.db });
      return {
        createAndPublish: (input) =>
          state.failDispatch
            ? Promise.reject(new Error("database unavailable"))
            : dispatcher.createAndPublish(input),
        cancel: (jobId) => dispatcher.cancel(jobId),
        republish: (jobId) => dispatcher.republish(jobId),
      };
    },
  };
});

const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
delete process.env.GITHUB_APP_KMS_ISSUER_ID;
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.GITHUB_APP_ID = "12345";
process.env.GITHUB_APP_PRIVATE_KEY = appKey.export({ type: "pkcs8", format: "pem" }).toString();
process.env.GITHUB_WEBHOOK_SECRET = "github-secret";

const { POST: github } = await import("./github/route");
const { POST: gitlab } = await import("./gitlab/route");

const databaseAvailable = testDatabaseAvailable();

const GITLAB_URL = "https://gitlab.example.com";
const GITLAB_SECRET = "gitlab-secret";
const BASE_SHA = "a".repeat(40);
const START_SHA = "c".repeat(40);
let shaCounter = 0;
const nextSha = () => (++shaCounter).toString(16).padStart(40, "b");

const gitlabMr = { lookups: 0, delayMs: 0 };
const server = setupServer(
  http.get(`${GITLAB_URL}/api/v4/projects/:id/merge_requests/:iid`, async ({ params }) => {
    gitlabMr.lookups += 1;
    if (gitlabMr.delayMs) await new Promise((r) => setTimeout(r, gitlabMr.delayMs));
    return HttpResponse.json({
      iid: Number(params.iid),
      title: "API title",
      description: "API description",
      author: { username: "mr-author" },
      draft: false,
      diff_refs: { base_sha: BASE_SHA, start_sha: START_SHA, head_sha: "f".repeat(40) },
      target_branch: "main",
      source_branch: "feature",
      web_url: `${GITLAB_URL}/acme/app/-/merge_requests/${String(params.iid)}`,
    });
  }),
);

function githubPayload(
  action: string,
  opts: {
    number: number;
    head?: string;
    draft?: boolean;
    repoId?: number;
    body?: string;
    defaultBranch?: string;
  },
) {
  return {
    action,
    installation: { id: 4242 },
    repository: {
      id: opts.repoId ?? 100,
      full_name: "acme/app",
      ...(opts.defaultBranch ? { default_branch: opts.defaultBranch } : {}),
    },
    pull_request: {
      number: opts.number,
      state: "open",
      draft: opts.draft ?? false,
      title: "Add login",
      body: opts.body ?? "Please review",
      user: { login: "octocat" },
      head: { sha: opts.head ?? nextSha() },
      base: { sha: BASE_SHA },
    },
  };
}

function githubRequest(
  payload: unknown,
  opts: { event?: string; delivery?: string; secret?: string } = {},
): Request {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", opts.secret ?? "github-secret")
    .update(body)
    .digest("hex");
  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": opts.event ?? "pull_request",
      "x-github-delivery": opts.delivery ?? randomUUID(),
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
}

function gitlabPayload(
  action: string,
  opts: {
    iid: number;
    head?: string;
    draft?: boolean;
    oldrev?: string;
    changes?: Record<string, unknown>;
    projectId?: number;
    defaultBranch?: string;
  },
) {
  return {
    object_kind: "merge_request",
    user: { username: "pusher" },
    project: {
      id: opts.projectId ?? 200,
      path_with_namespace: "acme/app",
      ...(opts.defaultBranch ? { default_branch: opts.defaultBranch } : {}),
    },
    object_attributes: {
      iid: opts.iid,
      action,
      state: "opened",
      title: "Add login",
      description: "Please review",
      draft: opts.draft ?? false,
      last_commit: { id: opts.head ?? nextSha() },
      ...(opts.oldrev ? { oldrev: opts.oldrev } : {}),
    },
    changes: opts.changes ?? {},
  };
}

function gitlabRequest(
  payload: unknown,
  opts: { delivery?: string; token?: string; event?: string } = {},
): Request {
  return new Request("http://localhost/api/webhooks/gitlab", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-event": opts.event ?? "Merge Request Hook",
      "x-gitlab-event-uuid": opts.delivery ?? randomUUID(),
      "x-gitlab-token": opts.token ?? GITLAB_SECRET,
    },
    body: JSON.stringify(payload),
  });
}

describe.skipIf(!databaseAvailable)("webhook ingestion", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let githubRepoId: string;
  let gitlabRepoId: string;
  let prCounter = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    state.db = db;
    server.listen({ onUnhandledFrame: "error" });

    const ghConnection = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "github",
      name: "acme",
      baseUrl: "https://api.github.com",
      externalId: "4242",
      credentials: {},
    }))!;
    githubRepoId = (
      await connectRepository(db, {
        connectionId: ghConnection.id,
        provider: "github",
        externalId: "100",
        fullPath: "acme/app",
      })
    ).id;
    const glConnection = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "gitlab",
      name: "gitlab",
      baseUrl: GITLAB_URL,
      externalId: "7",
      credentials: { token: "glpat-bot", webhookSecret: GITLAB_SECRET },
    }))!;
    gitlabRepoId = (
      await connectRepository(db, {
        connectionId: glConnection.id,
        provider: "gitlab",
        externalId: "200",
        fullPath: "acme/app",
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    server.close();
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    gitlabMr.lookups = 0;
    gitlabMr.delayMs = 0;
    for (const id of [githubRepoId, gitlabRepoId]) {
      await db
        .update(repositories)
        .set({ reviewsEnabled: true, triggers: { onOpen: true, onPush: true, drafts: false } })
        .where(eq(repositories.id, id));
    }
  });

  const prJobs = (repositoryId: string, prNumber: number) =>
    db
      .select()
      .from(jobs)
      .where(eq(jobs.repositoryId, repositoryId))
      .then((rows) =>
        rows.filter(
          (j) => j.type === "review.task" && reviewTriggerContext(j.payload).prNumber === prNumber,
        ),
      );

  describe("GitHub", () => {
    it("creates a queued review and a review job for an opened PR", async () => {
      const number = ++prCounter;
      const head = nextSha();
      const started = Date.now();
      const res = await github(githubRequest(githubPayload("opened", { number, head })));
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; reviewId: string; jobId: string };
      expect(body.status).toBe("enqueued");

      const [review] = await db.select().from(reviews).where(eq(reviews.id, body.reviewId));
      expect(review).toMatchObject({
        status: "queued",
        trigger: "webhook",
        prNumber: number,
        headSha: head,
        baseSha: BASE_SHA,
        repositoryId: githubRepoId,
      });
      const [job] = await prJobs(githubRepoId, number);
      expect(job).toMatchObject({
        id: body.jobId,
        type: "review.task",
        taskType: "review",
      });
      const payload = reviewTriggerContext(job!.payload);
      expect(payload).toMatchObject({
        reviewId: body.reviewId,
        headSha: head,
        baseSha: BASE_SHA,
        changeRequest: { title: "Add login", description: "Please review", author: "octocat" },
      });
      expect(job).toMatchObject({
        organizationId: orgId,
        status: "queued",
        targetAgentId: null,
      });
    });

    it("enqueues an opened PR whose description is over 100,000 characters, truncated", async () => {
      const number = ++prCounter;
      const description = "x".repeat(300 * 1024);
      const res = await github(
        githubRequest(githubPayload("opened", { number, body: description })),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "enqueued" });
      const [job] = await prJobs(githubRepoId, number);
      const context = reviewTriggerContext(job!.payload);
      for (const text of [context.changeRequest.description, context.pr.body]) {
        expect(text).toHaveLength(100_000);
        expect(text).toMatch(
          /^x+\n\n\[Description truncated: it is longer than 100,000 characters\.\]$/,
        );
      }
    });

    it("enqueues reopened, ready_for_review and synchronize events", async () => {
      for (const action of ["reopened", "ready_for_review", "synchronize"]) {
        const number = ++prCounter;
        const res = await github(githubRequest(githubPayload(action, { number })));
        expect(await res.json()).toMatchObject({ status: "enqueued" });
        expect(await prJobs(githubRepoId, number)).toHaveLength(1);
      }
    });

    it("rejects an invalid signature with 401 and does nothing", async () => {
      const number = ++prCounter;
      const res = await github(
        githubRequest(githubPayload("opened", { number }), { secret: "wrong-secret" }),
      );
      expect(res.status).toBe(401);
      const unsigned = githubRequest(githubPayload("opened", { number }));
      unsigned.headers.delete("x-hub-signature-256");
      expect((await github(unsigned)).status).toBe(401);
      expect(await prJobs(githubRepoId, number)).toHaveLength(0);
    });

    it("verifies workflow_run deliveries and ignores them without ralph", async () => {
      const payload = (conclusion: string) => ({
        action: "completed",
        installation: { id: 4242 },
        repository: { id: 100, full_name: "acme/app" },
        workflow_run: {
          head_sha: nextSha(),
          head_branch: "feature",
          conclusion,
          pull_requests: [{ number: 1 }],
        },
      });
      await db
        .update(repositories)
        .set({ codingEnabled: false })
        .where(eq(repositories.id, githubRepoId));
      const jobCount = async () => (await db.select().from(jobs)).length;
      const before = await jobCount();
      const forged = await github(
        githubRequest(payload("failure"), { event: "workflow_run", secret: "wrong-secret" }),
      );
      expect(forged.status).toBe(401);
      const passed = await github(githubRequest(payload("success"), { event: "workflow_run" }));
      expect(await passed.json()).toEqual({ status: "ignored", reason: "ci_not_failed" });
      const failed = await github(githubRequest(payload("failure"), { event: "workflow_run" }));
      expect(await failed.json()).toEqual({ status: "ignored", reason: "ralph_disabled" });
      expect(await jobCount()).toBe(before);
    });

    it("skips drafts unless includeDrafts (triggers.drafts) is on", async () => {
      const number = ++prCounter;
      const res = await github(githubRequest(githubPayload("opened", { number, draft: true })));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ignored", reason: "draft" });
      expect(await prJobs(githubRepoId, number)).toHaveLength(0);

      await db
        .update(repositories)
        .set({ triggers: { onOpen: true, onPush: true, drafts: true } })
        .where(eq(repositories.id, githubRepoId));
      const included = await github(
        githubRequest(githubPayload("opened", { number, draft: true })),
      );
      expect(await included.json()).toMatchObject({ status: "enqueued" });
      expect(await prJobs(githubRepoId, number)).toHaveLength(1);
    });

    it("reviews by the repository's own switch", async () => {
      // A new repository has reviews on.
      expect((await getRepository(db, githubRepoId))?.reviewsEnabled).toBe(true);
      const number = ++prCounter;
      const on = await github(githubRequest(githubPayload("opened", { number })));
      expect(await on.json()).toMatchObject({ status: "enqueued" });
      expect(await prJobs(githubRepoId, number)).toHaveLength(1);
    });

    it("returns 200 and does nothing for disabled and unknown repos", async () => {
      const number = ++prCounter;
      await db
        .update(repositories)
        .set({ reviewsEnabled: false })
        .where(eq(repositories.id, githubRepoId));
      const disabled = await github(githubRequest(githubPayload("opened", { number })));
      expect(disabled.status).toBe(200);
      expect(await disabled.json()).toEqual({ status: "ignored", reason: "repository_disabled" });

      const unknown = await github(githubRequest(githubPayload("opened", { number, repoId: 999 })));
      expect(unknown.status).toBe(200);
      expect(await unknown.json()).toEqual({ status: "ignored", reason: "unknown_repository" });

      expect(await prJobs(githubRepoId, number)).toHaveLength(0);
    });

    it("honours the onOpen and onPush triggers", async () => {
      const number = ++prCounter;
      await db
        .update(repositories)
        .set({ triggers: { onOpen: false, onPush: false, drafts: false } })
        .where(eq(repositories.id, githubRepoId));
      for (const action of ["opened", "synchronize"]) {
        const res = await github(githubRequest(githubPayload(action, { number })));
        expect(await res.json()).toEqual({ status: "ignored", reason: "trigger_disabled" });
      }
      expect(await prJobs(githubRepoId, number)).toHaveLength(0);
    });

    it("ignores other events and actions", async () => {
      const number = ++prCounter;
      // A closed PR is only acted on when it's a ralph run's.
      const closed = await github(githubRequest(githubPayload("closed", { number })));
      expect(await closed.json()).toEqual({ status: "ignored", reason: "not_ralph" });
      for (const [event, action] of [
        ["pull_request", "edited"],
        ["issue_comment", "created"],
      ] as const) {
        const res = await github(githubRequest(githubPayload(action, { number }), { event }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: "ignored", reason: "unsupported_event" });
      }
      // A draft or review state change is only recorded when it's a ralph run's PR.
      const drafted = await github(githubRequest(githubPayload("converted_to_draft", { number })));
      expect(await drafted.json()).toEqual({ status: "ignored", reason: "not_ralph" });
      expect(await prJobs(githubRepoId, number)).toHaveLength(0);
    });

    it("records a ralph PR's review state from pull_request and pull_request_review", async () => {
      const number = ++prCounter;
      const { run } = await createRun(db, {
        organizationId: orgId,
        linearIssueId: `issue-pr-${number}`,
        linearIdentifier: `ENG-${number}`,
        linearAgentSessionId: `session-pr-${number}`,
        kind: "children",
        repositoryId: githubRepoId,
        branch: `om/eng-${number}`,
        baseBranch: "main",
      });
      await updateRun(db, run.id, { status: "completed" });
      const lane = (await updateLane(db, (await getMainLane(db, run))!.id, {
        prNumber: number,
        prUrl: `https://github.com/acme/app/pull/${number}`,
      }))!;
      const stateOf = async () => {
        const current = (await getLane(db, lane.id))!;
        return [current.prDraft, current.prReviewState];
      };
      const accepted = { status: "accepted", event: "pull_request_state" };
      const reviewPayload = (action: string, state: string) => ({
        action,
        installation: { id: 4242 },
        repository: { id: 100, full_name: "acme/app" },
        review: { state, user: { login: "alice", type: "User" } },
        pull_request: { number, state: "open", draft: false, requested_reviewers: [] },
      });

      const approved = await github(
        githubRequest(reviewPayload("submitted", "approved"), { event: "pull_request_review" }),
      );
      expect(await approved.json()).toEqual(accepted);
      expect(await stateOf()).toEqual([false, "approved"]);
      const dismissed = await github(
        githubRequest(reviewPayload("dismissed", "dismissed"), { event: "pull_request_review" }),
      );
      expect(await dismissed.json()).toEqual(accepted);
      expect(await stateOf()).toEqual([false, "none"]);
      const changes = await github(
        githubRequest(reviewPayload("submitted", "changes_requested"), {
          event: "pull_request_review",
        }),
      );
      expect(await changes.json()).toEqual(accepted);
      expect(await stateOf()).toEqual([false, "changes_requested"]);
      // Drafting it, then reopening it, are recorded too.
      const drafted = await github(
        githubRequest(githubPayload("converted_to_draft", { number, draft: true })),
      );
      expect(await drafted.json()).toEqual(accepted);
      expect(await stateOf()).toEqual([true, "changes_requested"]);
      await github(githubRequest(githubPayload("reopened", { number })));
      expect(await stateOf()).toEqual([false, "changes_requested"]);
    });

    it("does not create a second job for a repeated delivery ID", async () => {
      const number = ++prCounter;
      const delivery = randomUUID();
      const payload = githubPayload("opened", { number });
      const first = (await (await github(githubRequest(payload, { delivery }))).json()) as {
        jobId: string;
      };
      const [again, concurrent] = await Promise.all([
        github(githubRequest(payload, { delivery })),
        github(githubRequest(payload, { delivery })),
      ]);
      expect(await again.json()).toEqual({ status: "duplicate" });
      expect(await concurrent.json()).toEqual({ status: "duplicate" });

      // Still a no-op once the job has finished (job dedupe alone would allow a new one).
      await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, first.jobId));
      const later = await github(githubRequest(payload, { delivery }));
      expect(await later.json()).toEqual({ status: "duplicate" });

      expect(await prJobs(githubRepoId, number)).toHaveLength(1);
      expect(await db.select().from(reviews).where(eq(reviews.prNumber, number))).toHaveLength(1);
      const [row] = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.deliveryId, delivery));
      expect(row).toMatchObject({
        provider: "github",
        jobId: first.jobId,
        repositoryId: githubRepoId,
      });
    });

    it("releases the delivery when enqueueing fails so a redelivery is processed", async () => {
      const number = ++prCounter;
      const delivery = randomUUID();
      const payload = githubPayload("opened", { number });
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      state.failDispatch = true;
      const failed = await github(githubRequest(payload, { delivery })).finally(() => {
        state.failDispatch = false;
        error.mockRestore();
      });
      expect(failed.status).toBe(500);
      expect(await prJobs(githubRepoId, number)).toHaveLength(0);
      expect(await db.select().from(reviews).where(eq(reviews.prNumber, number))).toHaveLength(0);

      // The delivery was released, so the redelivery enqueues the review.
      const retried = await github(githubRequest(payload, { delivery }));
      expect(retried.status).toBe(200);
      const [job, ...others] = await prJobs(githubRepoId, number);
      expect(others).toHaveLength(0);
      expect(await retried.json()).toMatchObject({ status: "enqueued", jobId: job!.id });
      expect(job).toMatchObject({ status: "queued", targetAgentId: null });
    });
  });

  describe("GitLab", () => {
    it("creates a review job for an opened MR with the base and author from the API", async () => {
      const iid = ++prCounter;
      const head = nextSha();
      const started = Date.now();
      const res = await gitlab(gitlabRequest(gitlabPayload("open", { iid, head })));
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; reviewId: string; jobId: string };
      expect(body.status).toBe("enqueued");
      const [review] = await db.select().from(reviews).where(eq(reviews.id, body.reviewId));
      expect(review).toMatchObject({ status: "queued", headSha: head, baseSha: START_SHA });
      const [job] = await prJobs(gitlabRepoId, iid);
      expect(reviewTriggerContext(job!.payload)).toMatchObject({
        repository: "acme/app",
        headSha: head,
        baseSha: START_SHA,
        changeRequest: { title: "Add login", author: "mr-author" },
      });
      expect(gitlabMr.lookups).toBe(1);
    });

    it("enqueues reopen, pushes (update with oldrev) and ready-for-review updates", async () => {
      const events = [
        gitlabPayload("reopen", { iid: ++prCounter }),
        gitlabPayload("update", { iid: ++prCounter, oldrev: nextSha() }),
        gitlabPayload("update", {
          iid: ++prCounter,
          changes: { draft: { previous: true, current: false } },
        }),
      ];
      for (const payload of events) {
        const res = await gitlab(gitlabRequest(payload));
        expect(await res.json()).toMatchObject({ status: "enqueued" });
        expect(await prJobs(gitlabRepoId, payload.object_attributes.iid)).toHaveLength(1);
      }
    });

    it("ignores updates without new commits", async () => {
      const iid = ++prCounter;
      const res = await gitlab(
        gitlabRequest(
          gitlabPayload("update", { iid, changes: { title: { previous: "a", current: "b" } } }),
        ),
      );
      expect(await res.json()).toEqual({ status: "ignored", reason: "unsupported_event" });
      expect(await prJobs(gitlabRepoId, iid)).toHaveLength(0);
    });

    it("verifies Pipeline Hook deliveries and ignores them without ralph", async () => {
      const payload = (status: string) => ({
        object_kind: "pipeline",
        project: { id: 200, path_with_namespace: "acme/app" },
        object_attributes: { id: 9, ref: "feature", sha: nextSha(), status },
        merge_request: { iid: 1 },
      });
      await db
        .update(repositories)
        .set({ codingEnabled: false })
        .where(eq(repositories.id, gitlabRepoId));
      const event = "Pipeline Hook";
      expect(
        (await gitlab(gitlabRequest(payload("failed"), { event, token: "nope" }))).status,
      ).toBe(401);
      const passed = await gitlab(gitlabRequest(payload("success"), { event }));
      expect(await passed.json()).toEqual({ status: "ignored", reason: "ci_not_failed" });
      const failed = await gitlab(gitlabRequest(payload("failed"), { event }));
      expect(await failed.json()).toEqual({ status: "ignored", reason: "ralph_disabled" });
      expect(gitlabMr.lookups).toBe(0);
    });

    it("rejects a wrong X-Gitlab-Token with 401", async () => {
      const iid = ++prCounter;
      const res = await gitlab(gitlabRequest(gitlabPayload("open", { iid }), { token: "nope" }));
      expect(res.status).toBe(401);
      const missing = gitlabRequest(gitlabPayload("open", { iid }));
      missing.headers.delete("x-gitlab-token");
      expect((await gitlab(missing)).status).toBe(401);
      expect(await prJobs(gitlabRepoId, iid)).toHaveLength(0);
      expect(gitlabMr.lookups).toBe(0);
    });

    it("skips draft MRs and disabled projects", async () => {
      const iid = ++prCounter;
      const draft = await gitlab(gitlabRequest(gitlabPayload("open", { iid, draft: true })));
      expect(await draft.json()).toEqual({ status: "ignored", reason: "draft" });

      await db
        .update(repositories)
        .set({ reviewsEnabled: false })
        .where(eq(repositories.id, gitlabRepoId));
      const disabled = await gitlab(gitlabRequest(gitlabPayload("open", { iid })));
      expect(disabled.status).toBe(200);
      expect(await disabled.json()).toEqual({ status: "ignored", reason: "repository_disabled" });
      const unknown = await gitlab(gitlabRequest(gitlabPayload("open", { iid, projectId: 999 })));
      expect(await unknown.json()).toEqual({ status: "ignored", reason: "unknown_repository" });

      expect(await prJobs(gitlabRepoId, iid)).toHaveLength(0);
      expect(gitlabMr.lookups).toBe(0);
    });

    it("does not create a second job for a repeated X-Gitlab-Event-UUID", async () => {
      const iid = ++prCounter;
      const delivery = randomUUID();
      const payload = gitlabPayload("open", { iid });
      expect(await (await gitlab(gitlabRequest(payload, { delivery }))).json()).toMatchObject({
        status: "enqueued",
      });
      expect(await (await gitlab(gitlabRequest(payload, { delivery }))).json()).toEqual({
        status: "duplicate",
      });
      expect(await prJobs(gitlabRepoId, iid)).toHaveLength(1);
      expect(gitlabMr.lookups).toBe(1);
    });

    it("answers within 3s when the GitLab API is slow", async () => {
      const iid = ++prCounter;
      const delivery = randomUUID();
      gitlabMr.delayMs = 5_000;
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const started = Date.now();
      const res = await gitlab(gitlabRequest(gitlabPayload("open", { iid }), { delivery }));
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(res.status).toBe(500);
      error.mockRestore();
      expect(await prJobs(gitlabRepoId, iid)).toHaveLength(0);
      const rows = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.deliveryId, delivery));
      expect(rows).toHaveLength(0);
    });
  });

  describe("default branch", () => {
    const repositoryChanges = (changes: RecordedChange[]) =>
      changes.filter((change) => change.resource === "repository");

    it("stores a GitHub repository's default branch from a pull_request delivery, once", async () => {
      const payload = () =>
        githubPayload("opened", { number: ++prCounter, defaultBranch: "release" });
      const first = await captureChanges(() => github(githubRequest(payload())));
      expect(first.result.status).toBe(200);
      expect((await getRepository(db, githubRepoId))?.defaultBranch).toBe("release");
      expect(repositoryChanges(first.changes)).toEqual([
        expect.objectContaining({ ids: [githubRepoId], organizationId: orgId }),
      ]);

      const repeat = await captureChanges(() => github(githubRequest(payload())));
      expect(repeat.result.status).toBe(200);
      expect(repositoryChanges(repeat.changes)).toEqual([]);
    });

    it("stores it from deliveries that don't start a review, and not from unverified ones", async () => {
      await db
        .update(repositories)
        .set({ reviewsEnabled: false, defaultBranch: "main" })
        .where(eq(repositories.id, githubRepoId));
      const disabled = githubPayload("opened", { number: ++prCounter, defaultBranch: "trunk" });
      expect(await (await github(githubRequest(disabled))).json()).toMatchObject({
        status: "ignored",
      });
      expect((await getRepository(db, githubRepoId))?.defaultBranch).toBe("trunk");

      const forged = githubPayload("opened", { number: ++prCounter, defaultBranch: "evil" });
      expect((await github(githubRequest(forged, { secret: "wrong" }))).status).toBe(401);
      expect((await getRepository(db, githubRepoId))?.defaultBranch).toBe("trunk");
    });

    it("stores a GitLab project's default branch from a Merge Request Hook, once", async () => {
      const payload = () => gitlabPayload("open", { iid: ++prCounter, defaultBranch: "develop" });
      const first = await captureChanges(() => gitlab(gitlabRequest(payload())));
      expect(first.result.status).toBe(200);
      expect((await getRepository(db, gitlabRepoId))?.defaultBranch).toBe("develop");
      expect(repositoryChanges(first.changes)).toEqual([
        expect.objectContaining({ ids: [gitlabRepoId], organizationId: orgId }),
      ]);

      const repeat = await captureChanges(() => gitlab(gitlabRequest(payload())));
      expect(repeat.result.status).toBe(200);
      expect(repositoryChanges(repeat.changes)).toEqual([]);
    });
  });

  describe("organizations", () => {
    it("files the review under the organization of the connection that verified the delivery", async () => {
      // Another organization connects the same GitLab project and GitHub repository with
      // its own token user (and webhook secret) and its own GitHub App installation.
      const [beta] = await db.insert(organizations).values({ name: "Beta" }).returning();
      const betaGitlab = (await upsertScmConnection(db, {
        organizationId: beta!.id,
        provider: "gitlab",
        name: "beta",
        baseUrl: GITLAB_URL,
        externalId: "8",
        credentials: { token: "glpat-beta", webhookSecret: "beta-secret" },
      }))!;
      const betaGitlabRepo = await connectRepository(db, {
        connectionId: betaGitlab.id,
        provider: "gitlab",
        externalId: "200",
        fullPath: "acme/app",
      });
      const betaGithub = (await upsertScmConnection(db, {
        organizationId: beta!.id,
        provider: "github",
        name: "beta",
        baseUrl: "https://api.github.com",
        externalId: "5555",
        credentials: {},
      }))!;
      const betaGithubRepo = await connectRepository(db, {
        connectionId: betaGithub.id,
        provider: "github",
        externalId: "100",
        fullPath: "acme/app",
      });
      expect(betaGitlabRepo.organizationId).toBe(beta!.id);
      expect(betaGithubRepo.organizationId).toBe(beta!.id);

      const reviewOf = async (res: Response) => {
        const body = (await res.json()) as { status: string; reviewId: string };
        expect(body.status).toBe("enqueued");
        const [review] = await db.select().from(reviews).where(eq(reviews.id, body.reviewId));
        return review!;
      };

      const betaMr = await reviewOf(
        await gitlab(
          gitlabRequest(gitlabPayload("open", { iid: ++prCounter }), { token: "beta-secret" }),
        ),
      );
      expect(betaMr.repositoryId).toBe(betaGitlabRepo.id);
      const acmeMr = await reviewOf(
        await gitlab(gitlabRequest(gitlabPayload("open", { iid: ++prCounter }))),
      );
      expect(acmeMr.repositoryId).toBe(gitlabRepoId);

      const betaPr = await reviewOf(
        await github(
          githubRequest({
            ...githubPayload("opened", { number: ++prCounter }),
            installation: { id: 5555 },
          }),
        ),
      );
      expect(betaPr.repositoryId).toBe(betaGithubRepo.id);
      const acmePr = await reviewOf(
        await github(githubRequest(githubPayload("opened", { number: ++prCounter }))),
      );
      expect(acmePr.repositoryId).toBe(githubRepoId);

      // The jobs belong to the same repositories (and so organizations) as their reviews.
      expect(await prJobs(betaGitlabRepo.id, betaMr.prNumber)).toHaveLength(1);
      expect(await prJobs(betaGithubRepo.id, betaPr.prNumber)).toHaveLength(1);
      expect(await prJobs(gitlabRepoId, betaMr.prNumber)).toHaveLength(0);
      expect(await prJobs(githubRepoId, betaPr.prNumber)).toHaveLength(0);
    });
  });
  describe("GitHub App uninstall", () => {
    it("removes the installation's connection and repositories so another organization can connect it", async () => {
      const connection = (await upsertScmConnection(db, {
        organizationId: orgId,
        provider: "github",
        name: "uninstalled",
        baseUrl: "https://api.github.com",
        externalId: "6060",
        credentials: {},
      }))!;
      const repo = await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "606",
        fullPath: "acme/uninstalled",
      });
      const uninstall = { action: "deleted", installation: { id: 6060 } };

      // Unsigned deliveries change nothing; other installation actions are ignored.
      const forged = await github(
        githubRequest(uninstall, { event: "installation", secret: "wrong" }),
      );
      expect(forged.status).toBe(401);
      expect(
        await github(
          githubRequest({ ...uninstall, action: "suspend" }, { event: "installation" }),
        ).then((r) => r.json()),
      ).toMatchObject({ status: "ignored" });
      expect(await getScmConnection(db, orgId, connection.id)).not.toBeNull();

      const res = await github(githubRequest(uninstall, { event: "installation" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "removed", connections: 1 });
      expect(await getScmConnection(db, orgId, connection.id)).toBeNull();
      expect(await db.select().from(repositories).where(eq(repositories.id, repo.id))).toEqual([]);
      // The other connections of the organization are untouched.
      expect(
        await db.select().from(repositories).where(eq(repositories.id, githubRepoId)),
      ).toHaveLength(1);

      // A redelivery (or an unknown installation) is a no-op.
      expect(
        await github(githubRequest(uninstall, { event: "installation" })).then((r) => r.json()),
      ).toEqual({ status: "ignored", reason: "unknown_installation" });

      // Installed again, the installation can be connected from another organization.
      const [beta] = await db.insert(organizations).values({ name: "Gamma" }).returning();
      const moved = await upsertScmConnection(db, {
        organizationId: beta!.id,
        provider: "github",
        name: "uninstalled",
        baseUrl: "https://api.github.com",
        externalId: "6060",
        credentials: {},
      });
      expect(moved?.organizationId).toBe(beta!.id);
    });
  });
  describe("GitHub App installation account", () => {
    it("records the installation's account type from its installation events", async () => {
      const connection = (await upsertScmConnection(db, {
        organizationId: orgId,
        provider: "github",
        name: "acme-org",
        baseUrl: "https://api.github.com",
        externalId: "7070",
        credentials: {},
      }))!;
      expect(connection.accountType).toBeNull();
      const event = (action: string, type: string) => ({
        action,
        installation: { id: 7070, account: { login: "acme-org", type } },
      });

      // Unsigned deliveries change nothing.
      const forged = await github(
        githubRequest(event("created", "Organization"), { event: "installation", secret: "wrong" }),
      );
      expect(forged.status).toBe(401);
      expect((await getScmConnection(db, orgId, connection.id))?.accountType).toBeNull();

      const first = await captureChanges(() =>
        github(
          githubRequest(event("added", "Organization"), { event: "installation_repositories" }),
        ),
      );
      expect(await first.result.json()).toEqual({ status: "updated", connections: 1 });
      expect((await getScmConnection(db, orgId, connection.id))?.accountType).toBe("Organization");
      expect(first.changes).toEqual([
        expect.objectContaining({
          resource: "connection",
          ids: [connection.id],
          organizationId: orgId,
        }),
      ]);

      // Already recorded: nothing changes or publishes.
      const repeat = await captureChanges(() =>
        github(githubRequest(event("suspend", "Organization"), { event: "installation" })),
      );
      expect(await repeat.result.json()).toEqual({ status: "updated", connections: 0 });
      expect(repeat.changes).toEqual([]);

      // An account type other than User or Organization isn't recorded.
      await github(githubRequest(event("unsuspend", "Enterprise"), { event: "installation" }));
      expect((await getScmConnection(db, orgId, connection.id))?.accountType).toBe("Organization");

      // An installation that isn't connected is ignored.
      expect(
        await github(
          githubRequest(
            { action: "created", installation: { id: 7071, account: { type: "User" } } },
            { event: "installation" },
          ),
        ).then((r) => r.json()),
      ).toEqual({ status: "ignored", reason: "unknown_installation" });
      await deleteScmConnection(db, orgId, connection.id);
    });
  });
});
