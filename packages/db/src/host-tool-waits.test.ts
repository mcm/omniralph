// A queued job says when no online agent of its organization has the host tools it needs.
import type { HostToolReport } from "@omniralph/shared";
import { eq } from "drizzle-orm";
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAgentEnrollment,
  enrollAgent,
  revokeAgent,
  rotateRefreshToken,
} from "./agent-auth.js";
import { markAgentLiveOnline, markAgentsLiveOffline } from "./agents.js";
import { captureChanges } from "./changes.js";
import { closeDb, createDb, type Database } from "./client.js";
import {
  claimJob,
  failJob,
  insertJob,
  recordAgentHeartbeat,
  refreshHostToolWaits,
  setQueuedJobTarget,
} from "./jobs.js";
import { agents, jobs, organizations } from "./schema.js";

const gh: HostToolReport = { name: "gh", path: "/usr/bin/gh", source: "discovered", problem: null };
const ghBlocked: HostToolReport = { name: "gh", path: null, source: null, problem: "blocked" };
const opengrep: HostToolReport = {
  name: "opengrep",
  path: "/opt/opengrep",
  source: "configured",
  problem: null,
};

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("host tool waits", () => {
  let testDb: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  const organization = async () => {
    const [row] = await db.insert(organizations).values({ name: "Acme" }).returning();
    return row!.id;
  };

  const agent = async (
    organizationId: string,
    reportedHostTools: HostToolReport[],
    extra: Partial<typeof agents.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(agents)
      .values({ organizationId, name: "agent", reportedHostTools, liveOnline: true, ...extra })
      .returning();
    return row!.id;
  };

  const enqueue = async (
    organizationId: string,
    requiredHostTools: string[],
    targetAgentId: string | null = null,
  ) =>
    (
      await insertJob(db, {
        organizationId,
        type: "chat.ask",
        taskType: "query",
        requiredHostTools,
        targetAgentId,
      })
    ).job;

  const reasonOf = async (jobId: string) =>
    (await db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!.waitingReason;

  const runChanges = (changes: { resource: string; ids: string[] }[]) =>
    changes.filter((c) => c.resource === "run").flatMap((c) => c.ids);

  it("sets the missing tool when no agent has it, from the enqueue on", async () => {
    const org = await organization();
    await agent(org, [opengrep]);
    const { result: job, changes } = await captureChanges(() => enqueue(org, ["gh"]));
    expect(job.waitingReason).toEqual({ code: "host_tools_missing", hostTools: ["gh"] });
    expect(await reasonOf(job.id)).toEqual({ code: "host_tools_missing", hostTools: ["gh"] });
    expect(runChanges(changes)).toContain(job.id);
  });

  it("leaves it null when an online agent reports the tool with a path", async () => {
    const org = await organization();
    await agent(org, [gh]);
    const job = await enqueue(org, ["gh"]);
    expect(job.waitingReason).toBeNull();
    expect(await reasonOf(job.id)).toBeNull();
    // Nothing changed: no run event.
    const again = await captureChanges(() => refreshHostToolWaits({ db, organizationId: org }));
    expect(again.result).toEqual([]);
    expect(again.changes).toEqual([]);
  });

  it("leaves jobs without required host tools alone", async () => {
    const org = await organization();
    const job = await enqueue(org, []);
    expect(await refreshHostToolWaits({ db, organizationId: org })).toEqual([]);
    expect(await reasonOf(job.id)).toBeNull();
  });

  it("sets it when the only agent with the tool goes offline, and clears it when it's back", async () => {
    const org = await organization();
    const id = await agent(org, [gh]);
    const job = await enqueue(org, ["gh"]);
    expect(job.waitingReason).toBeNull();

    const offline = await captureChanges(() => markAgentsLiveOffline(db, [id]));
    expect(await reasonOf(job.id)).toEqual({ code: "host_tools_missing", hostTools: ["gh"] });
    expect(runChanges(offline.changes)).toEqual([job.id]);

    // Its next heartbeat announces it online, which refreshes the waits.
    const online = await captureChanges(() => markAgentLiveOnline(db, id));
    expect(await reasonOf(job.id)).toBeNull();
    expect(runChanges(online.changes)).toEqual([job.id]);
  });

  it("sets it when the only agent with the tool reports it blocked, from the heartbeat", async () => {
    const org = await organization();
    const id = await agent(org, [gh]);
    const job = await enqueue(org, ["gh"]);
    const blocked = await captureChanges(() =>
      recordAgentHeartbeat(db, id, { version: "2.0.4", hostTools: [ghBlocked] }),
    );
    expect(await reasonOf(job.id)).toEqual({ code: "host_tools_missing", hostTools: ["gh"] });
    expect(runChanges(blocked.changes)).toEqual([job.id]);

    // The same report again changes nothing and publishes no run event.
    const steady = await captureChanges(() =>
      recordAgentHeartbeat(db, id, { version: "2.0.4", hostTools: [ghBlocked] }),
    );
    expect(runChanges(steady.changes)).toEqual([]);

    await recordAgentHeartbeat(db, id, { version: "2.0.4", hostTools: [gh] });
    expect(await reasonOf(job.id)).toBeNull();
  });

  it("names every missing tool, sorted", async () => {
    const org = await organization();
    const job = await enqueue(org, ["opengrep", "gh", "opengrep"]);
    expect(job.waitingReason).toEqual({
      code: "host_tools_missing",
      hostTools: ["gh", "opengrep"],
    });
  });

  it("ignores another organization's agents", async () => {
    const org = await organization();
    await agent(await organization(), [gh]);
    const job = await enqueue(org, ["gh"]);
    expect(job.waitingReason).toEqual({ code: "host_tools_missing", hostTools: ["gh"] });
  });

  it("ignores revoked agents", async () => {
    const org = await organization();
    await agent(org, [gh], { revokedAt: new Date() });
    const job = await enqueue(org, ["gh"]);
    expect(job.waitingReason).toEqual({ code: "host_tools_missing", hostTools: ["gh"] });
  });

  it("checks only the target agent of a targeted job", async () => {
    const org = await organization();
    await agent(org, [gh]);
    const target = await agent(org, [opengrep]);
    const job = await enqueue(org, ["gh"], target);
    expect(job.waitingReason).toEqual({ code: "host_tools_missing", hostTools: ["gh"] });
    // Any agent may claim it again: the other agent's gh counts.
    await setQueuedJobTarget(db, job.id, null);
    expect(await reasonOf(job.id)).toBeNull();
    const withGh = await agent(org, [gh, opengrep]);
    const targeted = await enqueue(org, ["gh", "opengrep"], withGh);
    expect(targeted.waitingReason).toBeNull();
  });

  it("clears it on the job a claim takes", async () => {
    const org = await organization();
    const id = await agent(org, []);
    const job = await enqueue(org, ["gh"]);
    expect(job.waitingReason).not.toBeNull();
    // Reported on the next heartbeat, but still offline: the reason stays meanwhile.
    await markAgentsLiveOffline(db, [id]);
    await recordAgentHeartbeat(db, id, { version: "2.0.4", hostTools: [gh] });
    expect(await reasonOf(job.id)).not.toBeNull();
    const { claim } = await claimJob(db, {
      agentId: id,
      organizationId: org,
      acceptedTaskTypes: ["query"],
      pools: ["short"],
      agentVersion: "2.0.4",
      maxDeliveries: 3,
    });
    expect(claim?.job.id).toBe(job.id);
    expect(claim?.job.waitingReason).toBeNull();
    expect(await reasonOf(job.id)).toBeNull();
  });

  const claim = (agentId: string, organizationId: string) =>
    claimJob(db, {
      agentId,
      organizationId,
      acceptedTaskTypes: ["query"],
      pools: ["short"],
      agentVersion: "2.0.4",
      maxDeliveries: 3,
    });

  it("sets it when the only agent with the tool is revoked, on the jobs it ran too", async () => {
    const org = await organization();
    const id = await agent(org, [gh]);
    const running = await enqueue(org, ["gh"]);
    expect((await claim(id, org)).claim?.job.id).toBe(running.id);
    const queued = await enqueue(org, ["gh"]);
    expect(queued.waitingReason).toBeNull();

    const revoked = await captureChanges(() => revokeAgent(db, id));
    expect(revoked.result?.requeuedJobs.map((j) => j.id)).toEqual([running.id]);
    for (const job of [running, queued]) {
      expect(await reasonOf(job.id)).toEqual({ code: "host_tools_missing", hostTools: ["gh"] });
    }
    expect(runChanges(revoked.changes)).toEqual(expect.arrayContaining([running.id, queued.id]));
  });

  it("sets it when a reused refresh token revokes the only agent with the tool", async () => {
    const org = await organization();
    const { token } = await createAgentEnrollment(db, { organizationId: org });
    const enrolled = await enrollAgent(db, {
      enrollmentToken: token,
      name: "agent",
      version: "2.0.4",
    });
    await db
      .update(agents)
      .set({ reportedHostTools: [gh], liveOnline: true })
      .where(eq(agents.id, enrolled!.agentId));
    const job = await enqueue(org, ["gh"]);
    expect(job.waitingReason).toBeNull();

    await rotateRefreshToken(db, enrolled!.refreshToken);
    expect((await rotateRefreshToken(db, enrolled!.refreshToken)).status).toBe("reused");
    expect(await reasonOf(job.id)).toEqual({ code: "host_tools_missing", hostTools: ["gh"] });
  });

  it("sets it on a retried job when no online agent has the tool any more", async () => {
    const org = await organization();
    const id = await agent(org, [gh]);
    const job = await enqueue(org, ["gh"]);
    expect((await claim(id, org)).claim?.job.id).toBe(job.id);
    await markAgentsLiveOffline(db, [id]);

    const retried = await failJob(db, {
      jobId: job.id,
      agentId: id,
      retryable: true,
      maxDeliveries: 3,
    });
    expect(retried.status).toBe("retry");
    expect(await reasonOf(job.id)).toEqual({ code: "host_tools_missing", hostTools: ["gh"] });
  });
});
