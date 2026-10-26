import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  harnessRepoPins,
  harnesses,
  connectRepository,
  closeDb,
  createDb,
  jobs,
  listHarnessAudit,
  repositories,
  upsertScmConnection,
  type Database,
  organizations,
} from "@omniralph/db";
import {
  type CloneCredentialResponse,
  type JobStartResponse,
  JOB_TOKEN_SCOPES,
  type JobTokenScope,
  legacyJobRouting,
  RalphRequestPayload,
  RalphStoryPayload,
  RepoSyncPayload,
  type RunTokenKind,
  WorktreeCleanupPayload,
  WorktreeExecPayload,
} from "@omniralph/shared";
import { preparationHash } from "@omniralph/ralph";
import { getBuiltinTask } from "@omniralph/tasks";
import type { DispatchJobInput } from "@/lib/dispatch/dispatcher";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));

const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
delete process.env.KMS_AGENT_ISSUER_ID;
delete process.env.GITHUB_APP_KMS_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = signingKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.GITHUB_APP_ID = "12345";
process.env.GITHUB_APP_PRIVATE_KEY = appKey.export({ type: "pkcs8", format: "pem" }).toString();
process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";

const { getTokenSigner, LocalTokenSigner } = await import("@/lib/harness-auth/signer");
const { PostgresDispatcher } = await import("@/lib/dispatch");
const { pinRepository } = await import("@/lib/harnesses/pins");
const { POST: credentials } = await import("./credentials/route");
const { POST: claim } = await import("./claim/route");
const { codingJobInput } = await import("@/lib/ralph/coding");
const { BUILTIN_PLAYBOOK_SOURCE } = await import("@/lib/playbooks");
const { runSpecJobInput } = await import("@/lib/runs/job");
const { signJobTokens } = await import("@/lib/harness-api/jobs");

const databaseAvailable = testDatabaseAvailable();

