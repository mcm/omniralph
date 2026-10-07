import { randomBytes } from "node:crypto";
import {
  connectRepository,
  closeDb,
  createDb,
  createReview,
  feedback,
  findings,
  getReviewDetail,
  runMigrations,
  upsertScmConnection,
  users,
  type Database,
  type FindingRow,
  organizations,
  seedReviewProfiles,
} from "@omniralph/db";
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
  resolveThread: vi.fn<(repo: unknown, number: number, commentId: string) => Promise<void>>(),
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
  scmAdapterFor: () => ({ resolveThread: state.resolveThread }),
}));
// False-positive dismissals enqueue a `review.learn-rule` job (see rules/actions.test.ts).
vi.mock("@vercel/queue", () => ({
  QueueClient: class {
    async send() {
      return { messageId: "msg-1" };
    }
  },
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.QUEUE_REGIONS = "iad1";

const { dismissFinding, restoreFinding } = await import("./actions");
const { dismissFindingWithFeedback } = await import("@/lib/reviews/feedback");
const { reviewDetailView } = await import("@/lib/reviews/history");
const { revalidatePath } = await import("next/cache");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const SHA = (n: number) => n.toString(16).padStart(40, "0");
const member = { id: "member-1", role: "member" as const, name: null, email: null, image: null };

describe.skipIf(!dockerAvailable)("finding dismiss and restore: server actions", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let reviewId: string;

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
      { id: "member-1", name: "Mia Member", email: "mia@example.com" },
      { id: "member-2", name: null, email: "sam@example.com" },
    ]);
    const connection = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "gitlab",
      name: "bot",
      baseUrl: "https://gitlab.example.com",
      externalId: "5",
      credentials: { token: "glpat-bot", webhookSecret: "hook" },
    }))!;
    const repo = await connectRepository(db, {
      connectionId: connection.id,
      provider: "gitlab",
      externalId: "101",
      fullPath: "acme/api",
    });
    reviewId = (
      await createReview(db, {
        repositoryId: repo.id,
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
    state.user = member;
    state.resolveThread.mockReset();
    state.resolveThread.mockResolvedValue(undefined);
    vi.mocked(revalidatePath).mockClear();
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
        path: "src/a.ts",
        startLine: 3,
        endLine: 4,
        severity: "high",
        category: "bug",
        title: "Null dereference",
        body: "`user` can be null here.",
        confidence: 0.8,
        scmCommentId: "discussion-1",
        ...over,
      })
      .returning();
    return row!;
  }

  async function findingStatus(id: string) {
    const [row] = await db.select().from(findings).where(eq(findings.id, id));
    return row!.status;
  }

  async function feedbackRows(findingId: string) {
    return db.select().from(feedback).where(eq(feedback.findingId, findingId));
  }

  it("dismisses an open finding, records ui feedback and resolves the SCM thread", async () => {
    const finding = await addFinding();
    expect(
      await dismissFinding(finding.id, { reason: "false_positive", note: "  validated upstream " }),
    ).toEqual({ ok: true });

    expect(await findingStatus(finding.id)).toBe("dismissed");
    expect(await feedbackRows(finding.id)).toEqual([
      expect.objectContaining({
        source: "ui",
        reason: "false_positive",
        note: "validated upstream",
        userId: "member-1",
        scmUsername: null,
        restoredAt: null,
      }),
    ]);
    expect(state.resolveThread).toHaveBeenCalledWith(
      { fullPath: "acme/api", externalId: "101" },
      42,
      "discussion-1",
    );
    expect(revalidatePath).toHaveBeenCalledWith(`/reviews/${reviewId}`);
  });

  it("keeps the dismissal and returns a warning when the SCM thread can't be resolved", async () => {
    state.resolveThread.mockRejectedValue(new Error("403 Forbidden"));
    const finding = await addFinding();
    const result = await dismissFinding(finding.id, { reason: "wont_fix" });
    expect(result).toEqual({ ok: true, warning: expect.stringMatching(/couldn't be resolved/) });
    expect(await findingStatus(finding.id)).toBe("dismissed");
    expect(await feedbackRows(finding.id)).toHaveLength(1);
  });

  it("doesn't call the adapter for findings without an inline thread", async () => {
    const finding = await addFinding({ scmCommentId: null });
    expect(await dismissFinding(finding.id, { reason: "not_relevant" })).toEqual({ ok: true });
    expect(state.resolveThread).not.toHaveBeenCalled();
  });

  it("rejects invalid input, unknown findings, non-open findings and signed-out callers", async () => {
    const finding = await addFinding();
    expect(await dismissFinding(finding.id, { reason: "nope" as "other" })).toMatchObject({
      ok: false,
    });
    expect(
      await dismissFinding(finding.id, { reason: "other", note: "x".repeat(1001) }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/at most/) });
    expect(await dismissFinding("not-a-uuid", { reason: "other" })).toMatchObject({ ok: false });
    expect(
      await dismissFinding("00000000-0000-4000-8000-000000000000", { reason: "other" }),
    ).toEqual({ ok: false, error: "That finding doesn't exist." });

    const resolved = await addFinding({ status: "resolved" });
    expect(await dismissFinding(resolved.id, { reason: "other" })).toEqual({
      ok: false,
      error: "Only open findings can be dismissed.",
    });

    state.user = null;
    expect(await dismissFinding(finding.id, { reason: "other" })).toMatchObject({ ok: false });
    expect(await restoreFinding(finding.id)).toMatchObject({ ok: false });
    expect(await findingStatus(finding.id)).toBe("open");
    expect(await feedbackRows(finding.id)).toHaveLength(0);
    expect(state.resolveThread).not.toHaveBeenCalled();
  });

  it("restores a dismissed finding and keeps its feedback, marked restored", async () => {
    const finding = await addFinding();
    await dismissFinding(finding.id, { reason: "false_positive" });

    state.user = { ...member, id: "member-2" };
    expect(await restoreFinding(finding.id)).toEqual({ ok: true });
    expect(await findingStatus(finding.id)).toBe("open");
    const [row] = await feedbackRows(finding.id);
    expect(row).toMatchObject({ userId: "member-1", restoredBy: "member-2" });
    expect(row!.restoredAt).toBeInstanceOf(Date);
    expect(revalidatePath).toHaveBeenCalledWith(`/reviews/${reviewId}`);

    // Restoring again is refused; dismissing again adds a second feedback row.
    expect(await restoreFinding(finding.id)).toEqual({
      ok: false,
      error: "Only dismissed findings can be restored.",
    });
    expect(await dismissFinding(finding.id, { reason: "other" })).toEqual({ ok: true });
    const rows = await feedbackRows(finding.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.restoredAt === null)).toHaveLength(1);
  });

  it("shows ui and @bot dismiss feedback in the finding's history with source and user", async () => {
    const fromUi = await addFinding({ title: "From the UI" });
    const fromThread = await addFinding({ title: "From the thread", scmCommentId: "discussion-2" });
    await dismissFinding(fromUi.id, { reason: "false_positive", note: "safe" });
    await restoreFinding(fromUi.id);
    // `@bot dismiss` goes through the same service with source `scm` and the code-host login.
    expect(
      await dismissFindingWithFeedback(db, {
        findingId: fromThread.id,
        source: "scm",
        reason: "wont_fix",
        scmUsername: "octo-dev",
      }),
    ).toMatchObject({ status: "ok" });
    expect(state.resolveThread).toHaveBeenLastCalledWith(expect.anything(), 42, "discussion-2");

    const view = reviewDetailView((await getReviewDetail(db, orgId, reviewId))!);
    const byTitle = Object.fromEntries(
      view.files.flatMap((f) => f.findings).map((f) => [f.title, f]),
    );
    expect(byTitle["From the UI"]).toMatchObject({
      status: "open",
      feedback: [
        {
          source: "ui",
          reason: "false_positive",
          note: "safe",
          actor: "Mia Member",
          restoredBy: "Mia Member",
          restoredAt: expect.any(String),
        },
      ],
    });
    expect(byTitle["From the thread"]).toMatchObject({
      status: "dismissed",
      feedback: [
        {
          source: "scm",
          reason: "wont_fix",
          note: null,
          actor: "@octo-dev",
          restoredAt: null,
          restoredBy: null,
        },
      ],
    });
  });
});
