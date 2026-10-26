import {
  closeDb,
  createDb,
  decrypt,
  feedback,
  findings,
  agents,
  agentRepoPins,
  integrations,
  jobs,
  listRoutingRules,
  listTriageRuns,
  organizationMembers,
  playbooks,
  ralphRuns,
  ralphStories,
  repositories,
  reviewRuns,
  reviews,
  rules,
  scmConnections,
  users,
  type Database,
} from "@omniralph/db";
import { createTestDatabase, type TestDatabase } from "@omniralph/db/testing";
import { Playbook, TaskRequirements } from "@omniralph/tasks";
import { TriageRunResult } from "@omniralph/shared";
import { eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storedPlaybookInput } from "@/lib/playbooks";
import { linearRoutingRulesSchema } from "@/lib/linear/routing-fields";
import { FIXTURE_IDS } from "./ids";
import { FIXTURE_ENCRYPTION_KEY, seedFixtures } from "./seed";

describe("seedFixtures", () => {
  let testDb: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    await seedFixtures(db);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
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
    const rows = await db.select().from(agents);
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
    // Enough for the pinned-harness picker to need its search.
    expect(rows.length).toBeGreaterThanOrEqual(30);
  });

  it("pins the control panel to a revoked harness among others", async () => {
    const pins = await db
      .select({ revokedAt: agents.revokedAt })
      .from(agentRepoPins)
      .innerJoin(agents, eq(agents.id, agentRepoPins.agentId))
      .where(eq(agentRepoPins.repositoryId, FIXTURE_IDS.repositories.controlPanel));
    expect(pins.length).toBeGreaterThan(1);
    expect(pins.some((pin) => pin.revokedAt)).toBe(true);
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

  it("has reviews with open, dismissed and restored findings, rules and every review depth", async () => {
    expect((await db.select().from(reviewRuns)).length).toBeGreaterThan(0);
    const allFindings = await db.select().from(findings);
    expect(values(allFindings, "status")).toContain("open");
    expect(values(allFindings, "status")).toContain("dismissed");
    const restored = await db.select().from(feedback).where(isNotNull(feedback.restoredAt));
    expect(restored.length).toBeGreaterThan(0);
    const allRules = await db.select().from(rules);
    expect(values(allRules, "kind")).toEqual(new Set(["custom", "learned"]));
    const repos = await db
      .select({ reviewDepth: repositories.reviewDepth })
      .from(repositories)
      .where(eq(repositories.organizationId, FIXTURE_IDS.organizations.main));
    expect(values(repos, "reviewDepth")).toEqual(new Set(["quick", "standard", "deep"]));
  });

  it("routes by valid rules: labels, then project, then team", async () => {
    const saved = await listRoutingRules(db, FIXTURE_IDS.organizations.main);
    expect(saved.map((r) => [r.repositoryId, r.query.rules[0]])).toEqual([
      [FIXTURE_IDS.repositories.controlPanel, expect.objectContaining({ field: "labels" })],
      [FIXTURE_IDS.repositories.harness, expect.objectContaining({ field: "project" })],
      [FIXTURE_IDS.repositories.controlPanel, expect.objectContaining({ field: "team" })],
    ]);
    const parsed = linearRoutingRulesSchema.safeParse({
      rules: saved.map((r) => ({ repositoryId: r.repositoryId, query: r.query })),
    });
    expect(parsed.error).toBeUndefined();
  });

  it("has a custom playbook that resolves like the panel's", async () => {
    const [row] = await db.select().from(playbooks);
    expect(row?.id).toBe(FIXTURE_IDS.playbooks.custom);
    const parsed = Playbook.safeParse(storedPlaybookInput(row!));
    expect(parsed.error).toBeUndefined();
    expect(parsed.data?.role).toBe("review");
    expect(TaskRequirements.safeParse(row!.requirements).success).toBe(true);
  });

  it("has triage runs with their jobs and valid results", async () => {
    const page = await listTriageRuns(db, FIXTURE_IDS.organizations.main);
    expect(new Set(page.runs.map((r) => r.run.id))).toEqual(
      new Set(Object.values(FIXTURE_IDS.triageRuns)),
    );
    for (const { run, jobs: runJobs } of page.runs) {
      expect(runJobs.length, run.id).toBeGreaterThan(0);
      if (run.lastResult) expect(TriageRunResult.safeParse(run.lastResult).success).toBe(true);
    }
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
