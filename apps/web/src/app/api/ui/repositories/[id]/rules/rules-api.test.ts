import { randomBytes } from "node:crypto";
import {
  connectRepository,
  closeDb,
  createDb,
  createReview,
  createReviewRun,
  deleteReviewRun,
  feedback,
  findings,
  getJob,
  getReview,
  jobs,
  listRepositoryRules,
  rules,
  upsertScmConnection,
  users,
  type Database,
  type FindingRow,
  type Job,
  organizations,
  reviews,
} from "@omniralph/db";
import {
  QUERY_TASKS_MIN_AGENT_VERSION,
  reviewTriggerContext,
  RunSpecJobPayload,
  type QueryRunResult,
} from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { captureChanges } from "@omniralph/db/changes";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";
import type * as Adapters from "@/lib/scm/adapters";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  orgId: "",
  db: undefined as unknown as Database,
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  // The signed-in user works in `state.orgId`.
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));
vi.mock("@/lib/scm/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  scmAdapterFor: () => ({ resolveThread: async () => undefined }),
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const rulesRoute = await import("@/app/api/ui/repositories/[id]/rules/route");
const ruleRoute = await import("@/app/api/ui/repositories/[id]/rules/[ruleId]/route");
const { enqueueReview } = await import("@/lib/review/enqueue");
const { getDispatcher } = await import("@/lib/dispatch");
const { dismissFindingWithFeedback } = await import("@/lib/reviews/feedback");
const { jobHooks, parseSinkResult, sinkFor } = await import("@/lib/sinks");
const { organizationPlaybooks } = await import("@/lib/playbooks");
const { enqueueLearnRule } = await import("@/lib/rules/learn");
const { ruleView } = await import("@/lib/rules/display");

const databaseAvailable = testDatabaseAvailable();

type Result = { ok: true; warning?: string } | { ok: false; error: string; fieldErrors?: object };

/** Calls an `/api/ui` rules handler as the Rules tab does; answers its `ActionResult`. */
async function call<P extends Record<string, string>>(
  handler: (request: Request, route: { params: Promise<P> }) => Promise<Response>,
  method: string,
  params: P,
  body?: unknown,
): Promise<Result> {
  const response = await handler(
    new Request("http://localhost/api/ui", {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  );
  const json = (await response.json()) as Record<string, unknown>;
  if (response.ok) return json as Result;
  return {
    ok: false,
    error: json.error as string,
    ...(json.fieldErrors ? { fieldErrors: json.fieldErrors as object } : {}),
  };
}

// The Rules tab's requests, under the names of the server actions they replace.
const addCustomRule = (id: string, input: unknown) => call(rulesRoute.POST, "POST", { id }, input);
const editRule = (id: string, ruleId: string, input: unknown) =>
  call(ruleRoute.PATCH, "PATCH", { id, ruleId }, input);
const setRuleEnabled = (id: string, ruleId: string, enabled: boolean) =>
  call(ruleRoute.PATCH, "PATCH", { id, ruleId }, { enabled });
const deleteRule = (id: string, ruleId: string) => call(ruleRoute.DELETE, "DELETE", { id, ruleId });

const SHA = (n: number) => n.toString(16).padStart(40, "0");
const admin = { id: "admin-1", role: "admin" as const, name: null, email: null, image: null };
const member = { id: "member-1", role: "member" as const, name: null, email: null, image: null };

describe.skipIf(!databaseAvailable)("repository rules and learned rules", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let reviewId: string;
  let prNumber = 100;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    state.orgId = orgId;
    state.db = db;
    await db.insert(users).values([
      { id: "admin-1", name: "Ada Admin", email: "ada@example.com" },
      { id: "member-1", name: "Mia Member", email: "mia@example.com" },
    ]);
    const connection = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "gitlab",
      name: "bot",
      baseUrl: "https://gitlab.example.com",
      externalId: "5",
      credentials: { token: "glpat-bot", webhookSecret: "hook" },
    }))!;
    repoId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "gitlab",
        externalId: "101",
        fullPath: "acme/api",
      })
    ).id;
    reviewId = (
      await createReview(db, {
        repositoryId: repoId,
        prNumber: 42,
        headSha: SHA(2),
        baseSha: SHA(1),
        trigger: "webhook",
        depth: "standard",
        model: null,
        budget: 100_000,
      })
    ).id;
  }, 180_000);

  beforeEach(async () => {
    state.user = admin;
    await db.delete(rules);
    await db.delete(jobs);
    await db.delete(findings);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  async function addFinding(over: Partial<typeof findings.$inferInsert> = {}): Promise<FindingRow> {
    const [row] = await db
      .insert(findings)
      .values({
        reviewId,
        path: "src/config.ts",
        startLine: 3,
        endLine: 4,
        severity: "medium",
        category: "correctness",
        title: "Missing null check",
        body: "`config.get()` can return undefined.",
        confidence: 0.7,
        scmCommentId: "discussion-1",
        ...over,
      })
      .returning();
    return row!;
  }

  async function learnRuleJobs(): Promise<Job[]> {
    return db.select().from(jobs).where(eq(jobs.type, "review.learn-rule"));
  }

  /** Dismisses a new finding as a false positive and returns its rule-generation job. */
  async function dismissFalsePositive(note = "config.get() throws on missing keys") {
    const finding = await addFinding();
    const result = await dismissFindingWithFeedback(db, {
      findingId: finding.id,
      reason: "false_positive",
      note,
      scmUsername: "octocat",
    });
    if (result.status !== "ok" || !result.learnRuleJobId) throw new Error("no learn-rule job");
    return { finding, job: (await getJob(db, result.learnRuleJobId))! };
  }

  /** Completes a rule generation with `result`, like `/result` does. */
  async function complete(job: Job, result: QueryRunResult): Promise<Job> {
    const [row] = await db
      .update(jobs)
      .set({ status: "completed", result, finishedAt: new Date() })
      .where(eq(jobs.id, job.id))
      .returning();
    return row!;
  }

  const ruleResult = (rule: string | null): QueryRunResult => ({
    outcome: "answered",
    answer: null,
    structured: { rule },
    references: [],
    usage: { inputTokens: 1800, outputTokens: 60 },
    durationMs: 1200,
  });

  /** Applies a completed rule generation through the job's hooks (its task's `learned-rule` sink), like `/result` does. */
  async function onLearnRuleJobCompleted(_db: Database, job: Job): Promise<unknown> {
    const hooks = await jobHooks(job, organizationPlaybooks(db, job.organizationId));
    return hooks!.onCompleted!(db, job);
  }

  async function nextReviewRules() {
    prNumber += 1;
    const result = await enqueueReview(db, getDispatcher(), {
      repositoryId: repoId,
      prNumber,
      baseSha: SHA(1),
      headSha: SHA(2),
      title: "Change",
      description: null,
      author: "dev",
      trigger: "webhook",
    });
    if (result.status !== "enqueued") throw new Error(result.status);
    const job = await getJob(db, result.jobId);
    return reviewTriggerContext(job!.payload).reviewConfig.rules;
  }

  describe("rule generation from false-positive dismissals", () => {
    it("enqueues a builtin:learn-rule run with the finding, the note, the commits and the repository", async () => {
      const { finding, job } = await dismissFalsePositive();
      expect(job).toMatchObject({
        type: "review.learn-rule",
        taskType: "query",
        taskId: "builtin:learn-rule",
        minAgentVersion: QUERY_TASKS_MIN_AGENT_VERSION,
        repositoryId: repoId,
        status: "queued",
        targetAgentId: null,
        dedupeKey: expect.stringMatching(/^review\.learn-rule:[0-9a-f-]{36}$/),
      });
      const payload = RunSpecJobPayload.parse(job.payload);
      expect(payload).toEqual({
        trigger: {
          kind: "finding.dismissed",
          context: {
            feedbackId: expect.any(String),
            repository: "acme/api",
            finding: {
              id: finding.id,
              path: "src/config.ts",
              file: '"src/config.ts"',
              startLine: 3,
              endLine: 4,
              location: "lines 3-4",
              severity: "medium",
              category: "correctness",
              title: "Missing null check",
              body: "`config.get()` can return undefined.",
              baseSha: SHA(1),
              headSha: SHA(2),
            },
            dismissal: { note: "config.get() throws on missing keys" },
          },
        },
        repositoryId: repoId,
      });
      expect(job.dedupeKey).toBe(`review.learn-rule:${String(payload.trigger.context.feedbackId)}`);
      expect((await db.select().from(jobs)).map((j) => j.id)).toEqual([job.id]);
    });

    it("enqueues once per feedback row (same dedupe key as before the port)", async () => {
      const { finding, job } = await dismissFalsePositive();
      const [row] = await db.select().from(feedback).where(eq(feedback.findingId, finding.id));
      const again = await enqueueLearnRule(db, getDispatcher(), {
        feedback: row!,
        finding,
        review: (await getReview(db, reviewId))!,
      });
      expect(again).toEqual({ status: "duplicate", jobId: job.id });
      expect(await learnRuleJobs()).toHaveLength(1);
    });

    it("enqueues for @bot dismiss (scm) feedback too, but not for other reasons", async () => {
      const scm = await addFinding();
      const result = await dismissFindingWithFeedback(db, {
        findingId: scm.id,
        reason: "false_positive",
        scmUsername: "octocat",
      });
      expect(result).toMatchObject({ status: "ok", learnRuleJobId: expect.any(String) });

      for (const reason of ["wont_fix", "not_relevant", "other"] as const) {
        const finding = await addFinding();
        const other = await dismissFindingWithFeedback(db, {
          findingId: finding.id,
          reason,
          scmUsername: "octocat",
        });
        expect(other).toMatchObject({ status: "ok" });
        expect(other).not.toHaveProperty("learnRuleJobId");
      }
      expect(await learnRuleJobs()).toHaveLength(1);
    });

    it("stores a returned rule as an enabled learned rule linked to the finding", async () => {
      const { finding, job } = await dismissFalsePositive();
      const text =
        "Do not flag missing null checks on config.get() results; it throws on missing keys.";
      const done = await complete(job, ruleResult(text));
      expect(await onLearnRuleJobCompleted(db, done)).toMatchObject({ status: "inserted" });

      const [rule] = await db.select().from(rules);
      expect(rule).toMatchObject({
        repositoryId: repoId,
        kind: "learned",
        text,
        enabled: true,
        sourceFindingId: finding.id,
        createdBy: null,
      });
      // Its usage stays recorded on the job.
      expect((await getJob(db, job.id))!.result).toMatchObject({
        usage: { inputTokens: 1800, outputTokens: 60 },
      });
      // A replayed result doesn't add it twice.
      expect(await onLearnRuleJobCompleted(db, done)).toMatchObject({ status: "duplicate" });
      expect(await db.select().from(rules)).toHaveLength(1);
    });

    it("doesn't insert near-duplicates of existing rules (custom or learned, enabled or not)", async () => {
      await addCustomRule(repoId, { text: "Do not flag eval() in test fixtures." });
      const [custom] = await db.select().from(rules);
      await setRuleEnabled(repoId, custom!.id, false);

      const first = await dismissFalsePositive();
      const nearCustom = await complete(
        first.job,
        ruleResult("Do not flag eval in test fixtures!"),
      );
      expect(await onLearnRuleJobCompleted(db, nearCustom)).toMatchObject({
        status: "duplicate",
        rule: { id: custom!.id },
      });

      const second = await dismissFalsePositive();
      const learnedText =
        "Do not flag missing null checks on values returned by config.get(); it throws on missing keys.";
      await onLearnRuleJobCompleted(db, await complete(second.job, ruleResult(learnedText)));
      const third = await dismissFalsePositive();
      const similar =
        "Do not flag missing null checks on values returned from config.get(); it throws on missing keys.";
      expect(
        await onLearnRuleJobCompleted(db, await complete(third.job, ruleResult(similar))),
      ).toMatchObject({ status: "duplicate" });

      const fourth = await dismissFalsePositive();
      const different = "Do not flag string concatenation in log messages as a performance issue.";
      expect(
        await onLearnRuleJobCompleted(db, await complete(fourth.job, ruleResult(different))),
      ).toMatchObject({ status: "inserted" });

      expect((await db.select().from(rules)).map((r) => r.text).sort()).toEqual(
        [learnedText, different, "Do not flag eval() in test fixtures."].sort(),
      );
    });

    it("stores nothing for a null rule or a finding restored in the meantime", async () => {
      const none = await dismissFalsePositive();
      expect(await onLearnRuleJobCompleted(db, await complete(none.job, ruleResult(null)))).toEqual(
        { status: "no_rule" },
      );

      const restored = await dismissFalsePositive();
      // Feedback restored before its rule came back. Nothing restores findings any more, but
      // feedback from before keeps its `restoredAt`.
      await db
        .update(feedback)
        .set({ restoredAt: new Date() })
        .where(eq(feedback.findingId, restored.finding.id));
      expect(
        await onLearnRuleJobCompleted(
          db,
          await complete(restored.job, ruleResult("Do not flag X.")),
        ),
      ).toEqual({ status: "feedback_withdrawn" });
      expect(await db.select().from(rules)).toEqual([]);
    });

    it("stores nothing for a rule over 300 characters or a run out of budget", async () => {
      const long = await dismissFalsePositive();
      expect(
        await onLearnRuleJobCompleted(db, await complete(long.job, ruleResult("x".repeat(301)))),
      ).toEqual({ status: "no_rule" });
      const exhausted = await dismissFalsePositive();
      const budget: QueryRunResult = {
        ...ruleResult(null),
        outcome: "budget_exhausted",
        structured: null,
      };
      expect(await onLearnRuleJobCompleted(db, await complete(exhausted.job, budget))).toEqual({
        status: "no_rule",
      });
      expect(await db.select().from(rules)).toEqual([]);
    });

    it("validates results: a query run result with a {rule} structured output", () => {
      const sink = sinkFor("learned-rule")!;
      expect(parseSinkResult(sink, ruleResult("Do not flag X."))).not.toBeNull();
      expect(parseSinkResult(sink, ruleResult(null))).not.toBeNull();
      expect(
        parseSinkResult(sink, {
          ...ruleResult(null),
          outcome: "budget_exhausted",
          structured: null,
        }),
      ).not.toBeNull();
      expect(parseSinkResult(sink, { ...ruleResult(null), structured: { rule: 1 } })).toBeNull();
      expect(
        parseSinkResult(sink, { ...ruleResult(null), structured: { rule: "x", extra: 1 } }),
      ).toBeNull();
      expect(
        parseSinkResult(sink, { ...ruleResult(null), structured: null, answer: "Do not flag X." }),
      ).toBeNull();
      expect(parseSinkResult(sink, { rule: "x", outcome: "rule" })).toBeNull();
    });
  });

  describe("managing rules", () => {
    it("lets admins add, edit, disable and delete custom rules", async () => {
      expect(
        await addCustomRule(repoId, { text: "  Flag every TODO without an issue link.  " }),
      ).toEqual({
        ok: true,
      });
      const [rule] = await db.select().from(rules);
      expect(rule).toMatchObject({
        kind: "custom",
        text: "Flag every TODO without an issue link.",
        enabled: true,
        createdBy: "admin-1",
        sourceFindingId: null,
      });

      expect(
        await editRule(repoId, rule!.id, { text: "Flag TODOs without an issue link." }),
      ).toEqual({
        ok: true,
      });
      expect(await setRuleEnabled(repoId, rule!.id, false)).toEqual({ ok: true });
      let [row] = await db.select().from(rules);
      expect(row).toMatchObject({ text: "Flag TODOs without an issue link.", enabled: false });

      expect(await setRuleEnabled(repoId, rule!.id, true)).toEqual({ ok: true });
      [row] = await db.select().from(rules);
      expect(row!.enabled).toBe(true);

      expect(await deleteRule(repoId, rule!.id)).toEqual({ ok: true });
      expect(await db.select().from(rules)).toEqual([]);
      expect(await deleteRule(repoId, rule!.id)).toEqual({
        ok: false,
        error: "That rule doesn't exist.",
      });
    });

    it("publishes the repository's change for every rule write, and none for a refused one", async () => {
      const repositoryChange = [
        expect.objectContaining({ resource: "repository", ids: [repoId], organizationId: orgId }),
      ];
      const added = await captureChanges(() => addCustomRule(repoId, { text: "Flag TODOs." }));
      expect(added.result).toEqual({ ok: true });
      expect(added.changes).toEqual(repositoryChange);
      const [rule] = await db.select().from(rules);
      for (const write of [
        () => editRule(repoId, rule!.id, { text: "Flag every TODO." }),
        () => setRuleEnabled(repoId, rule!.id, false),
        () => deleteRule(repoId, rule!.id),
      ]) {
        const { result, changes } = await captureChanges(write);
        expect(result).toEqual({ ok: true });
        expect(changes).toEqual(repositoryChange);
      }
      const refused = await captureChanges(() => addCustomRule(repoId, { text: "  " }));
      expect(refused.result).toMatchObject({ ok: false });
      expect(refused.changes).toEqual([]);
      state.user = member;
      const forbidden = await captureChanges(() => addCustomRule(repoId, { text: "Flag TODOs." }));
      expect(forbidden.result).toMatchObject({ ok: false });
      expect(forbidden.changes).toEqual([]);
      state.user = admin;
    });

    it("edits, disables and deletes learned rules", async () => {
      const { job } = await dismissFalsePositive();
      await onLearnRuleJobCompleted(db, await complete(job, ruleResult("Do not flag X.")));
      const [learned] = await db.select().from(rules);
      expect(await editRule(repoId, learned!.id, { text: "Do not flag X in tests." })).toEqual({
        ok: true,
      });
      expect(await setRuleEnabled(repoId, learned!.id, false)).toEqual({ ok: true });
      expect((await db.select().from(rules))[0]).toMatchObject({
        kind: "learned",
        text: "Do not flag X in tests.",
        enabled: false,
      });
      expect(await deleteRule(repoId, learned!.id)).toEqual({ ok: true });
    });

    it("validates the text and requires an admin", async () => {
      expect(await addCustomRule(repoId, { text: "   " })).toMatchObject({
        ok: false,
        fieldErrors: { text: "Enter the rule." },
      });
      expect(await addCustomRule(repoId, { text: "x".repeat(1001) })).toMatchObject({
        ok: false,
        fieldErrors: { text: expect.stringContaining("1000") },
      });
      expect(await addCustomRule("not-a-uuid", { text: "x" })).toMatchObject({ ok: false });

      state.user = member;
      expect(await addCustomRule(repoId, { text: "Flag TODOs." })).toMatchObject({ ok: false });
      state.user = admin;
      await addCustomRule(repoId, { text: "Flag TODOs." });
      const [rule] = await db.select().from(rules);
      state.user = member;
      expect(await editRule(repoId, rule!.id, { text: "Changed" })).toMatchObject({ ok: false });
      expect(await setRuleEnabled(repoId, rule!.id, false)).toMatchObject({ ok: false });
      expect(await deleteRule(repoId, rule!.id)).toMatchObject({ ok: false });
      expect(await db.select().from(rules)).toMatchObject([{ text: "Flag TODOs.", enabled: true }]);
    });

    it("lists rules with their creator and the learned rule's source finding", async () => {
      await addCustomRule(repoId, { text: "Flag TODOs." });
      const { finding, job } = await dismissFalsePositive();
      await onLearnRuleJobCompleted(db, await complete(job, ruleResult("Do not flag X.")));

      const views = (await listRepositoryRules(db, repoId)).map(ruleView);
      expect(views).toEqual([
        expect.objectContaining({
          kind: "custom",
          text: "Flag TODOs.",
          enabled: true,
          createdBy: "Ada Admin",
          sourceFinding: null,
        }),
        expect.objectContaining({
          kind: "learned",
          text: "Do not flag X.",
          createdBy: null,
          // A review from before review runs has no page to link to.
          sourceFinding: { href: null, title: "Missing null check", path: "src/config.ts" },
        }),
      ]);
      expect(views[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // A review run's pass links to the finding in the run's Findings tab.
      const reviewRun = await createReviewRun(db, {
        organizationId: orgId,
        repositoryId: repoId,
        prNumber: 42,
        headSha: SHA(2),
        baseSha: SHA(1),
        trigger: "webhook",
        mode: "full",
        depth: "standard",
      });
      await db.update(reviews).set({ reviewRunId: reviewRun.id }).where(eq(reviews.id, reviewId));
      try {
        const [, learned] = (await listRepositoryRules(db, repoId)).map(ruleView);
        expect(learned!.sourceFinding).toEqual({
          href: `/runs/${reviewRun.id}?step=${reviewId}&tab=findings#finding-${finding.id}`,
          title: "Missing null check",
          path: "src/config.ts",
        });
      } finally {
        await db.update(reviews).set({ reviewRunId: null }).where(eq(reviews.id, reviewId));
        await deleteReviewRun(db, reviewRun.id);
      }
    });
  });

  it("includes exactly the enabled rules in the next review job's resolved config", async () => {
    expect(await nextReviewRules()).toEqual([]);

    await addCustomRule(repoId, { text: "Flag TODOs without an issue link." });
    await addCustomRule(repoId, { text: "Do not flag console.log in scripts/." });
    const { job } = await dismissFalsePositive();
    await onLearnRuleJobCompleted(
      db,
      await complete(job, ruleResult("Do not flag missing null checks on config.get() results.")),
    );
    const disabled = (await db.select().from(rules)).find((r) => r.text.includes("console.log"))!;
    await setRuleEnabled(repoId, disabled.id, false);

    expect(await nextReviewRules()).toEqual([
      { kind: "custom", text: "Flag TODOs without an issue link.", enabled: true },
      {
        kind: "learned",
        text: "Do not flag missing null checks on config.get() results.",
        enabled: true,
      },
    ]);

    await setRuleEnabled(repoId, disabled.id, true);
    expect((await nextReviewRules()).map((r) => r.text)).toContain(
      "Do not flag console.log in scripts/.",
    );
  });

  it("keeps the feedback when rule generation can't be enqueued", async () => {
    const finding = await addFinding();
    const failing = {
      createAndPublish: async () => {
        throw new Error("queue down");
      },
      cancel: async () => {
        throw new Error("unused");
      },
      republish: async () => false,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await dismissFindingWithFeedback(
      db,
      { findingId: finding.id, reason: "false_positive", scmUsername: "octocat" },
      failing,
    );
    expect(result).toMatchObject({ status: "ok" });
    expect(result).not.toHaveProperty("learnRuleJobId");
    expect(await db.select().from(feedback).where(eq(feedback.findingId, finding.id))).toHaveLength(
      1,
    );
    expect(warn).toHaveBeenCalledWith("couldn't enqueue rule generation", expect.anything());
    warn.mockRestore();
  });
});
