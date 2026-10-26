import { generateKeyPairSync, randomBytes } from "node:crypto";
import { InvalidInputLinearError } from "@linear/sdk";
import { agents, closeDb, createDb, jobs, type Database, organizations } from "@omniralph/db";
import type { JobTokenScope } from "@omniralph/shared";
import type * as Tasks from "@omniralph/tasks";
import type * as LinearClient from "@/lib/linear/client";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";

const SESSION_SCOPES: JobTokenScope[] = [
  "credentials:read",
  "run:activity",
  "run:attachments",
  "linear:read",
];

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  linear: undefined as unknown as FakeLinearGateway,
  /** The organization of every gateway asked for. */
  gatewayOrgs: [] as string[],
  notConnected: false,
  /** Gateways of organizations other than the default one, by organization ID. */
  gatewaysByOrg: new Map<string, FakeLinearGateway>(),
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/linear/client", async (original) => {
  const client = await original<typeof LinearClient>();
  return {
    ...client,
    getLinearGateway: async ({ organizationId }: { organizationId: string }) => {
      state.gatewayOrgs.push(organizationId);
      if (state.notConnected) throw new client.LinearNotConnectedError();
      return state.gatewaysByOrg.get(organizationId) ?? state.linear;
    },
  };
});
vi.mock("@omniralph/tasks", async (importOriginal) => {
  const tasks = await importOriginal<typeof Tasks>();
  const playbook = (
    id: string,
    linearRead: boolean,
    linear: Tasks.LinearTool[] = [
      "linear_get_issue",
      "linear_list_comments",
      "linear_search_issues",
    ],
  ) =>
    tasks.Playbook.parse({
      id,
      name: id,
      role: "chat-ask",
      systemPrompt: "You read Linear.",
      promptTemplate: "{{question}}",
      tools: { linear },
      toolSettings: { linearRead },
    });
  const defined = [
    playbook("builtin:linear-reader", true),
    playbook("builtin:no-linear", false),
    playbook("builtin:document-reader", true, ["linear_get_document"]),
  ];
  const getBuiltinPlaybook = (id: string) => defined.find((p) => p.id === id) ?? null;
  const getBuiltinRunSpec = (id: string) => {
    const found = getBuiltinPlaybook(id);
    return found && tasks.playbookRunSpec(found);
  };
  return {
    ...tasks,
    getBuiltinPlaybook,
    getBuiltinRunSpec,
    getBuiltinTask: (id: string) => getBuiltinRunSpec(id)?.task ?? null,
  };
});

const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
delete process.env.KMS_AGENT_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = signingKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const { getTokenSigner } = await import("@/lib/agent-auth/signer");
const { GET: searchIssues } = await import("./runs/[id]/linear/issues/route");
const { GET: getIssue } = await import("./runs/[id]/linear/issues/[issueId]/route");
const { GET: listComments } = await import("./runs/[id]/linear/issues/[issueId]/comments/route");
const { GET: getDocument } = await import("./runs/[id]/linear/documents/[documentId]/route");

const databaseAvailable = testDatabaseAvailable();

let ipCounter = 0;
function request(path: string, token: string | undefined): Request {
  ipCounter += 1;
  return new Request(`http://localhost${path}`, {
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      "x-real-ip": `198.51.100.${ipCounter}`,
    },
  });
}

const call = {
  issue: (jobId: string, issueId: string, token?: string) =>
    getIssue(request(`/api/agent/runs/${jobId}/linear/issues/${issueId}`, token), {
      params: Promise.resolve({ id: jobId, issueId }),
    }),
  comments: (jobId: string, issueId: string, token?: string) =>
    listComments(request(`/api/agent/runs/${jobId}/linear/issues/${issueId}/comments`, token), {
      params: Promise.resolve({ id: jobId, issueId }),
    }),
  search: (jobId: string, query: string, token?: string) =>
    searchIssues(request(`/api/agent/runs/${jobId}/linear/issues?${query}`, token), {
      params: Promise.resolve({ id: jobId }),
    }),
  document: (jobId: string, documentId: string, token?: string) =>
    getDocument(request(`/api/agent/runs/${jobId}/linear/documents/${documentId}`, token), {
      params: Promise.resolve({ id: jobId, documentId }),
    }),
};

