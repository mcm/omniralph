import { randomBytes } from "node:crypto";
import {
  connectRepository,
  closeDb,
  createDb,
  createReview,
  feedback,
  findings,
  getJob,
  jobs,
  listRepositoryRules,
  restoreFinding,
  rules,
  runMigrations,
  upsertScmConnection,
  users,
  type Database,
  type FindingRow,
  type Job,
  organizations,
  seedReviewProfiles,
} from "@omniralph/db";
import {
  LEARN_RULE_TOKEN_CAP,
  LearnRuleJobPayload,
  ReviewJobPayload,
  type LearnRuleJobResult,
} from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";
import type * as Adapters from "@/lib/scm/adapters";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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
process.env.QUEUE_REGIONS = "iad1";

const { addCustomRule, deleteRule, editRule, setRuleEnabled } = await import("./actions");
const { enqueueReview } = await import("@/lib/review/enqueue");
const { getDispatcher } = await import("@/lib/dispatch");
const { dismissFindingWithFeedback } = await import("@/lib/reviews/feedback");
const { onLearnRuleJobCompleted, parseLearnRuleResult } = await import("@/lib/rules/learn");
const { ruleView } = await import("@/lib/rules/display");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const SHA = (n: number) => n.toString(16).padStart(40, "0");
const admin = { id: "admin-1", role: "admin" as const, name: null, email: null, image: null };
const member = { id: "member-1", role: "member" as const, name: null, email: null, image: null };

describe.skipIf(!dockerAvailable)("repository rules and learned rules", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let reviewId: string;
  let prNumber = 100;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
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
        profileId: "standard",
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
    await container?.stop();
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
      source: "ui",
      reason: "false_positive",
      note,
      userId: "member-1",
    });
    if (result.status !== "ok" || !result.learnRuleJobId) throw new Error("no learn-rule job");
    return { finding, job: (await getJob(db, result.learnRuleJobId))! };
  }

  /** Completes a rule generation with `result`, like `/result` does. */
  async function complete(job: Job, result: LearnRuleJobResult): Promise<Job> {
    const [row] = await db
      .update(jobs)
      .set({ status: "completed", result, finishedAt: new Date() })
      .where(eq(jobs.id, job.id))
      .returning();
    return row!;
  }

  const ruleResult = (rule: string | null): LearnRuleJobResult => ({
    rule,
    outcome: rule === null ? "none" : "rule",
    usage: { inputTokens: 1800, outputTokens: 60 },
    durationMs: 1200,
  });

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
    return ReviewJobPayload.parse(job!.payload).reviewConfig.rules;
  }

  describe("rule generation from false-positive dismissals", () => {
    it("enqueues a review.learn-rule job with the finding, the note and the 5,000-token cap", async () => {
      const { finding, job } = await dismissFalsePositive();
      expect(job).toMatchObject({
        capability: "review",
        type: "review.learn-rule",
        repositoryId: repoId,
        status: "queued",
        targetAgentId: null,
      });
      const payload = LearnRuleJobPayload.parse(job.payload);
      expect(payload).toMatchObject({
        findingId: finding.id,
        repositoryId: repoId,
        repository: { provider: "gitlab", fullPath: "acme/api" },
        baseSha: SHA(1),
        headSha: SHA(2),
        maxTokens: LEARN_RULE_TOKEN_CAP,
        note: "config.get() throws on missing keys",
        finding: {
          path: "src/config.ts",
          startLine: 3,
          endLine: 4,
          title: "Missing null check",
          body: "`config.get()` can return undefined.",
        },
      });
      expect(LEARN_RULE_TOKEN_CAP).toBe(5000);
      expect((await db.select().from(jobs)).map((j) => j.id)).toEqual([job.id]);
    });

    it("enqueues for @bot dismiss (scm) feedback too, but not for other reasons", async () => {
      const scm = await addFinding();
      const result = await dismissFindingWithFeedback(db, {
        findingId: scm.id,
        source: "scm",
        reason: "false_positive",
        scmUsername: "octocat",
      });
      expect(result).toMatchObject({ status: "ok", learnRuleJobId: expect.any(String) });

      for (const reason of ["wont_fix", "not_relevant", "other"] as const) {
        const finding = await addFinding();
        const other = await dismissFindingWithFeedback(db, {
          findingId: finding.id,
          source: "ui",
          reason,
          userId: "member-1",
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
      await restoreFinding(db, { findingId: restored.finding.id, userId: "member-1" });
      expect(
        await onLearnRuleJobCompleted(
          db,
          await complete(restored.job, ruleResult("Do not flag X.")),
        ),
      ).toEqual({ status: "feedback_withdrawn" });
      expect(await db.select().from(rules)).toEqual([]);
    });

    it("validates results: rule only with outcome 'rule', at most 300 characters", () => {
      expect(parseLearnRuleResult(ruleResult("Do not flag X."))).not.toBeNull();
      expect(parseLearnRuleResult(ruleResult(null))).not.toBeNull();
      expect(parseLearnRuleResult(ruleResult("x".repeat(301)))).toBeNull();
      expect(parseLearnRuleResult({ ...ruleResult(null), outcome: "rule" })).toBeNull();
      expect(parseLearnRuleResult({ rule: "x" })).toBeNull();
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
          sourceFinding: {
            href: `/reviews/${reviewId}#finding-${finding.id}`,
            title: "Missing null check",
            path: "src/config.ts",
          },
        }),
      ]);
      expect(views[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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
      { findingId: finding.id, source: "ui", reason: "false_positive", userId: "member-1" },
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
