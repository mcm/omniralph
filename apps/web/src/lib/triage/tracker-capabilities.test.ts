/**
 * Triage on a tracker without the optional capabilities (no agent sessions, delegation,
 * documents or uploads): it reports in the work item's comments instead of a session, and
 * leaves the delegate alone.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  closeDb,
  createDb,
  getJob,
  getTriageRun,
  jobs,
  organizations,
  ralphRuns,
  triageRuns,
  type Database,
  type Job,
} from "@omniralph/db";
import type { ScmAdapter } from "@omniralph/scm";
import type { QueryRunResult } from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { FakeTrackerGateway, NO_CAPABILITIES } from "@omniralph/tracker/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const { PostgresDispatcher } = await import("@/lib/dispatch/dispatcher");
const { acknowledgeTrackerEvent, handleTrackerEvent } = await import("@/lib/tracker/events");
const { COMMENT_CONVERSATION_PREFIX } = await import("@/lib/tracker/sessions");
const { onTriageJobCompleted } = await import("./apply");
const { releaseTriageDelegation } = await import("./label");

const databaseAvailable = testDatabaseAvailable();

const PRD = [
  "As an admin, I want this done so that I can rely on it. Rotate the keys.",
  "",
  "## Acceptance Criteria",
  "",
  "- [ ] It works",
].join("\n");

const RESULT: QueryRunResult = {
  outcome: "answered",
  answer: null,
  structured: {
    outcome: "prd",
    size: "S",
    title: "Rotate keys",
    description: PRD,
    openQuestions: [],
    stories: [],
    subIssueUpdates: [],
    summary: "Wrote the PRD.",
  },
  references: [],
  usage: { inputTokens: 1, outputTokens: 1 },
  durationMs: 10,
};

describe.skipIf(!databaseAvailable)("triage on a tracker without optional capabilities", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let tracker: FakeTrackerGateway;

  const fakeAdapter = { getDefaultBranch: async () => "main" } as unknown as ScmAdapter;
  const context = () => ({ db, organizationId: orgId, workspaceId: "ws-1" });
  const handle = (event: Parameters<typeof handleTrackerEvent>[0]) =>
    handleTrackerEvent(event, context(), {
      tracker,
      dispatcher: new PostgresDispatcher({ db }),
      adapterFor: () => fakeAdapter,
    });

  const commentsOn = (issueId: string) =>
    tracker.comments.filter((c) => c.issueId === issueId).map((c) => c.body);

  const complete = async (jobId: string, result: unknown) => {
    const [done] = await db
      .update(jobs)
      .set({ status: "completed", result: result as Record<string, unknown> })
      .where(eq(jobs.id, jobId))
      .returning();
    return done as Job;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(triageRuns);
    await db.delete(jobs);
    await db.delete(ralphRuns);
    tracker = new FakeTrackerGateway({ capabilities: NO_CAPABILITIES });
  });

  it("triages a labeled item in its comments, then applies the PRD and removes the label", async () => {
    const issue = tracker.add({ title: "rotate keys", stateType: "backlog", labels: ["ops"] });
    const label = await tracker.createLabel(issue.teamId, "coding:triage");
    await tracker.addIssueLabels(issue.id, [label.id]);
    tracker.labelChanges.length = 0;

    await handle({
      kind: "triage_requested",
      issueId: issue.id,
      identifier: issue.identifier,
      labelId: label.id,
    });

    const [run] = await db.select().from(triageRuns);
    expect(run).toMatchObject({ trackerIssueId: issue.id, trigger: "label", status: "queued" });
    // No session to open: the conversation lives in the item's comments.
    expect(run!.trackerSessionId.startsWith(COMMENT_CONVERSATION_PREFIX)).toBe(true);
    expect(tracker.sessionsCreated).toEqual([]);
    expect(await getJob(db, run!.currentJobId!)).toMatchObject({ type: "triage.run" });
    expect(commentsOn(issue.id)).toEqual([
      expect.stringContaining(`Triaging **${issue.identifier}**`),
    ]);

    await onTriageJobCompleted(db, await complete(run!.currentJobId!, RESULT), {
      db,
      tracker,
    });

    expect((await getTriageRun(db, run!.id))?.status).toBe("completed");
    expect((await tracker.getIssue(issue.id)).description).toContain("Rotate the keys.");
    expect(tracker.labelChanges).toEqual([{ issueId: issue.id, removed: [label.id] }]);
    // The final response is a comment too, and nothing was delegated.
    expect(commentsOn(issue.id)).toHaveLength(2);
    expect(tracker.delegations).toEqual([]);
  });

  it("answers a /triage mention in the item's comments", async () => {
    const issue = tracker.add({ title: "rotate keys", stateType: "started" });

    await handle({
      kind: "issue_mentioned",
      sessionId: `${COMMENT_CONVERSATION_PREFIX}mention-1`,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      commentBody: "@omniralph /triage",
    });

    // Triage refuses an item in progress, and says so on the item.
    expect(await db.select().from(jobs)).toEqual([]);
    expect(commentsOn(issue.id)).toEqual([
      expect.stringContaining(`**${issue.identifier}** is already in progress or done`),
    ]);
  });

  it("acknowledges nothing, since no session waits for it", async () => {
    const issue = tracker.add({ title: "rotate keys" });
    await acknowledgeTrackerEvent(
      { kind: "issue_delegated", sessionId: "comments:x", issueId: issue.id },
      context(),
      tracker,
    );
    expect(tracker.comments).toEqual([]);
    expect(tracker.activities).toEqual([]);
  });

  it("has no delegate to release", async () => {
    const issue = tracker.add({ title: "rotate keys" });
    expect(await releaseTriageDelegation({ db, organizationId: orgId, tracker }, issue.id)).toBe(
      false,
    );
  });
});
