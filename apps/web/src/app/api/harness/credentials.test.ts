import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  harnessRepoPins,
  harnesses,
  connectRepository,
  closeDb,
  createDb,
  jobs,
  listHarnessAudit,
  repositories,
  runMigrations,
  upsertScmConnection,
  type Database,
  organizations,
  seedReviewProfiles,
} from "@omniralph/db";
import {
  CAPABILITY_JOB_SCOPES,
  type CloneCredentialResponse,
  type JobStartResponse,
  type JobTokenScope,
} from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { getContainerRuntimeClient } from "testcontainers";
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

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

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

describe.skipIf(!dockerAvailable)("credential broker and repo pinning", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let gitlabConnectionId: string;
  let gitlabRepoId: string;
  let githubRepoId: string;
  let disconnectedRepoId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
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
    await container?.stop();
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
      .values({ organizationId: orgId, capability: "review", type: "review.run", ...values })
      .returning();
    return job!.id;
  }

  function jobToken(
    jobId: string,
    harnessId: string,
    scopes: JobTokenScope[] = ["credentials:read"],
  ) {
    return getTokenSigner().signJobToken({ jobId, harnessId, scopes });
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
      const RALPH_SCOPES = CAPABILITY_JOB_SCOPES.ralph;
      const ralphJob = { capability: "ralph", type: "ralph.story" } as const;

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
        const harnessId = await newAgent({ enabledCapabilities: ["ralph"] });
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
            body: JSON.stringify({ capabilities: ["ralph"], waitSeconds: 0 }),
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
                capability: "ralph",
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
      const harnessId = await newAgent({ enabledCapabilities: [] });
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
        capability: "system",
        type: "repo.sync",
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

      // The harness runs it although no capability is enabled for it (system is built in)...
      const accessToken = await getTokenSigner().signAccessToken(harnessId);
      const res = await claim(
        new Request("http://localhost/api/harness/claim", {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "x-real-ip": "203.0.113.250" },
          body: JSON.stringify({ capabilities: ["system"], waitSeconds: 0 }),
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
