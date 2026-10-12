import {
  agentDefinitions,
  closeDb,
  createDb,
  decrypt,
  feedback,
  findings,
  harnesses,
  integrations,
  jobs,
  organizationMembers,
  ralphRuns,
  ralphStories,
  reviewProfiles,
  reviewRuns,
  reviews,
  rules,
  runMigrations,
  scmConnections,
  taskDefinitions,
  users,
  type Database,
} from "@omniralph/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { AgentDefinition, TaskDefinition, TaskRequirements } from "@omniralph/tasks";
import { eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_IDS } from "./ids";
import { FIXTURE_ENCRYPTION_KEY, seedFixtures } from "./seed";

describe("seedFixtures", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    await seedFixtures(db);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  const values = <T>(rows: T[], key: keyof T) => new Set(rows.map((r) => r[key]));

  it("is re-runnable with the same IDs", async () => {
    await seedFixtures(db);
    const runs = await db.select({ id: ralphRuns.id }).from(ralphRuns);
    expect(new Set(runs.map((r) => r.id))).toEqual(new Set(Object.values(FIXTURE_IDS.ralphRuns)));
    const [review] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.id, FIXTURE_IDS.reviews.featured));
    expect(review?.status).toBe("completed");
  });

  it("has an admin and a member", async () => {
    const members = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, FIXTURE_IDS.organizations.main));
    expect(values(members, "role")).toEqual(new Set(["admin", "member"]));
    const people = await db.select().from(users);
    expect(people.every((u) => u.email?.endsWith("@fixtures.example"))).toBe(true);
    expect(people.every((u) => u.activeOrganizationId === FIXTURE_IDS.organizations.main)).toBe(
      true,
    );
  });

  it("connects GitHub, GitLab and Linear with fake credentials", async () => {
    const connections = await db.select().from(scmConnections);
    expect(values(connections, "provider")).toEqual(new Set(["github", "gitlab"]));
    const [linear] = await db.select().from(integrations);
    for (const row of [...connections, linear!]) {
      expect(row.externalId).toMatch(/^fixture/);
      const plain = decrypt(row.encryptedCredentials, FIXTURE_ENCRYPTION_KEY);
      for (const secret of Object.values(JSON.parse(plain) as Record<string, string>)) {
        expect(secret).toMatch(/^fixture-.*-not-real$/);
      }
    }
  });

  it("has harnesses online, offline, outdated and revoked", async () => {
    const rows = await db.select().from(harnesses);
    const now = Date.now();
    const online = rows.filter(
      (h) => !h.revokedAt && h.lastHeartbeatAt && now - h.lastHeartbeatAt.getTime() < 60_000,
    );
    expect(online.length).toBeGreaterThan(0);
    expect(rows.some((h) => h.lastHeartbeatAt && now - h.lastHeartbeatAt.getTime() > DAY)).toBe(
      true,
    );
    expect(online.some((h) => h.reportedVersion !== "1.8.0")).toBe(true);
    expect(rows.some((h) => h.revokedAt)).toBe(true);
  });

  it("has ralph runs and stories in every state, with attempts, progress and follow-ups", async () => {
    const runs = await db.select().from(ralphRuns);
    expect(values(runs, "status")).toEqual(
      new Set(["pending", "running", "waiting", "completed", "failed", "stopped"]),
    );
    const waiting = runs.find((r) => r.status === "waiting");
    expect(waiting?.waitingOn?.manual.length).toBeGreaterThan(0);
    expect(runs.some((r) => r.progress.includes("Learnings"))).toBe(true);

    const stories = await db.select().from(ralphStories);
    expect(values(stories, "status")).toEqual(
      new Set(["pending", "running", "completed", "blocked", "exhausted", "manual", "canceled"]),
    );
    expect(stories.some((s) => s.attempts > 1)).toBe(true);
    const storyJobs = await db.select().from(jobs).where(eq(jobs.type, "ralph.story"));
    expect(
      storyJobs.some((j) => ((j.result?.followUps as unknown[] | undefined)?.length ?? 0) > 0),
    ).toBe(true);
  });

  it("has reviews with open, dismissed and restored findings, rules and profiles", async () => {
    expect((await db.select().from(reviewRuns)).length).toBeGreaterThan(0);
    const allFindings = await db.select().from(findings);
    expect(values(allFindings, "status")).toContain("open");
    expect(values(allFindings, "status")).toContain("dismissed");
    const restored = await db.select().from(feedback).where(isNotNull(feedback.restoredAt));
    expect(restored.length).toBeGreaterThan(0);
    const allRules = await db.select().from(rules);
    expect(values(allRules, "kind")).toEqual(new Set(["custom", "learned"]));
    const profiles = await db
      .select()
      .from(reviewProfiles)
      .where(eq(reviewProfiles.organizationId, FIXTURE_IDS.organizations.main));
    expect(profiles.some((p) => !p.builtIn)).toBe(true);
  });

  it("has a custom agent and task that resolve like the panel's", async () => {
    const [agent] = await db.select().from(agentDefinitions);
    const [task] = await db.select().from(taskDefinitions);
    expect(agent?.id).toBe(FIXTURE_IDS.definitions.agent);
    expect(task?.id).toBe(FIXTURE_IDS.definitions.task);
    const stored = (row: typeof agent) => ({ ...row!.definition, id: row!.id, name: row!.name });
    expect(AgentDefinition.safeParse(stored(agent)).success).toBe(true);
    const parsedTask = TaskDefinition.safeParse(stored(task));
    expect(parsedTask.success).toBe(true);
    expect(parsedTask.data?.agentId).toBe(FIXTURE_IDS.definitions.agent);
    expect(TaskRequirements.safeParse(task!.requirements).success).toBe(true);
  });

  it("has jobs in every state", async () => {
    const rows = await db.select().from(jobs);
    expect(values(rows, "status")).toEqual(
      new Set(["queued", "running", "completed", "failed", "canceled", "expired", "skipped"]),
    );
  });

  it("spreads reviews over the analytics window", async () => {
    const rows = await db.select().from(reviews);
    const days = new Set(
      rows
        .filter((r) => Date.now() - r.createdAt.getTime() < 30 * DAY)
        .map((r) => r.createdAt.toISOString().slice(0, 10)),
    );
    expect(days.size).toBeGreaterThan(15);
    expect(rows.some((r) => r.tokensIn > 0)).toBe(true);
  });
});

const DAY = 24 * 60 * 60 * 1000;