describe.skipIf(!databaseAvailable)("GET /api/agent/runs/{id}/linear/*", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let agentId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    state.db = db;
    const [agent] = await db
      .insert(agents)
      .values({ organizationId: orgId, name: "coder-1", reportedAcceptedTaskTypes: ["query"] })
      .returning();
    agentId = agent!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    state.linear = new FakeLinearGateway();
    state.gatewayOrgs = [];
    state.notConnected = false;
    state.gatewaysByOrg = new Map();
  });

  /** A running query job of `taskId`, and its session token. */
  async function newRun(
    taskId: string | null = "builtin:linear-reader",
    values: Partial<typeof jobs.$inferInsert> = {},
  ) {
    const [job] = await db
      .insert(jobs)
      .values({
        organizationId: orgId,
        type: "chat.ask",
        taskType: "query",
        taskId,
        status: "running",
        agentId: agentId,
        payload: { trigger: { kind: "chat.request", context: { question: "Why?" } } },
        ...values,
      })
      .returning();
    const session = await getTokenSigner().signJobToken({
      jobId: job!.id,
      agentId,
      kind: "session",
      scopes: SESSION_SCOPES,
    });
    return { jobId: job!.id, session };
  }

  it("reads an issue by identifier with the run's organization's workspace", async () => {
    const issue = state.linear.add({
      title: "Login fails",
      identifier: "ENG-7",
      description: "Steps…",
      labels: ["bug"],
      projectName: "Web",
      creator: { id: "u1", name: "Ada" },
    });
    const { jobId, session } = await newRun();
    const res = await call.issue(jobId, "ENG-7", session);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      issue: {
        id: issue.id,
        identifier: "ENG-7",
        title: "Login fails",
        description: "Steps…",
        url: issue.url,
        team: "ENG",
        state: "Todo",
        stateType: "unstarted",
        priority: 0,
        labels: ["bug"],
        project: "Web",
        creator: "Ada",
      },
    });
    expect(state.gatewayOrgs).toEqual([orgId]);
  });

  it("lists an issue's comments oldest first, capped to the most recent 100", async () => {
    const issue = state.linear.add({ title: "T" });
    state.linear.commentsByIssue.set(
      issue.id,
      Array.from({ length: 102 }, (_, i) => ({
        body: `comment ${i}`,
        author: "Bo",
        createdAt: `2026-10-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      })),
    );
    const { jobId, session } = await newRun();
    const res = await call.comments(jobId, issue.id, session);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: Array<{ body: string }>; omitted: number };
    expect(body.omitted).toBe(2);
    expect(body.comments).toHaveLength(100);
    expect(body.comments[0]?.body).toBe("comment 2");
    expect(body.comments.at(-1)?.body).toBe("comment 101");
  });

  it("searches issues, with a default and a maximum result count", async () => {
    state.linear.add({ title: "Login page", identifier: "ENG-1" });
    state.linear.add({ title: "Login API", identifier: "ENG-2" });
    const { jobId, session } = await newRun();

    const res = await call.search(jobId, "query=login", session);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issues: Array<{ identifier: string }> };
    expect(body.issues.map((i) => i.identifier)).toEqual(["ENG-1", "ENG-2"]);
    expect((await call.search(jobId, "query=login&first=1", session)).status).toBe(200);
    expect(state.linear.searches).toEqual([
      { query: "login", first: 10 },
      { query: "login", first: 1 },
    ]);

    for (const query of [
      "",
      "query=",
      `query=${"x".repeat(501)}`,
      "query=a&first=26",
      "query=a&first=0",
    ]) {
      const bad = await call.search(jobId, query, session);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: "invalid_query" });
    }
    expect(state.linear.searches).toHaveLength(2);
  });

  it("refuses tools the run's agent doesn't list, and tasks without linearRead", async () => {
    state.linear.documents.set("doc-1", {
      id: "doc-1",
      title: "D",
      content: "",
      url: "https://linear.app/acme/document/d-doc-1",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    state.linear.add({ title: "T", identifier: "ENG-1" });
    const { jobId, session } = await newRun();
    // The agent doesn't list linear_get_document.
    const res = await call.document(jobId, "doc-1", session);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "linear_tool_not_allowed" });

    const off = await newRun("builtin:no-linear");
    expect((await call.issue(off.jobId, "ENG-1", off.session)).status).toBe(403);
    const unknown = await newRun("builtin:unknown");
    expect((await call.issue(unknown.jobId, "ENG-1", unknown.session)).status).toBe(403);
    const legacy = await newRun(null, { type: "review.run", taskType: "review" });
    expect((await call.issue(legacy.jobId, "ENG-1", legacy.session)).status).toBe(403);
    expect(state.gatewayOrgs).toEqual([]);
  });

  it("requires the running job's own token with linear:read", async () => {
    state.linear.add({ title: "T", identifier: "ENG-1" });
    const { jobId } = await newRun();
    expect((await call.issue(jobId, "ENG-1")).status).toBe(401);
    const lifecycle = await getTokenSigner().signJobToken({
      jobId,
      agentId,
      kind: "lifecycle",
      scopes: ["credentials:read"],
    });
    expect((await call.issue(jobId, "ENG-1", lifecycle)).status).toBe(401);
    const done = await newRun("builtin:linear-reader", { status: "completed" });
    expect((await call.issue(done.jobId, "ENG-1", done.session)).status).toBe(401);
    const other = await newRun();
    const res = await call.issue(jobId, "ENG-1", other.session);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "job_mismatch" });
    expect((await call.issue(jobId, "not%20an%20id", other.session)).status).toBe(404);
    expect(state.gatewayOrgs).toEqual([]);
  });

  it("reads a document by ID", async () => {
    state.linear.documents.set("doc-1", {
      id: "doc-1",
      title: "Design",
      content: "# Design",
      url: "https://linear.app/acme/document/design-doc-1",
      updatedAt: "2026-10-01T00:00:00.000Z",
      projectName: "Web",
    });
    const { jobId, session } = await newRun("builtin:document-reader");
    const res = await call.document(jobId, "doc-1", session);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      document: {
        id: "doc-1",
        title: "Design",
        content: "# Design",
        url: "https://linear.app/acme/document/design-doc-1",
        updatedAt: "2026-10-01T00:00:00.000Z",
        project: "Web",
      },
    });
    expect(state.gatewayOrgs).toEqual([orgId]);
  });

  it("answers 404 for an issue or document the gateway can't find", async () => {
    const reader = await newRun();
    let res = await call.issue(reader.jobId, "ENG-404", reader.session);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "linear_not_found" });

    const documents = await newRun("builtin:document-reader");
    res = await call.document(documents.jobId, "doc-404", documents.session);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "linear_not_found" });
  });

  it("reads only through the run's own organization's integration", async () => {
    const [other] = await db.insert(organizations).values({ name: "Globex" }).returning();
    const [otherAgent] = await db
      .insert(agents)
      .values({ organizationId: other!.id, name: "globex-1", reportedAcceptedTaskTypes: ["query"] })
      .returning();
    const globex = new FakeLinearGateway();
    globex.add({ title: "Globex secret", identifier: "GLX-1" });
    state.gatewaysByOrg.set(other!.id, globex);

    // A run of organization A asking for organization B's issue reads A's workspace.
    const acme = await newRun();
    let res = await call.issue(acme.jobId, "GLX-1", acme.session);
    expect(res.status).toBe(404);
    expect(state.gatewayOrgs).toEqual([orgId]);
    res = await call.search(acme.jobId, "query=secret", acme.session);
    expect(await res.json()).toEqual({ issues: [] });

    // Organization B's run, on B's agent, reads B's workspace; A's token can't use it.
    const [job] = await db
      .insert(jobs)
      .values({
        organizationId: other!.id,
        type: "chat.ask",
        taskType: "query",
        taskId: "builtin:linear-reader",
        status: "running",
        agentId: otherAgent!.id,
        payload: { trigger: { kind: "chat.request", context: { question: "Why?" } } },
      })
      .returning();
    expect((await call.issue(job!.id, "GLX-1", acme.session)).status).toBe(403);
    const globexSession = await getTokenSigner().signJobToken({
      jobId: job!.id,
      agentId: otherAgent!.id,
      kind: "session",
      scopes: SESSION_SCOPES,
    });
    res = await call.issue(job!.id, "GLX-1", globexSession);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ issue: { identifier: "GLX-1" } });
    expect(state.gatewayOrgs).toEqual([orgId, orgId, other!.id]);
  });

  it("maps Linear failures: not connected 409, not found 404, anything else 502", async () => {
    const { jobId, session } = await newRun();
    state.notConnected = true;
    let res = await call.issue(jobId, "ENG-1", session);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "linear_not_connected" });

    state.notConnected = false;
    state.linear.failures.set("getIssue", new InvalidInputLinearError());
    res = await call.issue(jobId, "ENG-1", session);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "linear_not_found" });

    state.linear.failures.set("getIssue", new Error("rate limited"));
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    res = await call.issue(jobId, "ENG-1", session);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "linear_failed", message: "rate limited" });
  });
});
