import {
  claimJob,
  closeDb,
  createDb,
  agents,
  insertPlaybook,
  jobs,
  organizations,
  repositories,
  scmConnections,
  type Database,
} from "@omniralph/db";
import { REVIEW_TASKS_MIN_AGENT_VERSION } from "@omniralph/shared";
import {
  BUILTIN_PLAYBOOKS,
  getBuiltinPlaybook,
  PLAYBOOK_ROLES,
  type PlaybookRole,
} from "@omniralph/tasks";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  getPlaybook,
  getPlaybookChoice,
  getPlaybookTask,
  listPlaybooks,
  organizationPlaybooks,
  REPOSITORY_BINDING_ROLES,
  taskJobInput,
} = await import("./index");
const { enqueueReview } = await import("@/lib/review/enqueue");
const { PostgresDispatcher } = await import("@/lib/dispatch");

const databaseAvailable = testDatabaseAvailable();

/** A built-in playbook as a row stores it (the row holds `id`, `name` and `role`). */
function stored(builtinId: string, overrides: Record<string, unknown> = {}) {
  const { id: _id, name: _name, role, ...definition } = getBuiltinPlaybook(builtinId)!;
  return { role, definition: { ...definition, ...overrides } };
}

const SECURITY_PROMPT = "You review code for security problems only.";

/** A higher minimum agent version than any task type needs. */
const STORED_MIN_VERSION = "99.1.0";

