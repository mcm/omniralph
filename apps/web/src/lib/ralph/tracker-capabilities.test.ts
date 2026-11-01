/**
 * The ralph loop on a tracker with none of the optional capabilities (no
 * agent sessions, delegation, documents or uploads): an epic still runs end to
 * end, posting its progress and plan as comments on the epic's work item.
 */
import { randomBytes } from "node:crypto";
import {
  agents,
  claimJob,
  closeDb,
  completeJob,
  connectRepository,
  createDb,
  getJob,
  getMainLane,
  getRun,
  getRunBySession,
  jobs,
  listStories,
  organizations,
  ralphRuns,
  upsertScmConnection,
  type Database,
  type Job,
} from "@omniralph/db";
import {
  createTestDatabase,
  setCodingEnabled,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import {
  CODING_TASKS_MIN_AGENT_VERSION,
  MAX_JOB_DELIVERIES,
  type RalphStoryResult,
} from "@omniralph/shared";
import { FakeTrackerGateway, NO_CAPABILITIES } from "@omniralph/tracker/testing";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { setRoutingRules, teamIs } from "@/lib/routing/testing";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { taskSink } from "@/lib/sinks";
import { organizationPlaybooks } from "@/lib/playbooks";
import { PLAN_COMMENT_HEADING } from "./conversation";
import { onRalphJobFinished, onRalphJobStarted } from "./jobs";
import { startRun, type StartRunDeps } from "./start";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const sha = (n: number) => n.toString(16).padStart(40, "0");

describe.skipIf(!testDatabaseAvailable())(
  "the ralph loop on a tracker without capabilities",
  () => {
    let testDb: TestDatabase;
    let db: Database;
    let orgId: string;
    let repoId: string;
    let agentId: string;
    let tracker: FakeTrackerGateway;
    let scm: FakeScmAdapter;
    let dispatcher: PostgresDispatcher;

    const deps = (): StartRunDeps => ({
      db,
      organizationId: orgId,
      linear: tracker,
      dispatcher,
      adapterFor: () => scm.asAdapter(),
    });

    beforeAll(async () => {
      testDb = await createTestDatabase();
      db = createDb(testDb.uri);
      const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
      orgId = org!.id;
      const connection = (await upsertScmConnection(
        db,
        {
          organizationId: orgId,
          provider: "github",
          name: "acme",
          baseUrl: "https://api.github.com",
          externalId: "1",
          credentials: {},
        },
        randomBytes(32),
      ))!;
      repoId = (
        await connectRepository(db, {
          connectionId: connection.id,
          provider: "github",
          externalId: "1",
          fullPath: "acme/api",
        })
      ).id;
      await setCodingEnabled(db, repoId);
      await setRoutingRules(db, orgId, [repoId, teamIs("ENG")]);
    }, 180_000);

    afterAll(async () => {
      if (db) await closeDb(db);
      await testDb?.stop();
    });

    beforeEach(async () => {
      await db.delete(jobs);
      await db.delete(ralphRuns);
      await db.delete(agents);
      [{ id: agentId }] = (await db
        .insert(agents)
        .values({
          organizationId: orgId,
          name: "agent-a",
          reportedAcceptedTaskTypes: ["query", "review", "coding"],
        })
        .returning({ id: agents.id })) as [{ id: string }];
      tracker = new FakeTrackerGateway({ capabilities: NO_CAPABILITIES });
      scm = new FakeScmAdapter();
      dispatcher = new PostgresDispatcher({ db });
    });

    async function activeJob(runId: string): Promise<Job> {
      const active = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.ralphRunId, runId), inArray(jobs.status, ["queued", "running"])));
      expect(active).toHaveLength(1);
      return active[0]!;
    }

    /** Claims the run's job, completes it with `result` and runs its outcome hooks. */
    async function finish(
      runId: string,
      result: Record<string, unknown>,
      agentVersion: string,
    ): Promise<Job> {
      const job = await activeJob(runId);
      const { claim } = await claimJob(db, {
        organizationId: orgId,
        agentId,
        acceptedTaskTypes: ["query", "coding"],
        pools: ["short", "long"],
        agentVersion,
        maxDeliveries: MAX_JOB_DELIVERIES,
      });
      expect(claim?.job.id).toBe(job.id);
      const sink = await taskSink(job, organizationPlaybooks(db, orgId));
      if (job.type === "ralph.story") {
        expect(await onRalphJobStarted(db, job, agentId)).toEqual({ skip: false });
      } else {
        expect(await sink!.onStarted!(db, job, agentId)).toEqual({ skip: false });
      }
      await completeJob(db, { jobId: job.id, agentId, result });
      await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
      return job;
    }

    const storyResult = (
      commitSha: string,
      summary: string,
    ): RalphStoryResult & Record<string, unknown> => ({
      status: "complete",
      summary,
      commitSha,
      followUps: [],
      feedback: null,
      usage: { inputTokens: 10, outputTokens: 20 },
      durationMs: 1000,
    });

    const describeResult = {
      outcome: "answered",
      answer: null,
      structured: { title: "Build the epic", body: "Builds it." },
      references: [],
      usage: { inputTokens: 5, outputTokens: 5 },
      durationMs: 1000,
    };

    const commentsOn = (issueId: string) =>
      tracker.comments.filter((c) => c.issueId === issueId).map((c) => c.body);

    /** The latest plan commented on the work item. */
    const latestPlan = (issueId: string) =>
      commentsOn(issueId).findLast((body) => body.startsWith(PLAN_COMMENT_HEADING));

    it("runs an epic from delegation to its PR, with progress as work item comments", async () => {
      const epic = tracker.add({
        identifier: "ENG-1",
        title: "Epic",
        description: "Build the thing.\n\n## Quality Gates\n- `pnpm test`\n\n> Branch: feat/epic",
      });
      const alpha = tracker.add({
        identifier: "ENG-2",
        title: "Alpha",
        parentId: epic.id,
        priority: 1,
      });
      const beta = tracker.add({
        identifier: "ENG-3",
        title: "Beta",
        parentId: epic.id,
        priority: 2,
      });

      // Start: the tracker's delegation event (its session ID is the adapter's, with no session behind it).
      await startRun(
        { kind: "issue_delegated", sessionId: "delegation-1", issueId: epic.id },
        deps(),
      );
      const run = (await getRunBySession(db, "delegation-1"))!;
      expect(run).toMatchObject({ status: "running", repositoryId: repoId });
      expect(tracker.issues.get(epic.id)?.stateType).toBe("started");
      expect(tracker.issues.get(alpha.id)?.stateType).toBe("started");
      expect(latestPlan(epic.id)).toBe(
        [PLAN_COMMENT_HEADING, "", "- [ ] ⏳ ENG-2: Alpha", "- [ ] ENG-3: Beta"].join("\n"),
      );

      // Story completion: each story is completed and commented on, the plan follows.
      await finish(run.id, storyResult(sha(1), "Alpha done."), CODING_TASKS_MIN_AGENT_VERSION);
      expect(tracker.issues.get(alpha.id)?.stateType).toBe("completed");
      expect(commentsOn(alpha.id)).toEqual([
        `✅ Completed by Omniralph in \`${sha(1).slice(0, 10)}\` on \`feat/epic\`.\n\nAlpha done.`,
      ]);
      expect(latestPlan(epic.id)).toBe(
        [PLAN_COMMENT_HEADING, "", "- [x] ENG-2: Alpha", "- [ ] ⏳ ENG-3: Beta"].join("\n"),
      );
      await finish(run.id, storyResult(sha(2), "Beta done."), CODING_TASKS_MIN_AGENT_VERSION);
      expect(tracker.issues.get(beta.id)?.stateType).toBe("completed");

      // Finish: the PR is described and opened, linked to the epic, and the run's summary commented.
      const describe = await finish(run.id, describeResult, "99.0.0");
      expect(describe.type).toBe("ralph.describe-pr");
      const done = (await getRun(db, run.id))!;
      expect(done.status).toBe("completed");
      expect((await getMainLane(db, done))?.prUrl).toBe("https://github.com/acme/api/pull/1");
      expect((await listStories(db, run.id)).map((s) => [s.identifier, s.status])).toEqual([
        ["ENG-2", "completed"],
        ["ENG-3", "completed"],
      ]);
      expect(tracker.links).toEqual([
        { issueId: epic.id, url: "https://github.com/acme/api/pull/1", title: "Pull request #1" },
      ]);
      const final = commentsOn(epic.id);
      expect(latestPlan(epic.id)).toBe(
        [PLAN_COMMENT_HEADING, "", "- [x] ENG-2: Alpha", "- [x] ENG-3: Beta"].join("\n"),
      );
      expect(final.at(-1)).toMatch(
        /^Finished all 2 stories of \*\*ENG-1\*\* on `feat\/epic`\. Opened \[Pull request #1\]/,
      );
      // Each plan is commented once, and nothing failed.
      const plans = final.filter((body) => body.startsWith(PLAN_COMMENT_HEADING));
      expect(new Set(plans).size).toBe(plans.length);
      expect(tracker.comments.filter((c) => c.body.startsWith("⚠️"))).toEqual([]);
      expect(tracker.sessionsCreated).toEqual([]);
      expect(tracker.delegations).toEqual([]);
    });
  },
);