const GITLAB = "https://gitlab.example.com";
const tokenRequests: { url: string; body: unknown }[] = [];
const server = setupServer(
  http.post(`${GITLAB}/api/v4/projects/77/access_tokens`, async ({ request }) => {
    const body = (await request.json()) as {
      name: string;
      expires_at: string;
      scopes: string[];
      access_level: number;
    };
    tokenRequests.push({ url: request.url, body });
    const write = body.scopes.includes("write_repository");
    return HttpResponse.json(
      {
        id: write ? 2 : 1,
        name: body.name,
        token: write ? "glpat-write-repository" : "glpat-read-only",
        expires_at: body.expires_at,
        scopes: body.scopes,
        access_level: body.access_level,
      },
      { status: 201 },
    );
  }),
  http.post("https://api.github.com/app/installations/4242/access_tokens", async ({ request }) => {
    const body = (await request.json()) as { permissions?: { contents?: string } };
    tokenRequests.push({ url: request.url, body });
    return HttpResponse.json(
      {
        token: `ghs_contents_${body.permissions?.contents ?? "all"}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
      { status: 201 },
    );
  }),
);

let ipCounter = 0;
function credentialRequest(token?: string, body?: unknown): Request {
  ipCounter += 1;
  return new Request("http://localhost/api/harness/credentials", {
    method: "POST",
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
      "x-real-ip": `203.0.113.${ipCounter}`,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

describe.skipIf(!databaseAvailable)("credential broker and repo pinning", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let gitlabConnectionId: string;
  let gitlabRepoId: string;
  let githubRepoId: string;
  let disconnectedRepoId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    state.db = db;
    server.listen({ onUnhandledFrame: "error" });

    const gitlab = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "gitlab",
      name: "bot @ gitlab.example.com",
      baseUrl: GITLAB,
      externalId: "5",
      credentials: { token: "glpat-bot-api", webhookSecret: "hook" },
    }))!;
    gitlabConnectionId = gitlab.id;
    gitlabRepoId = (
      await connectRepository(db, {
        connectionId: gitlab.id,
        provider: "gitlab",
        externalId: "77",
        fullPath: "group/sub/app",
      })
    ).id;
    disconnectedRepoId = (
      await connectRepository(db, {
        connectionId: gitlab.id,
        provider: "gitlab",
        externalId: "78",
        fullPath: "group/old",
      })
    ).id;
    await db
      .update(repositories)
      .set({ disconnectedAt: new Date() })
      .where(eq(repositories.id, disconnectedRepoId));
    const github = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "github",
      name: "acme",
      baseUrl: "https://api.github.com",
      externalId: "4242",
      credentials: {},
    }))!;
    githubRepoId = (
      await connectRepository(db, {
        connectionId: github.id,
        provider: "github",
        externalId: "100",
        fullPath: "acme/app",
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    server.close();
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    tokenRequests.length = 0;
  });

  async function newAgent(values: Partial<typeof harnesses.$inferInsert> = {}) {
    const [agent] = await db
      .insert(harnesses)
      .values({ organizationId: orgId, name: "coder-1", ...values })
      .returning();
    return agent!.id;
  }

  async function newJob(values: Partial<typeof jobs.$inferInsert>) {
    const [job] = await db
      .insert(jobs)
      .values({
        organizationId: orgId,
        type: "review.run",
        taskType: "review",
        ...values,
      })
      .returning();
    return job!.id;
  }

  function jobToken(
    jobId: string,
    harnessId: string,
    scopes: JobTokenScope[] = ["credentials:read"],
    kind?: RunTokenKind,
  ) {
    return getTokenSigner().signJobToken({ jobId, harnessId, scopes, kind });
  }

  async function issued(harnessId: string) {
    return listHarnessAudit(db, { harnessId, event: "credential_issued" });
  }

  describe("POST /api/harness/credentials", () => {
    it("issues a read-only GitLab credential for a running job's repo and audits it", async () => {
      const harnessId = await newAgent();
      const jobId = await newJob({ status: "running", harnessId, repositoryId: gitlabRepoId });
      const res = await credentials(credentialRequest(await jobToken(jobId, harnessId)));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as CloneCredentialResponse;
      expect(body).toMatchObject({
        cloneUrl: `${GITLAB}/group/sub/app.git`,
        username: "oauth2",
        password: "glpat-read-only",
      });
      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0]!.body).toMatchObject({ scopes: ["read_repository"] });

      const audit = await issued(harnessId);
      expect(audit).toHaveLength(1);
      expect(audit[0]!.detail).toEqual({
        jobId,
        repositoryId: gitlabRepoId,
        repository: "group/sub/app",
        provider: "gitlab",
        access: "read",
        tokenKind: "legacy",
        expiresAt: body.expiresAt,
      });
      expect(audit[0]!.ip).toMatch(/^203\.0\.113\./);
    });

    it("issues a GitHub installation token limited to contents: read on the one repo", async () => {
      const harnessId = await newAgent();
      const jobId = await newJob({ status: "running", harnessId, repositoryId: githubRepoId });
      const res = await credentials(credentialRequest(await jobToken(jobId, harnessId)));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        cloneUrl: "https://github.com/acme/app.git",
        username: "x-access-token",
        password: "ghs_contents_read",
      });
      expect(tokenRequests.map((r) => r.body)).toEqual([
        { repositories: ["app"], permissions: { contents: "read" } },
      ]);
      expect(await issued(harnessId)).toHaveLength(1);
    });

    describe("write credentials", () => {
      const RALPH_SCOPES: JobTokenScope[] = [
        "credentials:read",
        "credentials:write",
        "run:activity",
        "run:attachments",
      ];
      // A legacy ralph job (no task): a `ralph.cleanup` queued before cleanups ran as `worktree.cleanup`.
      const ralphJob = {
        type: "ralph.cleanup",
        taskType: "coding",
      } as const;

      it("issues a GitLab write_repository token to a running ralph job and audits it as write", async () => {
        const harnessId = await newAgent();
        const jobId = await newJob({
          ...ralphJob,
          status: "running",
          harnessId,
          repositoryId: gitlabRepoId,
        });
        const res = await credentials(
          credentialRequest(await jobToken(jobId, harnessId, RALPH_SCOPES)),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as CloneCredentialResponse;
        expect(body).toMatchObject({
          cloneUrl: `${GITLAB}/group/sub/app.git`,
          username: "oauth2",
          password: "glpat-write-repository",
        });
        expect(tokenRequests.map((r) => r.body)).toEqual([
          expect.objectContaining({ scopes: ["write_repository"], access_level: 30 }),
        ]);
        const audit = await issued(harnessId);
        expect(audit).toHaveLength(1);
        expect(audit[0]!.detail).toMatchObject({
          jobId,
          access: "write",
          tokenKind: "legacy",
          expiresAt: body.expiresAt,
        });
      });

      it("issues a GitHub token limited to contents and workflows write on the one repo, expiring within an hour", async () => {
        const harnessId = await newAgent();
        const jobId = await newJob({
          ...ralphJob,
          status: "running",
          harnessId,
          repositoryId: githubRepoId,
        });
        const res = await credentials(
          credentialRequest(await jobToken(jobId, harnessId, RALPH_SCOPES)),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as CloneCredentialResponse;
        expect(body).toMatchObject({
          cloneUrl: "https://github.com/acme/app.git",
          username: "x-access-token",
          password: "ghs_contents_write",
        });
        expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(3_600_000);
        expect(tokenRequests.map((r) => r.body)).toEqual([
          { repositories: ["app"], permissions: { contents: "write", workflows: "write" } },
        ]);
        expect((await issued(harnessId))[0]!.detail).toMatchObject({ access: "write" });
      });

      it("gives a started ralph job's token a write credential", async () => {
        const harnessId = await newAgent({
          reportedAcceptedTaskTypes: ["coding"],
        });
        // Targeted at the harness, so the claim takes it before any other queued ralph job.
        const jobId = await newJob({
          ...ralphJob,
          status: "queued",
          repositoryId: githubRepoId,
          targetHarnessId: harnessId,
        });
        const accessToken = await getTokenSigner().signAccessToken(harnessId);
        const res = await claim(
          new Request("http://localhost/api/harness/claim", {
            method: "POST",
            headers: { authorization: `Bearer ${accessToken}`, "x-real-ip": "203.0.113.251" },
            body: JSON.stringify({ pools: ["long"], waitSeconds: 0 }),
          }),
        );
        const started = (await res.json()) as JobStartResponse;
        expect(started).toMatchObject({ action: "run", job: { id: jobId } });
        if (started.action !== "run") return;
        const cred = await credentials(credentialRequest(started.jobToken.token));
        expect(await cred.json()).toMatchObject({ password: "ghs_contents_write" });
      });

      it("never gives a review job a write credential, even with a forged token scope and request body", async () => {
        const harnessId = await newAgent();
        const readOnly = [
          [gitlabRepoId, "glpat-read-only"],
          [githubRepoId, "ghs_contents_read"],
        ] as const;
        for (const [repositoryId, password] of readOnly) {
          const jobId = await newJob({ status: "running", harnessId, repositoryId });
          const res = await credentials(
            credentialRequest(
              await jobToken(jobId, harnessId, ["credentials:read", "credentials:write"]),
              {
                access: "write",
                scopes: ["credentials:write"],
                permissions: { contents: "write" },
              },
            ),
          );
          expect(res.status).toBe(200);
          expect(await res.json()).toMatchObject({ password });
        }
        // Read tokens may come from the cache, but no write token was minted.
        for (const { body } of tokenRequests) {
          expect(JSON.stringify(body)).not.toMatch(/write/);
        }
        expect((await issued(harnessId)).map((e) => e.detail.access)).toEqual(["read", "read"]);
      });

      describe("run-spec jobs", () => {
        const WRITE: JobTokenScope[] = ["credentials:read", "credentials:write"];
        const codingTask = {
          type: "task.run",
          taskType: "coding",
          taskId: "builtin:story",
        } as const;

        async function passwordFor(
          job: Partial<typeof jobs.$inferInsert>,
          scopes: JobTokenScope[],
          kind?: RunTokenKind,
        ) {
          const harnessId = await newAgent();
          const jobId = await newJob({
            ...job,
            status: "running",
            harnessId,
            repositoryId: githubRepoId,
          });
          const res = await credentials(
            credentialRequest(await jobToken(jobId, harnessId, scopes, kind), { access: "write" }),
          );
          expect(res.status).toBe(200);
          return ((await res.json()) as CloneCredentialResponse).password;
        }

        it("gives a coding run-spec job's lifecycle token a write credential", async () => {
          expect(await passwordFor(codingTask, WRITE, "lifecycle")).toBe("ghs_contents_write");
        });

        it("always gives a session token a read-only credential, even with a forged credentials:write from a coding job", async () => {
          const forged: JobTokenScope[] = [...JOB_TOKEN_SCOPES];
          expect(await passwordFor(codingTask, forged, "session")).toBe("ghs_contents_read");
          for (const taskType of ["query", "review"] as const) {
            expect(await passwordFor({ ...codingTask, taskType }, forged, "session")).toBe(
              "ghs_contents_read",
            );
          }
          // Even a legacy ralph job never pushes with a session token.
          expect(await passwordFor({ ...ralphJob, taskId: null }, forged, "session")).toBe(
            "ghs_contents_read",
          );
        });

        it("keeps lifecycle tokens of non-coding run-spec jobs read-only", async () => {
          for (const taskType of ["query", "review"] as const) {
            expect(await passwordFor({ ...codingTask, taskType }, WRITE, "lifecycle")).toBe(
              "ghs_contents_read",
            );
          }
        });

        it("doesn't let a lifecycle token of a legacy ralph job, or a kind-less token of a run-spec job, push", async () => {
          expect(await passwordFor(ralphJob, WRITE, "lifecycle")).toBe("ghs_contents_read");
          expect(await passwordFor(codingTask, WRITE)).toBe("ghs_contents_read");
        });

        it("issues a write credential only with credentials:write", async () => {
          expect(await passwordFor(codingTask, ["credentials:read"], "lifecycle")).toBe(
            "ghs_contents_read",
          );
        });
      });

      describe("coding runs as advanceRun enqueues them", () => {
        function jobBase(runId: string) {
          return {
            runId,
            repositoryId: githubRepoId,
            repository: {
              provider: "github",
              fullPath: "acme/app",
              cloneUrl: "https://github.com/acme/app.git",
            },
            branch: "omniralph/tool-32-ralph",
            baseBranch: "main",
            settings: { model: null, setupCommand: null },
            epic: { identifier: "TOOL-32", title: "Ralph core", prd: "# PRD" },
            progress: "",
          };
        }
        const storyPayload = (runId: string) =>
          RalphStoryPayload.parse({
            ...jobBase(runId),
            storyId: randomUUID(),
            attempt: 1,
            story: {
              identifier: "TOOL-83",
              title: "Add the ralph capability",
              linearIssueId: "30ed0e14-6d6a-4dba-8962-4c010fca69af",
              description: "As a developer...",
            },
            commitMessage: "feat(TOOL-83): Add the ralph capability",
            qualityGates: ["pnpm test"],
            lastFeedback: null,
            guidance: [],
          });
        const requestPayload = (runId: string) =>
          RalphRequestPayload.parse({
            ...jobBase(runId),
            requests: [{ id: randomUUID(), text: "push this" }],
          });

        /**
         * Enqueues a job like `advanceRun`'s `enqueueStory`/`enqueueRequest`
         * (`codingJobInput`), claims it through
         * the claim route and returns the tokens the harness got.
         */
        async function claimRalphJob(type: "ralph.story" | "ralph.request") {
          const runId = randomUUID();
          const routed =
            type === "ralph.story"
              ? await codingJobInput(
                  { taskId: "builtin:implement-story", trigger: "linear.delegated" },
                  storyPayload(runId),
                  BUILTIN_PLAYBOOK_SOURCE,
                )
              : await codingJobInput(
                  { taskId: "builtin:handle-request", trigger: "linear.mention" },
                  requestPayload(runId),
                  BUILTIN_PLAYBOOK_SOURCE,
                );
          if (!routed) throw new Error("expected a coding task");
          return claimEnqueued({
            type,
            ...routed,
            repositoryId: githubRepoId,
            dedupeKey: `ralph-run:${runId}`,
          });
        }

        async function claimEnqueued(
          input: Omit<DispatchJobInput, "organizationId" | "targetHarnessId">,
        ) {
          // A current harness: query and review runs need a minimum version.
          const harnessId = await newAgent({
            reportedAcceptedTaskTypes: ["coding", "query", "review"],
            reportedVersion: "99.0.0",
          });
          const { job } = await new PostgresDispatcher({ db }).createAndPublish({
            ...input,
            organizationId: orgId,
            targetHarnessId: harnessId,
          });
          const accessToken = await getTokenSigner().signAccessToken(harnessId);
          const res = await claim(
            new Request("http://localhost/api/harness/claim", {
              method: "POST",
              headers: { authorization: `Bearer ${accessToken}`, "x-real-ip": "203.0.113.252" },
              body: JSON.stringify({ pools: ["long", "short"], waitSeconds: 0 }),
            }),
          );
          const started = (await res.json()) as JobStartResponse;
          expect(started).toMatchObject({ action: "run", job: { id: job.id } });
          if (started.action !== "run") throw new Error("expected run");
          return { harnessId, jobId: job.id, started };
        }

        /** The password the broker issues for `token`, and the audited access and token kind. */
        async function issuedFor(token: string, harnessId: string) {
          const before = (await issued(harnessId)).length;
          // A forged body never changes the access.
          const res = await credentials(credentialRequest(token, { access: "write" }));
          expect(res.status).toBe(200);
          const { password } = (await res.json()) as CloneCredentialResponse;
          const audit = await issued(harnessId);
          expect(audit).toHaveLength(before + 1);
          const { access, tokenKind } = audit.at(-1)!.detail;
          return { password, access, tokenKind };
        }

        it.each(["ralph.story", "ralph.request"] as const)(
          "gives a %s coding run's lifecycle token write and its session token read",
          async (type) => {
            const { harnessId, jobId, started } = await claimRalphJob(type);
            expect(started.job).toMatchObject({
              type,
              taskType: "coding",
              taskId: type === "ralph.story" ? "builtin:implement-story" : "builtin:handle-request",
            });
            expect(started.jobToken.kind).toBe("lifecycle");
            expect(started.sessionToken?.kind).toBe("session");
            expect(await issuedFor(started.jobToken.token, harnessId)).toEqual({
              password: "ghs_contents_write",
              access: "write",
              tokenKind: "lifecycle",
            });
            expect(await issuedFor(started.sessionToken!.token, harnessId)).toEqual({
              password: "ghs_contents_read",
              access: "read",
              tokenKind: "session",
            });
            expect((await issued(harnessId)).every((e) => e.detail.jobId === jobId)).toBe(true);
          },
        );

        it("gives a worktree.cleanup system RPC's lifecycle token write", async () => {
          const runId = randomUUID();
          const laneId = randomUUID();
          const { harnessId, started } = await claimEnqueued({
            type: "worktree.cleanup",
            ...legacyJobRouting("worktree.cleanup"),
            payload: WorktreeCleanupPayload.parse({
              ...jobBase(runId),
              epic: { identifier: "TOOL-32" },
              action: { kind: "branch", push: true },
            }),
            repositoryId: githubRepoId,
            dedupeKey: `ralph-cleanup:${laneId}`,
          });
          expect(started.job).toMatchObject({
            type: "worktree.cleanup",
            taskType: "system",
            taskId: null,
          });
          expect(started.sessionToken).toBeUndefined();
          expect(started.jobToken.kind).toBe("lifecycle");
          expect(await issuedFor(started.jobToken.token, harnessId)).toEqual({
            password: "ghs_contents_write",
            access: "write",
            tokenKind: "lifecycle",
          });
        });

        it("gives the lifecycle tokens of the other system RPCs read", async () => {
          const runId = randomUUID();
          const commands = ["terraform init"];
          const exec = await claimEnqueued({
            type: "worktree.exec",
            ...legacyJobRouting("worktree.exec"),
            payload: WorktreeExecPayload.parse({
              ...jobBase(runId),
              story: { identifier: "TOOL-40", title: "Create the bucket" },
              commands,
              commandsHash: preparationHash(commands),
              approvedHeadSha: null,
            }),
            repositoryId: githubRepoId,
            dedupeKey: `ralph-run:${runId}`,
          });
          const sync = await claimEnqueued({
            type: "repo.sync",
            ...legacyJobRouting("repo.sync"),
            payload: RepoSyncPayload.parse({ repository: jobBase(runId).repository }),
            repositoryId: githubRepoId,
          });
          for (const { harnessId, started } of [exec, sync]) {
            expect(started.job).toMatchObject({ taskType: "system", taskId: null });
            expect(started.sessionToken).toBeUndefined();
            expect(await issuedFor(started.jobToken.token, harnessId)).toEqual({
              password: "ghs_contents_read",
              access: "read",
              tokenKind: "lifecycle",
            });
            // Even a token claiming credentials:write gets read: only worktree.cleanup may push.
            const forged = await getTokenSigner().signJobToken({
              jobId: started.job.id,
              harnessId,
              scopes: ["credentials:read", "credentials:write"],
              kind: "lifecycle",
            });
            expect(await issuedFor(forged, harnessId)).toMatchObject({ access: "read" });
          }
          for (const { body } of tokenRequests) {
            expect(JSON.stringify(body)).not.toMatch(/write/);
          }
        });

        it("gives the lifecycle and session tokens of query and review runs read", async () => {
          const describePr = getBuiltinTask("builtin:describe-pr")!;
          const query = await claimEnqueued({
            type: "task.run",
            ...runSpecJobInput(describePr, {
              trigger: { kind: "run.invoked", context: {} },
              repositoryId: githubRepoId,
            }),
          });
          expect(query.started.job.taskType).toBe("query");
          // A review run's claim needs its whole review context: sign its
          // tokens as the claim does instead.
          const reviewHarnessId = await newAgent();
          const reviewPr = getBuiltinTask("builtin:review-pr")!;
          const reviewJob = {
            id: await newJob({
              type: "task.run",
              taskType: reviewPr.taskType,
              taskId: reviewPr.id,
              status: "running",
              harnessId: reviewHarnessId,
              repositoryId: githubRepoId,
            }),
            type: "task.run",
            taskType: reviewPr.taskType,
            taskId: reviewPr.id,
          };
          const runs = [
            { harnessId: query.harnessId, tokens: query.started },
            { harnessId: reviewHarnessId, tokens: await signJobTokens(reviewJob, reviewHarnessId) },
          ];
          for (const { harnessId, tokens } of runs) {
            for (const token of [tokens.jobToken, tokens.sessionToken!]) {
              expect(await issuedFor(token.token, harnessId)).toEqual({
                password: "ghs_contents_read",
                access: "read",
                tokenKind: token.kind,
              });
            }
          }
          for (const { body } of tokenRequests) {
            expect(JSON.stringify(body)).not.toMatch(/write/);
          }
        });
      });

      it("answers 403 scm_permission_missing when the GitHub installation lacks Contents: Read and write", async () => {
        server.use(
          http.post("https://api.github.com/app/installations/4343/access_tokens", () =>
            HttpResponse.json(
              {
                message:
                  "The level of access for permissions requested are not granted to this installation.",
                status: "422",
              },
              { status: 422 },
            ),
          ),
        );
        const github = (await upsertScmConnection(db, {
          organizationId: orgId,
          provider: "github",
          name: "readonly",
          baseUrl: "https://api.github.com",
          externalId: "4343",
          credentials: {},
        }))!;
        const repositoryId = (
          await connectRepository(db, {
            connectionId: github.id,
            provider: "github",
            externalId: "101",
            fullPath: "readonly/app",
          })
        ).id;
        const harnessId = await newAgent();
        const jobId = await newJob({ ...ralphJob, status: "running", harnessId, repositoryId });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const res = await credentials(
          credentialRequest(await jobToken(jobId, harnessId, RALPH_SCOPES)),
        );
        warn.mockRestore();
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: string; message: string };
        expect(body.error).toBe("scm_permission_missing");
        expect(body.message).toContain("Contents: Read and write");
        expect(await issued(harnessId)).toHaveLength(0);
      });

      it("answers 403 scm_permission_missing when the GitLab bot token can't create project access tokens", async () => {
        server.use(
          http.post(`${GITLAB}/api/v4/projects/79/access_tokens`, () =>
            HttpResponse.json(
              { message: "400 User does not have permission to create project access token" },
              { status: 400 },
            ),
          ),
        );
        const repositoryId = (
          await connectRepository(db, {
            connectionId: gitlabConnectionId,
            provider: "gitlab",
            externalId: "79",
            fullPath: "group/no-mint",
          })
        ).id;
        const harnessId = await newAgent();
        const jobId = await newJob({ status: "running", harnessId, repositoryId });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const res = await credentials(credentialRequest(await jobToken(jobId, harnessId)));
        warn.mockRestore();
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: string; message: string };
        expect(body.error).toBe("scm_permission_missing");
        expect(body.message).toMatch(
          /service account's \(or real user's\) personal access token with the Maintainer role/,
        );
        expect(await issued(harnessId)).toHaveLength(0);
      });

      it("gives a ralph job whose token lacks credentials:write only a read credential", async () => {
        const harnessId = await newAgent();
        const jobId = await newJob({
          ...ralphJob,
          status: "running",
          harnessId,
          repositoryId: githubRepoId,
        });
        const res = await credentials(credentialRequest(await jobToken(jobId, harnessId)));
        expect(await res.json()).toMatchObject({ password: "ghs_contents_read" });
        expect((await issued(harnessId))[0]!.detail).toMatchObject({ access: "read" });
      });

      it("refuses ralph job tokens whose job isn't running on that harness, or that expired", async () => {
        const harnessId = await newAgent();
        const other = await newAgent();
        const jobIds = [
          await newJob({ ...ralphJob, status: "queued", repositoryId: githubRepoId }),
          await newJob({ ...ralphJob, status: "completed", harnessId, repositoryId: githubRepoId }),
          await newJob({
            ...ralphJob,
            status: "running",
            harnessId: other,
            repositoryId: githubRepoId,
          }),
        ];
        for (const jobId of jobIds) {
          const res = await credentials(
            credentialRequest(await jobToken(jobId, harnessId, RALPH_SCOPES)),
          );
          expect(res.status).toBe(401);
        }

        const running = await newJob({
          ...ralphJob,
          status: "running",
          harnessId,
          repositoryId: githubRepoId,
        });
        const expired = await new LocalTokenSigner({
          privateKey: signingKey,
          now: () => Date.now() - 24 * 3_600_000,
        }).signJobToken({ jobId: running, harnessId, scopes: RALPH_SCOPES });
        expect((await credentials(credentialRequest(expired))).status).toBe(401);

        expect(tokenRequests).toHaveLength(0);
        expect(await issued(harnessId)).toHaveLength(0);
      });
    });

    it("rejects jobs that aren't running on the token's harness with 401", async () => {
      const harnessId = await newAgent();
      const other = await newAgent();
      const cases = [
        await newJob({ status: "queued", repositoryId: gitlabRepoId }),
        await newJob({ status: "completed", harnessId, repositoryId: gitlabRepoId }),
        await newJob({ status: "failed", harnessId, repositoryId: gitlabRepoId }),
        await newJob({ status: "canceled", harnessId, repositoryId: gitlabRepoId }),
        // Redelivered to (and now running on) another harness.
        await newJob({ status: "running", harnessId: other, repositoryId: gitlabRepoId }),
      ];
      for (const jobId of cases) {
        const res = await credentials(credentialRequest(await jobToken(jobId, harnessId)));
        expect(res.status).toBe(401);
      }
      expect(tokenRequests).toHaveLength(0);
      expect(await issued(harnessId)).toHaveLength(0);
    });

    it("rejects missing, harness and unscoped tokens and revoked harnesses with 401", async () => {
      const harnessId = await newAgent();
      const jobId = await newJob({ status: "running", harnessId, repositoryId: gitlabRepoId });
      const accessToken = await getTokenSigner().signAccessToken(harnessId);
      for (const token of [
        undefined,
        "garbage",
        accessToken,
        await jobToken(jobId, harnessId, []),
      ]) {
        expect((await credentials(credentialRequest(token))).status).toBe(401);
      }
      const valid = await jobToken(jobId, harnessId);
      await db.update(harnesses).set({ revokedAt: new Date() }).where(eq(harnesses.id, harnessId));
      expect((await credentials(credentialRequest(valid))).status).toBe(401);
      expect(tokenRequests).toHaveLength(0);
    });

    it("refuses jobs without a repository or with a disconnected one with 403", async () => {
      const harnessId = await newAgent();
      const noRepo = await newJob({ status: "running", harnessId });
      expect((await credentials(credentialRequest(await jobToken(noRepo, harnessId)))).status).toBe(
        403,
      );
      const disconnected = await newJob({
        status: "running",
        harnessId,
        repositoryId: disconnectedRepoId,
      });
      const res = await credentials(credentialRequest(await jobToken(disconnected, harnessId)));
      expect(res.status).toBe(403);
      expect(tokenRequests).toHaveLength(0);
      expect(await issued(harnessId)).toHaveLength(0);
    });
  });

  describe("pinning a repository", () => {
    it("pins and enqueues repo.sync targeted at the harness, which it can run and get credentials for", async () => {
      const harnessId = await newAgent({ reportedAcceptedTaskTypes: [] });
      const dispatcher = new PostgresDispatcher({ db });
      const pinned = await pinRepository(db, dispatcher, { harnessId, repositoryId: gitlabRepoId });
      expect(pinned.result).toBe("pinned");
      const pins = await db
        .select()
        .from(harnessRepoPins)
        .where(
          and(
            eq(harnessRepoPins.harnessId, harnessId),
            eq(harnessRepoPins.repositoryId, gitlabRepoId),
          ),
        );
      expect(pins).toHaveLength(1);
      const syncJobs = () =>
        db
          .select()
          .from(jobs)
          .where(and(eq(jobs.type, "repo.sync"), eq(jobs.targetHarnessId, harnessId)));
      const [job, ...others] = await syncJobs();
      expect(others).toHaveLength(0);
      expect(job).toMatchObject({
        id: pinned.syncJobId,
        type: "repo.sync",
        taskType: "system",
        status: "queued",
        targetHarnessId: harnessId,
        repositoryId: gitlabRepoId,
        payload: {
          repository: {
            provider: "gitlab",
            fullPath: "group/sub/app",
            cloneUrl: `${GITLAB}/group/sub/app.git`,
          },
        },
      });

      // Pinning again while the sync is queued doesn't enqueue a second one.
      const again = await pinRepository(db, dispatcher, { harnessId, repositoryId: gitlabRepoId });
      expect(again).toEqual({ result: "already_pinned", syncJobId: pinned.syncJobId });
      expect(await syncJobs()).toHaveLength(1);

      // The harness runs it although it accepts no task types (system jobs always run)...
      const accessToken = await getTokenSigner().signAccessToken(harnessId);
      const res = await claim(
        new Request("http://localhost/api/harness/claim", {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "x-real-ip": "203.0.113.250" },
          body: JSON.stringify({ pools: [], waitSeconds: 0 }),
        }),
      );
      const started = (await res.json()) as JobStartResponse;
      expect(started).toMatchObject({ action: "run", job: { id: pinned.syncJobId } });
      if (started.action !== "run") return;
      // ...and its git-credential helper gets a read-only credential with the job token.
      const cred = await credentials(credentialRequest(started.jobToken.token));
      expect(cred.status).toBe(200);
      expect(await issued(harnessId)).toHaveLength(1);
    });

    it("refuses revoked harnesses and disconnected repositories", async () => {
      const dispatcher = new PostgresDispatcher({ db });
      const syncJobs = () => db.select().from(jobs).where(eq(jobs.type, "repo.sync"));
      const before = (await syncJobs()).length;
      const revoked = await newAgent({ revokedAt: new Date() });
      expect(
        await pinRepository(db, dispatcher, { harnessId: revoked, repositoryId: githubRepoId }),
      ).toEqual({
        result: "unknown_agent",
      });
      const harnessId = await newAgent();
      expect(
        await pinRepository(db, dispatcher, { harnessId, repositoryId: disconnectedRepoId }),
      ).toEqual({ result: "unknown_repository" });
      expect(await syncJobs()).toHaveLength(before);
    });
  });
});