describe.skipIf(!databaseAvailable)("playbook resolver", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgId = org!.id;
    otherOrgId = other!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  /** A custom clone of built-in `from` (default: a security review) in `organizationId`. */
  async function customPlaybook(
    organizationId = orgId,
    from = "builtin:review-pr",
    overrides: Record<string, unknown> = { systemPrompt: SECURITY_PROMPT },
    requirements: object = { minAgentVersion: STORED_MIN_VERSION },
  ) {
    return insertPlaybook(db, organizationId, {
      name: "Security review",
      ...stored(from, overrides),
      requirements: { ...requirements },
      createdBy: null,
    });
  }

  describe("get", () => {
    it("resolves a built-in ID from code", async () => {
      expect(await getPlaybook(db, orgId, "builtin:review-pr")).toEqual({
        playbook: getBuiltinPlaybook("builtin:review-pr"),
        builtin: true,
        requirements: null,
      });
      expect(await getPlaybook(db, orgId, "builtin:gone")).toBeNull();
    });

    it("resolves a UUID from the organization's rows, with the row's ID, name, role and requirements", async () => {
      const row = await customPlaybook();
      expect(await getPlaybook(db, orgId, row.id)).toMatchObject({
        builtin: false,
        playbook: {
          id: row.id,
          name: "Security review",
          role: "review",
          systemPrompt: SECURITY_PROMPT,
        },
        requirements: { minAgentVersion: STORED_MIN_VERSION, installables: [], hostTools: [] },
      });
    });

    it("never resolves another organization's row", async () => {
      const row = await customPlaybook(otherOrgId);
      expect(await getPlaybook(db, orgId, row.id)).toBeNull();
    });

    it("reports a stored playbook that fails its schema, or takes a built-in-only role, as unresolvable", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const badMode = await customPlaybook(orgId, "builtin:review-pr", {
        systemPromptMode: "prepend",
      });
      const refused = await customPlaybook(orgId, "builtin:review-pr", { sink: "nowhere" });
      const badRequirements = await customPlaybook(
        orgId,
        "builtin:review-pr",
        {},
        {
          minAgentVersion: 7,
        },
      );
      const builtinOnly = await customPlaybook(orgId, "builtin:reply-to-finding", {});
      expect(await getPlaybook(db, orgId, badMode.id)).toBeNull();
      expect(await getPlaybook(db, orgId, refused.id)).toBeNull();
      expect(await getPlaybook(db, orgId, badRequirements.id)).toBeNull();
      expect(await getPlaybook(db, orgId, builtinOnly.id)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(3);
      warn.mockRestore();
    });
  });

  describe("list", () => {
    it("lists the built-ins and the organization's own, saying which is which", async () => {
      const [org] = await db.insert(organizations).values({ name: "Lister" }).returning();
      const row = await customPlaybook(org!.id);
      await customPlaybook(otherOrgId);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await insertPlaybook(db, org!.id, {
        name: "No role",
        ...stored("builtin:review-pr"),
        role: "nope",
        requirements: {},
        createdBy: null,
      });

      const playbooks = await listPlaybooks(db, org!.id);
      expect(playbooks.map((p) => [p.playbook.id, p.builtin])).toEqual([
        ...BUILTIN_PLAYBOOKS.map((p) => [p.id, true]),
        [row.id, false],
      ]);
      warn.mockRestore();
    });

    it("filters playbooks by role, task type and trigger kind", async () => {
      const [org] = await db.insert(organizations).values({ name: "Filterer" }).returning();
      const row = await customPlaybook(org!.id);
      const ids = async (filter: Parameters<typeof listPlaybooks>[2]) =>
        (await listPlaybooks(db, org!.id, filter)).map((p) => p.playbook.id);

      expect(await ids({ taskType: "review" })).toEqual([
        ...BUILTIN_PLAYBOOKS.filter((p) => PLAYBOOK_ROLES[p.role].taskType === "review").map(
          (p) => p.id,
        ),
        row.id,
      ]);
      expect(await ids({ trigger: "chat.request" })).toEqual(
        BUILTIN_PLAYBOOKS.filter((p) =>
          (PLAYBOOK_ROLES[p.role].triggers as readonly string[]).includes("chat.request"),
        ).map((p) => p.id),
      );
      expect(await ids({ roles: ["review"], trigger: "pr.updated" })).toContain(row.id);
      expect(await ids({ roles: ["review-summary"] })).not.toContain(row.id);
    });

    it("checks a repository binding's playbook against the roles it takes", async () => {
      const [org] = await db.insert(organizations).values({ name: "Picker" }).returning();
      const review = await customPlaybook(org!.id);
      const story = await customPlaybook(org!.id, "builtin:implement-story", {});
      const ids = async (roles: readonly PlaybookRole[]) =>
        (await listPlaybooks(db, org!.id, { roles })).map((p) => p.playbook.id);

      expect(await ids(REPOSITORY_BINDING_ROLES.review)).toEqual([
        "builtin:review-pr",
        "builtin:summarize-pr",
        review.id,
      ]);
      expect(await ids(REPOSITORY_BINDING_ROLES.story)).toEqual([
        "builtin:implement-story",
        story.id,
      ]);
      const choice = (id: string, binding: keyof typeof REPOSITORY_BINDING_ROLES, o = org!.id) =>
        getPlaybookChoice(db, o, id, { roles: REPOSITORY_BINDING_ROLES[binding] });
      expect((await choice(story.id, "story"))?.playbook.id).toBe(story.id);
      expect(await choice(story.id, "request")).toBeNull();
      expect(await choice(story.id, "story", orgId)).toBeNull();
      expect(await choice("builtin:nope", "story")).toBeNull();
    });
  });

  describe("organizationPlaybooks", () => {
    it("resolves built-in playbooks from code and custom ones from the organization's rows", async () => {
      const row = await customPlaybook();
      const mine = organizationPlaybooks(db, orgId);
      expect(await mine.getPlaybook(row.id)).toMatchObject({
        id: row.id,
        name: "Security review",
        role: "review",
        systemPrompt: SECURITY_PROMPT,
        promptTemplate: getBuiltinPlaybook("builtin:review-pr")!.promptTemplate,
        model: null,
      });
      expect(await mine.getPlaybookRequirements!(row.id)).toMatchObject({
        minAgentVersion: STORED_MIN_VERSION,
      });
      expect(await mine.getPlaybook("builtin:review-pr")).toBe(
        getBuiltinPlaybook("builtin:review-pr"),
      );
      expect(await mine.getPlaybookRequirements!("builtin:review-pr")).toBeNull();
      expect(await getPlaybookTask(mine, row.id)).toMatchObject({
        taskType: "review",
        agentId: row.id,
        sink: "review",
      });

      const theirs = organizationPlaybooks(db, otherOrgId);
      expect(await theirs.getPlaybook(row.id)).toBeNull();
    });

    it("gives a custom playbook's job its stored minimum agent version", async () => {
      const row = await customPlaybook();
      const playbooks = organizationPlaybooks(db, orgId);
      const input = await taskJobInput(playbooks, (await getPlaybookTask(playbooks, row.id))!, {
        trigger: { kind: "pr.updated", context: {} },
      });
      expect(input).toMatchObject({ taskId: row.id, minAgentVersion: STORED_MIN_VERSION });

      // A stored minimum below the task type's never lowers it.
      const low = await customPlaybook(
        orgId,
        "builtin:review-pr",
        {},
        { minAgentVersion: "0.0.1" },
      );
      const lowInput = await taskJobInput(playbooks, (await getPlaybookTask(playbooks, low.id))!, {
        trigger: { kind: "pr.updated", context: {} },
      });
      expect(lowInput.minAgentVersion).toBe(REVIEW_TASKS_MIN_AGENT_VERSION);
    });
  });

  it("enqueues a review run of a custom review playbook with its stored minimum agent version", async () => {
    const task = await customPlaybook();
    const [connection] = await db
      .insert(scmConnections)
      .values({
        organizationId: orgId,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "1",
        encryptedCredentials: "unused",
      })
      .returning();
    const [repo] = await db
      .insert(repositories)
      .values({
        organizationId: orgId,
        provider: "github",
        externalId: "100",
        fullPath: "acme/app",
        connectionId: connection!.id,
        reviewPlaybookIds: ["builtin:review-pr", task.id],
      })
      .returning();

    const result = await enqueueReview(db, new PostgresDispatcher({ db }), {
      repositoryId: repo!.id,
      prNumber: 7,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      title: "Add login",
      description: null,
      author: "octocat",
      trigger: "webhook",
    });
    if (result.status !== "enqueued") throw new Error(`expected enqueued, got ${result.status}`);
    expect(result.runs.map((r) => r.taskId)).toEqual(["builtin:review-pr", task.id]);
    const rows = await Promise.all(
      result.runs.map(async ({ jobId }) => {
        const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
        return { taskId: row!.taskId, minAgentVersion: row!.minAgentVersion };
      }),
    );
    expect(rows).toEqual([
      { taskId: "builtin:review-pr", minAgentVersion: REVIEW_TASKS_MIN_AGENT_VERSION },
      { taskId: task.id, minAgentVersion: STORED_MIN_VERSION },
    ]);
  });
  it("gives a run's job the installables and host tools its playbook needs, so only an agent with them claims it", async () => {
    const reviewPr = getBuiltinPlaybook("builtin:review-pr")!;
    const task = await customPlaybook(
      orgId,
      "builtin:review-pr",
      {
        tools: { ...reviewPr.tools, mcpServers: ["@omniralph/code-graph:graph"] },
        requires: { hostTools: ["opengrep"] },
      },
      // Stored when the playbook was saved; the job follows the playbook as it is now.
      { minAgentVersion: null, installables: ["@omniralph/stale"], hostTools: [] },
    );
    const [connection] = await db
      .insert(scmConnections)
      .values({
        organizationId: orgId,
        provider: "github",
        name: "acme-requirements",
        baseUrl: "https://api.github.com",
        externalId: "2",
        encryptedCredentials: "unused",
      })
      .returning();
    const [repo] = await db
      .insert(repositories)
      .values({
        organizationId: orgId,
        provider: "github",
        externalId: "200",
        fullPath: "acme/graph",
        connectionId: connection!.id,
        reviewPlaybookIds: [task.id],
      })
      .returning();

    const result = await enqueueReview(db, new PostgresDispatcher({ db }), {
      repositoryId: repo!.id,
      prNumber: 8,
      baseSha: "c".repeat(40),
      headSha: "d".repeat(40),
      title: "Add search",
      description: null,
      author: "octocat",
      trigger: "webhook",
    });
    if (result.status !== "enqueued") throw new Error(`expected enqueued, got ${result.status}`);
    const [run] = result.runs;
    const [row] = await db.select().from(jobs).where(eq(jobs.id, run!.jobId));
    expect(row).toMatchObject({
      requiredInstallables: ["@omniralph/code-graph"],
      requiredHostTools: ["opengrep"],
    });

    const [bare, graphOnly, capable] = await db
      .insert(agents)
      .values(
        ["bare", "graph-only", "capable"].map((name) => ({
          organizationId: orgId,
          name,
          reportedAcceptedTaskTypes: ["review"],
          reportedVersion: REVIEW_TASKS_MIN_AGENT_VERSION,
          reportedInstallables:
            name === "bare" ? [] : [{ name: "@omniralph/code-graph", version: "1.0.0" }],
        })),
      )
      .returning();
    await db
      .update(agents)
      .set({
        reportedHostTools: [
          { name: "opengrep", path: "/usr/bin/opengrep", source: "discovered", problem: null },
        ],
      })
      .where(eq(agents.id, capable!.id));
    const claim = (agentId: string) =>
      claimJob(db, {
        agentId,
        organizationId: orgId,
        acceptedTaskTypes: ["review"],
        pools: ["short", "long"],
        agentVersion: REVIEW_TASKS_MIN_AGENT_VERSION,
        maxDeliveries: 3,
      });
    // Drain what the other agents can claim: never this run.
    for (const agent of [bare!, graphOnly!]) {
      for (let next = await claim(agent.id); next.claim; next = await claim(agent.id)) {
        expect(next.claim.job.id).not.toBe(row!.id);
      }
    }
    const claimed: string[] = [];
    for (let next = await claim(capable!.id); next.claim; next = await claim(capable!.id)) {
      claimed.push(next.claim.job.id);
    }
    expect(claimed).toContain(row!.id);
  });
});
