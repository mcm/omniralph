import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  connectRepository,
  closeDb,
  createDb,
  jobs,
  repositories,
  reviews,
  runMigrations,
  upsertScmConnection,
  webhookDeliveries,
  type Database,
  organizations,
  seedReviewProfiles,
} from "@omniralph/db";
import { ReviewJobPayload } from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  sends: [] as { topic: string; payload: unknown; options: unknown }[],
  failSends: false,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@vercel/queue", () => ({
  QueueClient: class {
    async send(topic: string, payload: unknown, options: unknown) {
      if (state.failSends) throw new Error("queue unavailable");
      state.sends.push({ topic, payload, options });
      return { messageId: `msg-${state.sends.length}` };
    }
  },
}));

const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
delete process.env.GITHUB_APP_KMS_ISSUER_ID;
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.QUEUE_REGIONS = "iad1";
process.env.GITHUB_APP_ID = "12345";
process.env.GITHUB_APP_PRIVATE_KEY = appKey.export({ type: "pkcs8", format: "pem" }).toString();
process.env.GITHUB_WEBHOOK_SECRET = "github-secret";

const { POST: github } = await import("./github/route");
const { POST: gitlab } = await import("./gitlab/route");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

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
  opts: { number: number; head?: string; draft?: boolean; repoId?: number },
) {
  return {
    action,
    installation: { id: 4242 },
    repository: { id: opts.repoId ?? 100, full_name: "acme/app" },
    pull_request: {
      number: opts.number,
      state: "open",
      draft: opts.draft ?? false,
      title: "Add login",
      body: "Please review",
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
  },
) {
  return {
    object_kind: "merge_request",
    user: { username: "pusher" },
    project: { id: opts.projectId ?? 200, path_with_namespace: "acme/app" },
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

describe.skipIf(!dockerAvailable)("webhook ingestion", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let githubRepoId: string;
  let gitlabRepoId: string;
  let prCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
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
    await container?.stop();
  });

  beforeEach(async () => {
    state.sends.length = 0;
    gitlabMr.lookups = 0;
    gitlabMr.delayMs = 0;
    for (const id of [githubRepoId, gitlabRepoId]) {
      await db
        .update(repositories)
        .set({ enabled: true, triggers: { onOpen: true, onPush: true, drafts: false } })
        .where(eq(repositories.id, id));
    }
  });

  const prJobs = (repositoryId: string, prNumber: number) =>
    db
      .select()
      .from(jobs)
      .where(eq(jobs.repositoryId, repositoryId))
      .then((rows) =>
        rows.filter((j) => ReviewJobPayload.safeParse(j.payload).data?.prNumber === prNumber),
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
      expect(job).toMatchObject({ id: body.jobId, capability: "review", type: "review.run" });
      const payload = ReviewJobPayload.parse(job!.payload);
      expect(payload).toMatchObject({
        reviewId: body.reviewId,
        headSha: head,
        baseSha: BASE_SHA,
        changeRequest: { title: "Add login", description: "Please review", author: "octocat" },
      });
      expect(state.sends).toEqual([
        expect.objectContaining({ topic: "review-jobs", payload: { jobId: body.jobId } }),
      ]);
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
      expect(state.sends).toHaveLength(0);
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
      const forged = await github(
        githubRequest(payload("failure"), { event: "workflow_run", secret: "wrong-secret" }),
      );
      expect(forged.status).toBe(401);
      const passed = await github(githubRequest(payload("success"), { event: "workflow_run" }));
      expect(await passed.json()).toEqual({ status: "ignored", reason: "ci_not_failed" });
      const failed = await github(githubRequest(payload("failure"), { event: "workflow_run" }));
      expect(await failed.json()).toEqual({ status: "ignored", reason: "ralph_disabled" });
      expect(state.sends).toHaveLength(0);
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

    it("returns 200 and does nothing for disabled and unknown repos", async () => {
      const number = ++prCounter;
      await db
        .update(repositories)
        .set({ enabled: false })
        .where(eq(repositories.id, githubRepoId));
      const disabled = await github(githubRequest(githubPayload("opened", { number })));
      expect(disabled.status).toBe(200);
      expect(await disabled.json()).toEqual({ status: "ignored", reason: "repository_disabled" });

      const unknown = await github(githubRequest(githubPayload("opened", { number, repoId: 999 })));
      expect(unknown.status).toBe(200);
      expect(await unknown.json()).toEqual({ status: "ignored", reason: "unknown_repository" });

      expect(await prJobs(githubRepoId, number)).toHaveLength(0);
      expect(state.sends).toHaveLength(0);
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
      for (const [event, action] of [
        ["pull_request", "closed"],
        ["pull_request", "edited"],
        ["pull_request", "converted_to_draft"],
        ["issue_comment", "created"],
      ] as const) {
        const res = await github(githubRequest(githubPayload(action, { number }), { event }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: "ignored", reason: "unsupported_event" });
      }
      expect(await prJobs(githubRepoId, number)).toHaveLength(0);
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
      expect(state.sends).toHaveLength(1);
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
      state.failSends = true;
      const failed = await github(githubRequest(payload, { delivery })).finally(() => {
        state.failSends = false;
        error.mockRestore();
      });
      expect(failed.status).toBe(500);
      expect(state.sends).toHaveLength(0);

      // The job row survived the failed publish; the redelivery publishes it.
      const retried = await github(githubRequest(payload, { delivery }));
      expect(retried.status).toBe(200);
      const [job] = await prJobs(githubRepoId, number);
      expect(await retried.json()).toEqual({ status: "duplicate", jobId: job!.id });
      expect(job!.topic).toBe("review-jobs");
      expect(state.sends).toEqual([expect.objectContaining({ payload: { jobId: job!.id } })]);
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
      expect(ReviewJobPayload.parse(job!.payload)).toMatchObject({
        repository: { provider: "gitlab", fullPath: "acme/app" },
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
        .set({ enabled: false })
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

  describe("organizations", () => {
    it("files the review under the organization of the connection that verified the delivery", async () => {
      // Another organization connects the same GitLab project and GitHub repository with
      // its own token user (and webhook secret) and its own GitHub App installation.
      const [beta] = await db.insert(organizations).values({ name: "Beta" }).returning();
      await seedReviewProfiles(db, beta!.id);
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
});
