import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  agentRepoPins,
  agents,
  connectRepository,
  createDb,
  jobs,
  listAgentAudit,
  repositories,
  runMigrations,
  upsertScmConnection,
  type Database,
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
  sends: [] as { topic: string; payload: unknown; options: unknown }[],
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@vercel/queue", () => ({
  QueueClient: class {
    async send(topic: string, payload: unknown, options: unknown) {
      state.sends.push({ topic, payload, options });
      return { messageId: `msg-${state.sends.length}` };
    }
  },
}));

const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
delete process.env.KMS_AGENT_ISSUER_ID;
delete process.env.GITHUB_APP_KMS_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = signingKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.QUEUE_REGIONS = "iad1";
process.env.GITHUB_APP_ID = "12345";
process.env.GITHUB_APP_PRIVATE_KEY = appKey.export({ type: "pkcs8", format: "pem" }).toString();
process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";

const { getTokenSigner, LocalTokenSigner } = await import("@/lib/agent-auth/signer");
const { VercelQueuesDispatcher } = await import("@/lib/dispatch");
const { pinRepository } = await import("@/lib/agents/pins");
const { POST: credentials } = await import("./credentials/route");
const { POST: start } = await import("./jobs/[id]/start/route");

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
  return new Request("http://localhost/api/agent/credentials", {
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
  let gitlabRepoId: string;
  let githubRepoId: string;
  let disconnectedRepoId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    state.db = db;
    server.listen({ onUnhandledFrame: "error" });

    const gitlab = await upsertScmConnection(db, {
      provider: "gitlab",
      name: "bot @ gitlab.example.com",
      baseUrl: GITLAB,
      externalId: "5",
      credentials: { token: "glpat-bot-api", webhookSecret: "hook" },
    });
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
    const github = await upsertScmConnection(db, {
      provider: "github",
      name: "acme",
      baseUrl: "https://api.github.com",
      externalId: "4242",
      credentials: {},
    });
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
    await db?.$client.end();
    await container?.stop();
  });

  beforeEach(() => {
    tokenRequests.length = 0;
    state.sends.length = 0;
  });

  async function newAgent(values: Partial<typeof agents.$inferInsert> = {}) {
    const [agent] = await db
      .insert(agents)
      .values({ name: "coder-1", ...values })
      .returning();
    return agent!.id;
  }

  async function newJob(values: Partial<typeof jobs.$inferInsert>) {
    const [job] = await db
      .insert(jobs)
      .values({ capability: "review", type: "review.run", ...values })
      .returning();
    return job!.id;
  }

  function jobToken(
    jobId: string,
    agentId: string,
    scopes: JobTokenScope[] = ["credentials:read"],
  ) {
    return getTokenSigner().signJobToken({ jobId, agentId, scopes });
  }

  async function issued(agentId: string) {
    return listAgentAudit(db, { agentId, event: "credential_issued" });
  }

  describe("POST /api/agent/credentials", () => {
    it("issues a read-only GitLab credential for a running job's repo and audits it", async () => {
      const agentId = await newAgent();
      const jobId = await newJob({ status: "running", agentId, repositoryId: gitlabRepoId });
      const res = await credentials(credentialRequest(await jobToken(jobId, agentId)));
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

      const audit = await issued(agentId);
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
      const agentId = await newAgent();
      const jobId = await newJob({ status: "running", agentId, repositoryId: githubRepoId });
      const res = await credentials(credentialRequest(await jobToken(jobId, agentId)));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        cloneUrl: "https://github.com/acme/app.git",
        username: "x-access-token",
        password: "ghs_contents_read",
      });
      expect(tokenRequests.map((r) => r.body)).toEqual([
        { repositories: ["app"], permissions: { contents: "read" } },
      ]);
      expect(await issued(agentId)).toHaveLength(1);
    });

    describe("write credentials", () => {
      const RALPH_SCOPES = CAPABILITY_JOB_SCOPES.ralph;
      const ralphJob = { capability: "ralph", type: "ralph.story" } as const;

      it("issues a GitLab write_repository token to a running ralph job and audits it as write", async () => {
        const agentId = await newAgent();
        const jobId = await newJob({
          ...ralphJob,
          status: "running",
          agentId,
          repositoryId: gitlabRepoId,
        });
        const res = await credentials(
          credentialRequest(await jobToken(jobId, agentId, RALPH_SCOPES)),
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
        const audit = await issued(agentId);
        expect(audit).toHaveLength(1);
        expect(audit[0]!.detail).toMatchObject({
          jobId,
          access: "write",
          expiresAt: body.expiresAt,
        });
      });

      it("issues a GitHub token limited to contents: write on the one repo, expiring within an hour", async () => {
        const agentId = await newAgent();
        const jobId = await newJob({
          ...ralphJob,
          status: "running",
          agentId,
          repositoryId: githubRepoId,
        });
        const res = await credentials(
          credentialRequest(await jobToken(jobId, agentId, RALPH_SCOPES)),
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
          { repositories: ["app"], permissions: { contents: "write" } },
        ]);
        expect((await issued(agentId))[0]!.detail).toMatchObject({ access: "write" });
      });

      it("gives a started ralph job's token a write credential", async () => {
        const agentId = await newAgent({ enabledCapabilities: ["ralph"] });
        const jobId = await newJob({ ...ralphJob, status: "queued", repositoryId: githubRepoId });
        const accessToken = await getTokenSigner().signAccessToken(agentId);
        const res = await start(
          new Request(`http://localhost/api/agent/jobs/${jobId}/start`, {
            method: "POST",
            headers: { authorization: `Bearer ${accessToken}`, "x-real-ip": "203.0.113.251" },
          }),
          { params: Promise.resolve({ id: jobId }) },
        );
        const started = (await res.json()) as JobStartResponse;
        expect(started.action).toBe("run");
        if (started.action !== "run") return;
        const cred = await credentials(credentialRequest(started.jobToken.token));
        expect(await cred.json()).toMatchObject({ password: "ghs_contents_write" });
      });

      it("never gives a review job a write credential, even with a forged token scope and request body", async () => {
        const agentId = await newAgent();
        const readOnly = [
          [gitlabRepoId, "glpat-read-only"],
          [githubRepoId, "ghs_contents_read"],
        ] as const;
        for (const [repositoryId, password] of readOnly) {
          const jobId = await newJob({ status: "running", agentId, repositoryId });
          const res = await credentials(
            credentialRequest(
              await jobToken(jobId, agentId, ["credentials:read", "credentials:write"]),
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
        expect((await issued(agentId)).map((e) => e.detail.access)).toEqual(["read", "read"]);
      });

      it("gives a ralph job whose token lacks credentials:write only a read credential", async () => {
        const agentId = await newAgent();
        const jobId = await newJob({
          ...ralphJob,
          status: "running",
          agentId,
          repositoryId: githubRepoId,
        });
        const res = await credentials(credentialRequest(await jobToken(jobId, agentId)));
        expect(await res.json()).toMatchObject({ password: "ghs_contents_read" });
        expect((await issued(agentId))[0]!.detail).toMatchObject({ access: "read" });
      });

      it("refuses ralph job tokens whose job isn't running on that agent, or that expired", async () => {
        const agentId = await newAgent();
        const other = await newAgent();
        const jobIds = [
          await newJob({ ...ralphJob, status: "queued", repositoryId: githubRepoId }),
          await newJob({ ...ralphJob, status: "completed", agentId, repositoryId: githubRepoId }),
          await newJob({
            ...ralphJob,
            status: "running",
            agentId: other,
            repositoryId: githubRepoId,
          }),
        ];
        for (const jobId of jobIds) {
          const res = await credentials(
            credentialRequest(await jobToken(jobId, agentId, RALPH_SCOPES)),
          );
          expect(res.status).toBe(401);
        }

        const running = await newJob({
          ...ralphJob,
          status: "running",
          agentId,
          repositoryId: githubRepoId,
        });
        const expired = await new LocalTokenSigner({
          privateKey: signingKey,
          now: () => Date.now() - 24 * 3_600_000,
        }).signJobToken({ jobId: running, agentId, scopes: RALPH_SCOPES });
        expect((await credentials(credentialRequest(expired))).status).toBe(401);

        expect(tokenRequests).toHaveLength(0);
        expect(await issued(agentId)).toHaveLength(0);
      });
    });

    it("rejects jobs that aren't running on the token's agent with 401", async () => {
      const agentId = await newAgent();
      const other = await newAgent();
      const cases = [
        await newJob({ status: "queued", repositoryId: gitlabRepoId }),
        await newJob({ status: "completed", agentId, repositoryId: gitlabRepoId }),
        await newJob({ status: "failed", agentId, repositoryId: gitlabRepoId }),
        await newJob({ status: "canceled", agentId, repositoryId: gitlabRepoId }),
        // Redelivered to (and now running on) another agent.
        await newJob({ status: "running", agentId: other, repositoryId: gitlabRepoId }),
      ];
      for (const jobId of cases) {
        const res = await credentials(credentialRequest(await jobToken(jobId, agentId)));
        expect(res.status).toBe(401);
      }
      expect(tokenRequests).toHaveLength(0);
      expect(await issued(agentId)).toHaveLength(0);
    });

    it("rejects missing, agent and unscoped tokens and revoked agents with 401", async () => {
      const agentId = await newAgent();
      const jobId = await newJob({ status: "running", agentId, repositoryId: gitlabRepoId });
      const accessToken = await getTokenSigner().signAccessToken(agentId);
      for (const token of [undefined, "garbage", accessToken, await jobToken(jobId, agentId, [])]) {
        expect((await credentials(credentialRequest(token))).status).toBe(401);
      }
      const valid = await jobToken(jobId, agentId);
      await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, agentId));
      expect((await credentials(credentialRequest(valid))).status).toBe(401);
      expect(tokenRequests).toHaveLength(0);
    });

    it("refuses jobs without a repository or with a disconnected one with 403", async () => {
      const agentId = await newAgent();
      const noRepo = await newJob({ status: "running", agentId });
      expect((await credentials(credentialRequest(await jobToken(noRepo, agentId)))).status).toBe(
        403,
      );
      const disconnected = await newJob({
        status: "running",
        agentId,
        repositoryId: disconnectedRepoId,
      });
      const res = await credentials(credentialRequest(await jobToken(disconnected, agentId)));
      expect(res.status).toBe(403);
      expect(tokenRequests).toHaveLength(0);
      expect(await issued(agentId)).toHaveLength(0);
    });
  });

  describe("pinning a repository", () => {
    it("pins and enqueues repo.sync on the agent's system topic, which it can run and get credentials for", async () => {
      const agentId = await newAgent({ enabledCapabilities: [] });
      const dispatcher = new VercelQueuesDispatcher({ db });
      const pinned = await pinRepository(db, dispatcher, { agentId, repositoryId: gitlabRepoId });
      expect(pinned.result).toBe("pinned");
      const pins = await db
        .select()
        .from(agentRepoPins)
        .where(
          and(eq(agentRepoPins.agentId, agentId), eq(agentRepoPins.repositoryId, gitlabRepoId)),
        );
      expect(pins).toHaveLength(1);
      expect(state.sends).toEqual([
        {
          topic: `system-jobs-agent-${agentId}`,
          payload: { jobId: pinned.syncJobId },
          options: { idempotencyKey: pinned.syncJobId, retentionSeconds: 86_400 },
        },
      ]);
      const [job] = await db.select().from(jobs).where(eq(jobs.id, pinned.syncJobId!));
      expect(job).toMatchObject({
        capability: "system",
        type: "repo.sync",
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
      const again = await pinRepository(db, dispatcher, { agentId, repositoryId: gitlabRepoId });
      expect(again).toEqual({ result: "already_pinned", syncJobId: pinned.syncJobId });
      expect(state.sends).toHaveLength(1);

      // The agent runs it although no capability is enabled for it (system is built in)...
      const accessToken = await getTokenSigner().signAccessToken(agentId);
      const res = await start(
        new Request(`http://localhost/api/agent/jobs/${pinned.syncJobId}/start`, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "x-real-ip": "203.0.113.250" },
        }),
        { params: Promise.resolve({ id: pinned.syncJobId! }) },
      );
      const started = (await res.json()) as JobStartResponse;
      expect(started.action).toBe("run");
      if (started.action !== "run") return;
      // ...and its git-credential helper gets a read-only credential with the job token.
      const cred = await credentials(credentialRequest(started.jobToken.token));
      expect(cred.status).toBe(200);
      expect(await issued(agentId)).toHaveLength(1);
    });

    it("refuses revoked agents and disconnected repositories", async () => {
      const dispatcher = new VercelQueuesDispatcher({ db });
      const revoked = await newAgent({ revokedAt: new Date() });
      expect(
        await pinRepository(db, dispatcher, { agentId: revoked, repositoryId: githubRepoId }),
      ).toEqual({
        result: "unknown_agent",
      });
      const agentId = await newAgent();
      expect(
        await pinRepository(db, dispatcher, { agentId, repositoryId: disconnectedRepoId }),
      ).toEqual({ result: "unknown_repository" });
      expect(state.sends).toHaveLength(0);
    });
  });
});
