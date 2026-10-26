import { randomBytes } from "node:crypto";
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { captureChanges } from "./changes.js";
import { closeDb, createDb, type Database } from "./client.js";
import { insertJob } from "./jobs.js";
import {
  appendGuidance,
  appendProgress,
  consumeMessages,
  createRun,
  ensureLane,
  insertMessage,
  updateMessage,
  updateStory,
  upsertStories,
} from "./ralph.js";
import { connectRepository, upsertScmConnection } from "./repositories.js";
import { getRunSession, listRunSessionMessages } from "./run-session.js";
import { agents, jobs, organizations, ralphRuns } from "./schema.js";

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("run session", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let api: string;
  let web: string;
  let agentId: string;
  let session = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "gitlab",
        name: "acme",
        baseUrl: "https://gitlab.example.com",
        externalId: "1",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    api = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "gitlab",
        externalId: "1",
        fullPath: "acme/api",
      })
    ).id;
    web = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "gitlab",
        externalId: "2",
        fullPath: "acme/web",
      })
    ).id;
    [{ id: agentId }] = (await db
      .insert(agents)
      .values({ organizationId: orgId, name: "coder-1" })
      .returning({ id: agents.id })) as [{ id: string }];
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
  });

  async function newRun() {
    session += 1;
    const { run } = await createRun(db, {
      organizationId: orgId,
      linearIssueId: `issue-${session}`,
      linearIdentifier: `ENG-${session}`,
      linearAgentSessionId: `session-${session}`,
      kind: "children",
      repositoryId: api,
      branch: `eng-${session}`,
      baseBranch: "main",
    });
    return run;
  }

  /** Sets a message's `created_at` to minute `minute` of Oct 1, 2026 (UTC), plus `us` microseconds. */
  async function createdAt(id: string, minute: number, us = 0) {
    const at = `2026-10-01T09:${String(minute).padStart(2, "0")}:00.${String(us).padStart(6, "0")}Z`;
    await db.execute(
      sql`update ralph_messages set created_at = ${at}::timestamptz where id = ${id}`,
    );
  }

  it("is null for an unknown run, and empty for a new one", async () => {
    expect(await getRunSession(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
    const run = await newRun();
    expect(await getRunSession(db, run.id)).toEqual({
      pendingRequests: [],
      messages: [],
      next: null,
      guidance: [],
      recommendations: [],
      progressLog: "",
    });
  });

  it("reads pending requests, messages, guidance, recommendations and the progress log", async () => {
    const run = await newRun();
    const webLane = await ensureLane(db, {
      runId: run.id,
      repositoryId: web,
      branch: "eng-web",
      baseBranch: "main",
    });
    const [first, second] = await upsertStories(db, run.id, [
      { linearIssueId: "s-1", identifier: "ENG-11", title: "One" },
      { linearIssueId: "s-2", identifier: "ENG-12", title: "Two" },
    ]);
    await updateStory(db, second!.id, {
      recommendations: [
        { title: "Fix the SDK", description: "Upstream bug.", at: "2026-10-01T10:00:00.000Z" },
      ],
    });
    await updateStory(db, first!.id, {
      recommendations: [{ title: "Pin node", description: "", at: "2026-10-01T09:00:00.000Z" }],
    });
    const { job } = await insertJob(db, {
      organizationId: orgId,
      type: "ralph.story",
      taskType: "coding",
      ralphRunId: run.id,
      ralphStoryId: first!.id,
    });
    await db.update(jobs).set({ status: "running", agentId }).where(eq(jobs.id, job.id));

    // Pending: the main lane's and the web lane's; not one handled, nor one for a session.
    const mainRequest = await insertMessage(db, {
      runId: run.id,
      kind: "request",
      text: "Open the MR",
      author: "Ada",
    });
    const webRequest = await insertMessage(db, {
      runId: run.id,
      laneId: webLane.id,
      kind: "request",
      text: "Bump the web app",
    });
    const handled = await insertMessage(db, { runId: run.id, kind: "request", text: "Done" });
    await consumeMessages(db, [handled.id]);
    const live = await insertMessage(db, {
      runId: run.id,
      jobId: job.id,
      kind: "guidance",
      text: "Use the new client",
      author: "Bo",
    });
    await createdAt(mainRequest.id, 1);
    await createdAt(webRequest.id, 2);
    await createdAt(live.id, 3);

    await appendGuidance(db, run.id, "older", new Date("2026-10-01T08:00:00Z"));
    await appendGuidance(db, run.id, "newer", new Date("2026-10-01T09:00:00Z"));
    await appendProgress(db, run.id, "## ENG-11\n- built it");

    const found = (await getRunSession(db, run.id))!;
    expect(found.pendingRequests).toEqual([
      {
        id: mainRequest.id,
        text: "Open the MR",
        author: "Ada",
        createdAt: new Date("2026-10-01T09:01:00Z"),
        repository: { id: api, provider: "gitlab", fullPath: "acme/api" },
      },
      {
        id: webRequest.id,
        text: "Bump the web app",
        author: null,
        createdAt: new Date("2026-10-01T09:02:00Z"),
        repository: { id: web, provider: "gitlab", fullPath: "acme/web" },
      },
    ]);
    expect(found.messages).toEqual([
      {
        id: live.id,
        kind: "guidance",
        text: "Use the new client",
        author: "Bo",
        createdAt: new Date("2026-10-01T09:03:00Z"),
        deliveredAt: null,
        consumedAt: null,
        attempt: {
          id: job.id,
          type: "ralph.story",
          status: "running",
          story: "ENG-11",
          agent: "coder-1",
        },
      },
    ]);
    expect(found.next).toBeNull();
    expect(found.guidance.map((g) => g.text)).toEqual(["newer", "older"]);
    expect(found.recommendations).toEqual([
      {
        story: { id: first!.id, identifier: "ENG-11", title: "One" },
        title: "Pin node",
        description: "",
        at: "2026-10-01T09:00:00.000Z",
      },
      {
        story: { id: second!.id, identifier: "ENG-12", title: "Two" },
        title: "Fix the SDK",
        description: "Upstream bug.",
        at: "2026-10-01T10:00:00.000Z",
      },
    ]);
    expect(found.progressLog).toBe("## ENG-11\n- built it");
  });

  it("pages messages newest first, also when they share a millisecond", async () => {
    const run = await newRun();
    const { job } = await insertJob(db, {
      organizationId: orgId,
      type: "ralph.request",
      taskType: "coding",
      ralphRunId: run.id,
    });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const message = await insertMessage(db, {
        runId: run.id,
        jobId: job.id,
        kind: "request",
        text: `m${i}`,
      });
      // m1–m3 share a millisecond, apart by microseconds.
      await createdAt(message.id, i === 0 ? 0 : i === 4 ? 2 : 1, i);
      ids.push(message.id);
    }
    const seen: string[] = [];
    let cursor = null;
    do {
      const page = await listRunSessionMessages(db, run.id, { cursor, limit: 2 });
      seen.push(...page.messages.map((m) => m.text));
      cursor = page.next;
    } while (cursor);
    expect(seen).toEqual(["m4", "m3", "m2", "m1", "m0"]);
  });

  it("records a change of the run when its messages change", async () => {
    const run = await newRun();
    const runChange = [
      { resource: "run", ids: [run.id], runId: run.id, organizationId: orgId },
    ].map((change) => expect.objectContaining(change));
    const inserted = await captureChanges(() =>
      insertMessage(db, { runId: run.id, kind: "request", text: "Please" }),
    );
    expect(inserted.changes).toEqual(runChange);
    expect(
      (
        await captureChanges(() =>
          updateMessage(db, inserted.result.id, { deliveredAt: new Date() }),
        )
      ).changes,
    ).toEqual(runChange);
    expect((await captureChanges(() => consumeMessages(db, [inserted.result.id]))).changes).toEqual(
      runChange,
    );
    // Nothing left to consume: no change.
    expect((await captureChanges(() => consumeMessages(db, [inserted.result.id]))).changes).toEqual(
      [],
    );
  });
});
