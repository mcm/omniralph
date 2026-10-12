import {
  closeDb,
  createDb,
  insertAgentDefinition,
  insertTaskDefinition,
  jobs,
  organizations,
  repositories,
  runMigrations,
  scmConnections,
  seedReviewProfiles,
  type Database,
} from "@omniralph/db";
import { REVIEW_TASKS_MIN_HARNESS_VERSION } from "@omniralph/shared";
import {
  BUILTIN_AGENTS,
  BUILTIN_TASKS,
  getBuiltinAgent,
  getBuiltinTask,
  type AgentDefinitionInput,
  type TaskDefinitionInput,
} from "@omniralph/tasks";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  CORRELATION_TASKS,
  getAgentDefinition,
  getTaskChoice,
  getTaskDefinition,
  listAgentDefinitions,
  listTaskDefinitions,
  organizationDefinitions,
  REQUEST_TASKS,
  REVIEW_TASKS,
  STORY_TASKS,
  taskJobInput,
} = await import("./index");
const { enqueueReview } = await import("@/lib/review/enqueue");
const { PostgresDispatcher } = await import("@/lib/dispatch");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const securityAgent: AgentDefinitionInput = {
  ...getBuiltinAgent("builtin:reviewer")!,
  systemPrompt: "You review code for security problems only.",
};

/** A clone of `builtin:review-pr` (its stored `id` and `name` are the row's). */
const securityReview: TaskDefinitionInput = { ...getBuiltinTask("builtin:review-pr")! };

/** A higher minimum harness version than any task type needs. */
const STORED_MIN_VERSION = "99.1.0";

