import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  agents,
  connectRepository,
  closeDb,
  createDb,
  createRun,
  jobs,
  runMigrations,
  updateRun,
  upsertScmConnection,
  type Database,
} from "@omniralph/db";
import { CAPABILITY_JOB_SCOPES, type JobTokenScope } from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  linear: undefined as unknown as FakeLinearGateway,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/linear/client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getLinearGateway: async () => state.linear,
}));

const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
delete process.env.KMS_AGENT_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = signingKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const { getTokenSigner } = await import("@/lib/agent-auth/signer");
const { GET: download } = await import("./jobs/[id]/attachments/[attachmentId]/route");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

let ipCounter = 0;
function downloadRequest(jobId: string, attachmentId: string, token: string | undefined) {
  ipCounter += 1;
  return download(
    new Request(`http://localhost/api/agent/jobs/${jobId}/attachments/${attachmentId}`, {
      headers: {
        ...(token && { authorization: `Bearer ${token}` }),
        "x-real-ip": `198.51.100.${ipCounter}`,
      },
    }),
    { params: Promise.resolve({ id: jobId, attachmentId }) },
  );
}

const UPLOAD = "https://uploads.linear.app/org/a1b2/shot";
const ID = "a".repeat(32);
const OTHER = "b".repeat(32);

describe.skipIf(!dockerAvailable)("GET /api/agent/jobs/{id}/attachments/{attachmentId}", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let repositoryId: string;
  let agentId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    state.db = db;
    const connection = await upsertScmConnection(db, {
      provider: "gitlab",
      name: "bot",
      baseUrl: "https://gitlab.example.com",
      externalId: "5",
      credentials: { token: "glpat", webhookSecret: "hook" },
    });
    repositoryId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "gitlab",
        externalId: "77",
        fullPath: "group/app",
      })
    ).id;
    const [agent] = await db
      .insert(agents)
      .values({ name: "coder-1", enabledCapabilities: ["review", "ralph"] })
      .returning();
    agentId = agent!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  beforeEach(() => {
    state.linear = new FakeLinearGateway();
    state.linear.uploads.set(UPLOAD, { contentType: "image/png", body: "PNGDATA" });
  });

  /** A run that knows the upload as `ID` and `OTHER`, and a running story job listing `listed`. */
  async function newJob(listed: string[] = [ID], values: Partial<typeof jobs.$inferInsert> = {}) {
    const { run } = await createRun(db, {
      linearIssueId: randomUUID(),
      linearIdentifier: "TOOL-32",
      linearAgentSessionId: `session-${randomUUID()}`,
      kind: "children",
      repositoryId,
      branch: "feat/tool-32",
      baseBranch: "main",
    });
    await updateRun(db, run.id, {
      attachments: {
        [ID]: { url: UPLOAD, title: "shot.png" },
        [OTHER]: { url: UPLOAD, title: "shot.png" },
      },
    });
    const [job] = await db
      .insert(jobs)
      .values({
        capability: "ralph",
        type: "ralph.story",
        status: "running",
        agentId,
        repositoryId,
        ralphRunId: run.id,
        payload: { attachments: listed.map((id) => ({ id, title: "shot.png", sources: ["x"] })) },
        ...values,
      })
      .returning();
    return job!.id;
  }

  function token(jobId: string, scopes: JobTokenScope[] = CAPABILITY_JOB_SCOPES.ralph) {
    return getTokenSigner().signJobToken({ jobId, agentId, scopes });
  }

  it("streams a listed attachment from Linear", async () => {
    const jobId = await newJob();
    const res = await downloadRequest(jobId, ID, await token(jobId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("PNGDATA");
    expect(state.linear.downloads).toEqual([UPLOAD]);
  });

  it("requires a running job's own token with ralph:attachments", async () => {
    const jobId = await newJob();
    expect((await downloadRequest(jobId, ID, undefined)).status).toBe(401);
    const access = await getTokenSigner().signAccessToken(agentId);
    expect((await downloadRequest(jobId, ID, access)).status).toBe(401);
    const noScope = await token(jobId, ["credentials:read", "ralph:activity"]);
    expect((await downloadRequest(jobId, ID, noScope)).status).toBe(401);
    const done = await newJob([ID], { status: "completed" });
    expect((await downloadRequest(done, ID, await token(done))).status).toBe(401);
    const other = await newJob();
    const res = await downloadRequest(jobId, ID, await token(other));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "job_mismatch" });
    expect(state.linear.downloads).toEqual([]);
  });

  it("only serves attachments listed in the job's payload, to ralph jobs", async () => {
    const jobId = await newJob([ID]);
    // Known to the run, but not in this job's payload.
    const res = await downloadRequest(jobId, OTHER, await token(jobId));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "attachment_not_in_job" });
    expect((await downloadRequest(jobId, "not-an-id", await token(jobId))).status).toBe(404);
    // Listed, but unknown to the run.
    const unknown = "c".repeat(32);
    const listedOnly = await newJob([unknown]);
    expect((await downloadRequest(listedOnly, unknown, await token(listedOnly))).status).toBe(404);
    // A review job, even with a forged scope.
    const review = await newJob([ID], { capability: "review", type: "review.run" });
    const forged = await token(review, ["credentials:read", "ralph:attachments"]);
    const reviewRes = await downloadRequest(review, ID, forged);
    expect(reviewRes.status).toBe(403);
    expect(await reviewRes.json()).toEqual({ error: "not_a_ralph_job" });
    expect(state.linear.downloads).toEqual([]);
  });

  it("rejects error statuses, HTML pages and files over 25 MB", async () => {
    const jobId = await newJob();
    const jobToken = await token(jobId);
    state.linear.uploads.set(UPLOAD, { contentType: "image/png", body: "", status: 401 });
    let res = await downloadRequest(jobId, ID, jobToken);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "download_failed", reason: "HTTP 401" });

    state.linear.uploads.set(UPLOAD, { contentType: "text/html", body: "<html>sign in</html>" });
    res = await downloadRequest(jobId, ID, jobToken);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "download_failed",
      reason: "got an HTML page instead of the file",
    });

    state.linear.uploads.set(UPLOAD, {
      contentType: "image/png",
      body: new Uint8Array(25 * 1024 * 1024 + 1),
    });
    res = await downloadRequest(jobId, ID, jobToken);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "download_failed", reason: "larger than 25 MB" });
  });

  it("answers 502 when Linear can't be reached", async () => {
    const jobId = await newJob();
    state.linear.failures.set("downloadUpload", new Error("Linear is down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await downloadRequest(jobId, ID, await token(jobId));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "download_failed", reason: "Linear is down" });
    error.mockRestore();
  });
});
