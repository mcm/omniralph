import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import {
  countActiveTaskJobs,
  deleteAgentDefinition,
  deleteTaskDefinition,
  getStoredAgentDefinition,
  getStoredTaskDefinition,
  insertAgentDefinition,
  insertTaskDefinition,
  listStoredAgentDefinitions,
  listStoredTaskDefinitions,
  updateAgentDefinition,
  updateTaskDefinition,
} from "./definitions.js";
import { runMigrations } from "./migrate.js";
import { agentDefinitions, jobs, organizations, taskDefinitions, users } from "./schema.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const agent = { name: "Security reviewer", systemPrompt: "Find vulnerabilities." };
const task = { name: "Security review", agentId: "builtin:reviewer" };
const requirements = { minHarnessVersion: "0.40.0", installables: [], hostTools: ["git"] };

describe.skipIf(!dockerAvailable)("definition queries", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [a, b] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgA = a!.id;
    orgB = b!.id;
    await db.insert(users).values([
      { id: "admin-1", email: "admin@example.com" },
      { id: "admin-2", email: "admin2@example.com" },
    ]);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  describe("agent definitions", () => {
    it("inserts, reads, lists, updates and deletes an organization's agent", async () => {
      const row = await insertAgentDefinition(db, orgA, {
        name: agent.name,
        definition: agent,
        createdBy: "admin-1",
      });
      expect(row).toMatchObject({
        organizationId: orgA,
        name: agent.name,
        definition: agent,
        createdBy: "admin-1",
        updatedBy: "admin-1",
      });
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await getStoredAgentDefinition(db, orgA, row.id)).toEqual(row);
      expect((await listStoredAgentDefinitions(db, orgA)).map((r) => r.id)).toContain(row.id);

      const updated = await updateAgentDefinition(db, orgA, row.id, {
        name: "Renamed",
        definition: { ...agent, name: "Renamed" },
        updatedBy: "admin-2",
      });
      expect(updated).toMatchObject({
        name: "Renamed",
        createdBy: "admin-1",
        updatedBy: "admin-2",
      });

      expect(await deleteAgentDefinition(db, orgA, row.id)).toBe(true);
      expect(await getStoredAgentDefinition(db, orgA, row.id)).toBeNull();
      expect(await deleteAgentDefinition(db, orgA, row.id)).toBe(false);
    });

    it("never reads, updates or deletes another organization's agent", async () => {
      const row = await insertAgentDefinition(db, orgA, {
        name: agent.name,
        definition: agent,
        createdBy: null,
      });
      expect(await getStoredAgentDefinition(db, orgB, row.id)).toBeNull();
      expect((await listStoredAgentDefinitions(db, orgB)).map((r) => r.id)).not.toContain(row.id);
      expect(
        await updateAgentDefinition(db, orgB, row.id, {
          name: "Hijacked",
          definition: {},
          updatedBy: null,
        }),
      ).toBeNull();
      expect(await deleteAgentDefinition(db, orgB, row.id)).toBe(false);
      expect(await getStoredAgentDefinition(db, orgA, row.id)).toMatchObject({
        name: agent.name,
        definition: agent,
      });
    });

    it("treats a built-in ID as no row", async () => {
      expect(await getStoredAgentDefinition(db, orgA, "builtin:reviewer")).toBeNull();
      expect(await deleteAgentDefinition(db, orgA, "builtin:reviewer")).toBe(false);
    });

    it("keeps an agent whose author is deleted", async () => {
      await db.insert(users).values({ id: "leaver", email: "leaver@example.com" });
      const row = await insertAgentDefinition(db, orgA, {
        name: agent.name,
        definition: agent,
        createdBy: "leaver",
      });
      await db.delete(users).where(eq(users.id, "leaver"));
      expect(await getStoredAgentDefinition(db, orgA, row.id)).toMatchObject({
        createdBy: null,
        updatedBy: null,
      });
    });
  });

  describe("task definitions", () => {
    it("inserts, reads, lists, updates and deletes an organization's task with its requirements", async () => {
      const row = await insertTaskDefinition(db, orgA, {
        name: task.name,
        definition: task,
        requirements,
        createdBy: "admin-1",
      });
      expect(row).toMatchObject({ organizationId: orgA, definition: task, requirements });
      expect(await getStoredTaskDefinition(db, orgA, row.id)).toEqual(row);
      expect((await listStoredTaskDefinitions(db, orgA)).map((r) => r.id)).toContain(row.id);

      const updated = await updateTaskDefinition(db, orgA, row.id, {
        name: "Renamed",
        definition: { ...task, name: "Renamed" },
        requirements: { ...requirements, minHarnessVersion: "0.41.0" },
        updatedBy: "admin-2",
      });
      expect(updated).toMatchObject({
        name: "Renamed",
        requirements: { minHarnessVersion: "0.41.0" },
        updatedBy: "admin-2",
      });

      expect(await deleteTaskDefinition(db, orgA, row.id)).toBe(true);
      expect(await getStoredTaskDefinition(db, orgA, row.id)).toBeNull();
    });

    it("never reads, updates or deletes another organization's task", async () => {
      const row = await insertTaskDefinition(db, orgA, {
        name: task.name,
        definition: task,
        requirements,
        createdBy: null,
      });
      expect(await getStoredTaskDefinition(db, orgB, row.id)).toBeNull();
      expect((await listStoredTaskDefinitions(db, orgB)).map((r) => r.id)).not.toContain(row.id);
      expect(
        await updateTaskDefinition(db, orgB, row.id, {
          name: "Hijacked",
          definition: {},
          requirements: {},
          updatedBy: null,
        }),
      ).toBeNull();
      expect(await deleteTaskDefinition(db, orgB, row.id)).toBe(false);
      expect(await getStoredTaskDefinition(db, orgA, row.id)).toMatchObject({
        name: task.name,
        definition: task,
        requirements,
      });
    });

    it("deletes an organization's definitions with it", async () => {
      const [doomed] = await db.insert(organizations).values({ name: "Doomed" }).returning();
      await insertAgentDefinition(db, doomed!.id, { name: "A", definition: {}, createdBy: null });
      await insertTaskDefinition(db, doomed!.id, {
        name: "T",
        definition: {},
        requirements: {},
        createdBy: null,
      });
      await db.delete(organizations).where(eq(organizations.id, doomed!.id));
      expect(
        await db
          .select()
          .from(agentDefinitions)
          .where(eq(agentDefinitions.organizationId, doomed!.id)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(taskDefinitions)
          .where(eq(taskDefinitions.organizationId, doomed!.id)),
      ).toEqual([]);
    });
  });
  describe("countActiveTaskJobs", () => {
    it("counts the organization's queued and running jobs of a task", async () => {
      const taskId = "44444444-4444-4444-8444-444444444444";
      const job = (
        organizationId: string,
        status: "queued" | "running" | "completed",
        id = taskId,
      ) => ({
        organizationId,
        type: "chat.ask",
        taskType: "query" as const,
        pool: "short",
        taskId: id,
        status,
      });
      expect(await countActiveTaskJobs(db, orgA, taskId)).toBe(0);
      await db
        .insert(jobs)
        .values([
          job(orgA, "queued"),
          job(orgA, "running"),
          job(orgA, "completed"),
          job(orgA, "queued", "builtin:chat-ask"),
          job(orgB, "queued"),
        ]);
      expect(await countActiveTaskJobs(db, orgA, taskId)).toBe(2);
      expect(await countActiveTaskJobs(db, orgB, taskId)).toBe(1);
    });
  });
});