describe.skipIf(!dockerAvailable)("definition resolver", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgId = org!.id;
    otherOrgId = other!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  async function customAgent(organizationId = orgId, definition: object = securityAgent) {
    return insertAgentDefinition(db, organizationId, {
      name: "Security reviewer",
      definition: { ...definition },
      createdBy: null,
    });
  }

  async function customTask(
    organizationId = orgId,
    definition: object = securityReview,
    requirements: object = { minHarnessVersion: STORED_MIN_VERSION },
  ) {
    return insertTaskDefinition(db, organizationId, {
      name: "Security review",
      definition: { ...definition },
      requirements: { ...requirements },
      createdBy: null,
    });
  }

  describe("get", () => {
    it("resolves a built-in ID from code", async () => {
      expect(await getTaskDefinition(db, orgId, "builtin:review-pr")).toEqual({
        definition: getBuiltinTask("builtin:review-pr"),
        builtin: true,
        requirements: null,
      });
      expect(await getAgentDefinition(db, orgId, "builtin:reviewer")).toEqual({
        definition: getBuiltinAgent("builtin:reviewer"),
        builtin: true,
      });
      expect(await getTaskDefinition(db, orgId, "builtin:gone")).toBeNull();
      expect(await getAgentDefinition(db, orgId, "builtin:gone")).toBeNull();
    });

    it("resolves a UUID from the organization's rows, with the row's ID, name and requirements", async () => {
      const agent = await customAgent();
      const task = await customTask(orgId, { ...securityReview, agentId: agent.id });
      const resolvedTask = await getTaskDefinition(db, orgId, task.id);
      expect(resolvedTask).toMatchObject({
        builtin: false,
        definition: {
          id: task.id,
          name: "Security review",
          taskType: "review",
          agentId: agent.id,
        },
        requirements: { minHarnessVersion: STORED_MIN_VERSION, installables: [], hostTools: [] },
      });
      expect(await getAgentDefinition(db, orgId, agent.id)).toMatchObject({
        builtin: false,
        definition: { id: agent.id, systemPrompt: securityAgent.systemPrompt },
      });
    });

    it("never resolves another organization's row", async () => {
      const agent = await customAgent(otherOrgId);
      const task = await customTask(otherOrgId);
      expect(await getTaskDefinition(db, orgId, task.id)).toBeNull();
      expect(await getAgentDefinition(db, orgId, agent.id)).toBeNull();
    });

    it("reports a stored definition that fails its schema as unresolvable", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const agent = await customAgent(orgId, { ...securityAgent, taskTypes: [] });
      const task = await customTask(orgId, { ...securityReview, sink: "nowhere" });
      const badRequirements = await customTask(orgId, securityReview, { minHarnessVersion: 7 });
      expect(await getAgentDefinition(db, orgId, agent.id)).toBeNull();
      expect(await getTaskDefinition(db, orgId, task.id)).toBeNull();
      expect(await getTaskDefinition(db, orgId, badRequirements.id)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(3);
      warn.mockRestore();
    });
  });

  describe("list", () => {
    it("lists the built-ins and the organization's own, saying which is which", async () => {
      const [org] = await db.insert(organizations).values({ name: "Lister" }).returning();
      const agent = await customAgent(org!.id);
      const task = await customTask(org!.id, { ...securityReview, agentId: agent.id });
      await customTask(otherOrgId);
      await customTask(org!.id, { ...securityReview, taskType: "nope" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const agents = await listAgentDefinitions(db, org!.id);
      expect(agents.map((a) => [a.definition.id, a.builtin])).toEqual([
        ...BUILTIN_AGENTS.map((a) => [a.id, true]),
        [agent.id, false],
      ]);
      const tasks = await listTaskDefinitions(db, org!.id);
      expect(tasks.map((t) => [t.definition.id, t.builtin])).toEqual([
        ...BUILTIN_TASKS.map((t) => [t.id, true]),
        [task.id, false],
      ]);
      warn.mockRestore();
    });

    it("filters tasks by task type and trigger kind", async () => {
      const [org] = await db.insert(organizations).values({ name: "Filterer" }).returning();
      const task = await customTask(org!.id);
      const ids = async (filter: Parameters<typeof listTaskDefinitions>[2]) =>
        (await listTaskDefinitions(db, org!.id, filter)).map((t) => t.definition.id);

      const reviews = await ids({ taskType: "review" });
      expect(reviews).toEqual([
        ...BUILTIN_TASKS.filter((t) => t.taskType === "review").map((t) => t.id),
        task.id,
      ]);
      expect(await ids({ taskType: ["query", "coding"] })).toEqual(
        BUILTIN_TASKS.filter((t) => t.taskType !== "review").map((t) => t.id),
      );
      expect(await ids({ trigger: "chat.request" })).toEqual(
        BUILTIN_TASKS.filter((t) => t.triggers.includes("chat.request")).map((t) => t.id),
      );
      expect(await ids({ taskType: "review", trigger: "pr.updated" })).toContain(task.id);
      expect(await ids({ taskType: "review", trigger: "finding.mention" })).not.toContain(task.id);
    });

    it("offers repository pickers their built-ins and the organization's matching tasks", async () => {
      const [org] = await db.insert(organizations).values({ name: "Picker" }).returning();
      const review = await customTask(org!.id);
      const correlation = await customTask(org!.id, getBuiltinTask("builtin:correlate-findings")!);
      const story = await customTask(org!.id, getBuiltinTask("builtin:implement-story")!);
      const request = await customTask(org!.id, getBuiltinTask("builtin:handle-request")!);
      const chatOnly = await customTask(org!.id, {
        ...getBuiltinTask("builtin:handle-request")!,
        triggers: ["chat.request"],
      });
      const ids = async (filter: Parameters<typeof listTaskDefinitions>[2]) =>
        (await listTaskDefinitions(db, org!.id, filter)).map((t) => t.definition.id);

      expect(await ids(REVIEW_TASKS)).toEqual([
        "builtin:review-pr",
        "builtin:summarize-pr",
        review.id,
      ]);
      expect(await ids(CORRELATION_TASKS)).toEqual(["builtin:correlate-findings", correlation.id]);
      expect(await ids(STORY_TASKS)).toEqual(["builtin:implement-story", story.id]);
      expect(await ids(REQUEST_TASKS)).toEqual(["builtin:handle-request", request.id]);
      expect(await ids(REQUEST_TASKS)).not.toContain(chatOnly.id);

      expect((await getTaskChoice(db, org!.id, story.id, STORY_TASKS))?.definition.id).toBe(
        story.id,
      );
      expect(await getTaskChoice(db, org!.id, story.id, REQUEST_TASKS)).toBeNull();
      expect(await getTaskChoice(db, orgId, story.id, STORY_TASKS)).toBeNull();
      expect(await getTaskChoice(db, org!.id, "builtin:nope", STORY_TASKS)).toBeNull();
    });
  });

  describe("organizationDefinitions", () => {
    it("looks tasks and agents up for one organization only", async () => {
      const agent = await customAgent();
      const task = await customTask(orgId, { ...securityReview, agentId: agent.id });
      const mine = organizationDefinitions(db, orgId);
      expect((await mine.getTask(task.id))?.agentId).toBe(agent.id);
      expect((await mine.getAgent(agent.id))?.id).toBe(agent.id);
      expect(await mine.getTaskRequirements!(task.id)).toMatchObject({
        minHarnessVersion: STORED_MIN_VERSION,
      });
      expect(await mine.getTask("builtin:review-pr")).toBe(getBuiltinTask("builtin:review-pr"));
      expect(await mine.getTaskRequirements!("builtin:review-pr")).toBeNull();

      const theirs = organizationDefinitions(db, otherOrgId);
      expect(await theirs.getTask(task.id)).toBeNull();
      expect(await theirs.getAgent(agent.id)).toBeNull();
    });

    it("gives a custom task's job its stored minimum harness version", async () => {
      const task = await customTask();
      const definitions = organizationDefinitions(db, orgId);
      const input = await taskJobInput(definitions, (await definitions.getTask(task.id))!, {
        trigger: { kind: "pr.updated", context: {} },
      });
      expect(input).toMatchObject({ taskId: task.id, minHarnessVersion: STORED_MIN_VERSION });

      // A stored minimum below the task type's never lowers it.
      const low = await customTask(orgId, securityReview, { minHarnessVersion: "0.0.1" });
      const lowInput = await taskJobInput(definitions, (await definitions.getTask(low.id))!, {
        trigger: { kind: "pr.updated", context: {} },
      });
      expect(lowInput.minHarnessVersion).toBe(REVIEW_TASKS_MIN_HARNESS_VERSION);
    });
  });

  it("enqueues a review run of a custom review task with its stored minimum harness version", async () => {
    const task = await customTask();
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
    await seedReviewProfiles(db, orgId);
    const [repo] = await db
      .insert(repositories)
      .values({
        organizationId: orgId,
        provider: "github",
        externalId: "100",
        fullPath: "acme/app",
        connectionId: connection!.id,
        reviewTaskIds: ["builtin:review-pr", task.id],
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
        return { taskId: row!.taskId, minHarnessVersion: row!.minHarnessVersion };
      }),
    );
    expect(rows).toEqual([
      { taskId: "builtin:review-pr", minHarnessVersion: REVIEW_TASKS_MIN_HARNESS_VERSION },
      { taskId: task.id, minHarnessVersion: STORED_MIN_VERSION },
    ]);
  });
});
