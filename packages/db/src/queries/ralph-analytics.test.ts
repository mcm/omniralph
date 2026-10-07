import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "../client.js";
import { runMigrations } from "../migrate.js";
import { connectRepository, upsertScmConnection } from "../repositories.js";
import { jobs, ralphRuns, ralphStories, organizations } from "../schema.js";
import { getRalphAnalytics } from "./ralph-analytics.js";
import { seedReviewProfiles } from "../settings.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const key = randomBytes(32);
const now = new Date("2026-10-05T12:00:00Z");

describe.skipIf(!dockerAvailable)("ralph analytics queries", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let repoA: string;
  let repoB: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
    orgId = org!.id;

    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "github",
        name: "app",
        baseUrl: "https://api.github.com",
        externalId: "1",
        credentials: {},
      },
      key,
    ))!;
    const connect = async (externalId: string, fullPath: string) =>
      (
        await connectRepository(db, {
          connectionId: connection.id,
          provider: "github",
          externalId,
          fullPath,
        })
      ).id;
    repoA = await connect("1", "acme/api");
    repoB = await connect("2", "acme/web");

    const run = (
      repositoryId: string,
      createdAt: string,
      status: (typeof ralphRuns.$inferInsert)["status"],
    ) => {
      const id = randomUUID();
      return {
        id,
        organizationId: orgId,
        linearIssueId: id,
        linearIdentifier: "ENG-1",
        linearAgentSessionId: id,
        kind: "children" as const,
        repositoryId,
        status,
        createdAt: new Date(createdAt),
      };
    };
    const a1 = run(repoA, "2026-10-05T01:00:00Z", "completed");
    const a2 = run(repoA, "2026-10-04T23:30:00Z", "failed");
    const a3 = run(repoA, "2026-10-04T10:00:00Z", "waiting");
    const a4 = run(repoA, "2026-09-29T00:00:00Z", "stopped");
    const a5 = run(repoA, "2026-10-05T11:00:00Z", "pending");
    // Before the 7-day window.
    const a6 = run(repoA, "2026-09-28T23:59:59Z", "completed");
    const b1 = run(repoB, "2026-10-02T12:00:00Z", "running");
    await db.insert(ralphRuns).values([a1, a2, a3, a4, a5, a6, b1]);

    const job = (
      runId: string,
      repositoryId: string,
      type: string,
      createdAt: string,
      result: Record<string, unknown> | null,
    ) => ({
      id: randomUUID(),
      organizationId: orgId,
      capability: type.split(".")[0]!,
      type,
      repositoryId,
      ralphRunId: runId,
      status: "completed" as const,
      result,
      createdAt: new Date(createdAt),
    });
    const usage = (inputTokens: number, outputTokens: number) => ({
      usage: { inputTokens, outputTokens },
    });
    const blockedJob = job(a1.id, repoA, "ralph.story", "2026-10-05T02:00:00Z", {
      status: "blocked",
      ...usage(100, 10),
    });
    const failedJob = job(a2.id, repoA, "ralph.story", "2026-10-04T23:40:00Z", {
      status: "failed",
      ...usage(200, 20),
    });
    await db.insert(jobs).values([
      blockedJob,
      failedJob,
      job(a1.id, repoA, "ralph.describe-pr", "2026-10-05T03:00:00Z", usage(1000, 100)),
      job(a3.id, repoA, "ralph.request", "2026-10-04T10:00:00Z", usage(400, 40)),
      // No usage recorded (prepare/cleanup, or a job that failed without a result).
      job(a3.id, repoA, "ralph.cleanup", "2026-10-04T11:00:00Z", { handled: true }),
      job(a3.id, repoA, "ralph.story", "2026-10-04T12:00:00Z", null),
      job(b1.id, repoB, "ralph.story", "2026-10-02T12:00:00Z", usage(3000, 300)),
      // Outside the window, and not a ralph job.
      job(a6.id, repoA, "ralph.story", "2026-09-28T23:59:59Z", usage(9000, 900)),
      {
        ...job(a1.id, repoA, "review.run", "2026-10-05T01:00:00Z", usage(5000, 500)),
        ralphRunId: null,
      },
    ]);

    const story = (
      runId: string,
      status: (typeof ralphStories.$inferInsert)["status"],
      attempts: number,
      lastJobId: string | null = null,
    ) => {
      const id = randomUUID();
      return {
        runId,
        linearIssueId: id,
        identifier: "ENG-2",
        title: "S",
        status,
        attempts,
        lastJobId,
      };
    };
    await db.insert(ralphStories).values([
      story(a1.id, "completed", 1),
      story(a1.id, "completed", 1),
      story(a1.id, "completed", 3),
      story(a1.id, "exhausted", 3, blockedJob.id),
      story(a2.id, "exhausted", 3, failedJob.id),
      story(a2.id, "completed", 2),
      story(a3.id, "blocked", 0),
      story(a3.id, "pending", 0),
      story(a3.id, "manual", 0),
      story(b1.id, "completed", 1),
      story(b1.id, "exhausted", 3),
      // A run outside the window.
      story(a6.id, "completed", 1),
      story(a6.id, "exhausted", 3),
    ]);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  it("totals ralph job tokens from their recorded usage, per UTC day", async () => {
    const analytics = await getRalphAnalytics(db, { days: 7, now });
    expect(analytics.totals).toEqual({ runs: 6, jobs: 7, tokensIn: 4700, tokensOut: 470 });
    expect(analytics.daily).toHaveLength(7);
    expect(analytics.daily[0]).toMatchObject({ date: "2026-09-29", tokensIn: 0, tokensOut: 0 });
    expect(analytics.daily.find((d) => d.date === "2026-10-05")).toMatchObject({
      tokensIn: 1100,
      tokensOut: 110,
    });
    expect(analytics.daily.find((d) => d.date === "2026-10-04")).toMatchObject({
      tokensIn: 600,
      tokensOut: 60,
    });
  });

  it("counts runs started per day by their status", async () => {
    const analytics = await getRalphAnalytics(db, { days: 7, now });
    expect(analytics.runsByOutcome).toEqual({
      completed: 1,
      waiting: 1,
      stopped: 1,
      failed: 1,
      running: 2,
    });
    const day = (date: string) => analytics.daily.find((d) => d.date === date)!.runs;
    expect(day("2026-09-29")).toEqual({
      completed: 0,
      waiting: 0,
      stopped: 1,
      failed: 0,
      running: 0,
    });
    expect(day("2026-10-04")).toMatchObject({ failed: 1, waiting: 1 });
    expect(day("2026-10-05")).toMatchObject({ completed: 1, running: 1 });
    expect(day("2026-10-02")).toMatchObject({ running: 1 });

    const quarter = await getRalphAnalytics(db, { days: 90, now });
    expect(quarter.runsByOutcome.completed).toBe(2);
  });

  it("classifies the outcomes of the stories of runs started in the window", async () => {
    const analytics = await getRalphAnalytics(db, { days: 7, now });
    expect(analytics.storyOutcomes).toEqual({
      firstAttempt: 3,
      afterRetries: 2,
      exhausted: 2,
      blocked: 2,
    });
    // (1 + 1 + 3 + 2 + 1) / 5
    expect(analytics.averageAttempts).toBe(1.6);
    // Over time: each run's stories on the day the run started.
    const day = (date: string) => analytics.daily.find((d) => d.date === date)!.stories;
    expect(day("2026-10-05")).toEqual({
      firstAttempt: 2,
      afterRetries: 1,
      exhausted: 0,
      blocked: 1,
    });
    expect(day("2026-10-04")).toEqual({
      firstAttempt: 0,
      afterRetries: 1,
      exhausted: 1,
      blocked: 1,
    });
    expect(day("2026-10-02")).toEqual({
      firstAttempt: 1,
      afterRetries: 0,
      exhausted: 1,
      blocked: 0,
    });
    expect(day("2026-10-03")).toEqual({
      firstAttempt: 0,
      afterRetries: 0,
      exhausted: 0,
      blocked: 0,
    });
  });

  it("filters by repository", async () => {
    const analytics = await getRalphAnalytics(db, { days: 7, now, repositoryId: repoB });
    expect(analytics.totals).toEqual({ runs: 1, jobs: 1, tokensIn: 3000, tokensOut: 300 });
    expect(analytics.runsByOutcome).toMatchObject({ running: 1, completed: 0 });
    expect(analytics.storyOutcomes).toEqual({
      firstAttempt: 1,
      afterRetries: 0,
      exhausted: 1,
      blocked: 0,
    });
    expect(analytics.averageAttempts).toBe(1);
  });

  it("returns zeros for a window without runs", async () => {
    const analytics = await getRalphAnalytics(db, {
      days: 7,
      now: new Date("2026-01-15T00:00:00Z"),
    });
    expect(analytics.totals).toEqual({ runs: 0, jobs: 0, tokensIn: 0, tokensOut: 0 });
    expect(analytics.daily.every((d) => d.tokensIn === 0 && d.runs.completed === 0)).toBe(true);
    expect(analytics.storyOutcomes).toEqual({
      firstAttempt: 0,
      afterRetries: 0,
      exhausted: 0,
      blocked: 0,
    });
    expect(analytics.averageAttempts).toBe(0);
  });
});
