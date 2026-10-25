import { randomBytes, randomUUID } from "node:crypto";
import {
  harnessRepoPins,
  harnesses,
  connectRepository,
  insertPlaybook,
  closeDb,
  createDb,
  getRepository,
  jobs,
  resolveRepositorySwitches,
  setAllowedTaskTypeDefaults,
  upsertScmConnection,
  users,
  type Database,
  organizations,
} from "@omniralph/db";
import {
  reviewTriggerContext,
  type ReviewTriggerContext,
  type RepositoryCodingInput,
  type RepositorySettingsInput,
  type RepositoryTaskTypesInput,
} from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { captureChanges } from "@omniralph/db/changes";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinPlaybook } from "@omniralph/tasks";
import type * as Tasks from "@omniralph/tasks";
import { assertRole, type Role } from "@/lib/auth/roles";
import type { LinearSettingsOptions } from "@/lib/linear/settings-values";

vi.mock("server-only", () => ({}));
// A second built-in review playbook, beside `builtin:review-pr`.
vi.mock("@omniralph/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof Tasks>();
  const securityPlaybook = {
    ...actual.getBuiltinPlaybook("builtin:review-pr")!,
    id: "builtin:security-review",
    name: "Security review",
  };
  return {
    ...actual,
    getBuiltinPlaybook: (id: string) =>
      id === securityPlaybook.id ? securityPlaybook : actual.getBuiltinPlaybook(id),
  };
});
const SECURITY_TASK_ID = "builtin:security-review";
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const state = vi.hoisted(() => ({
  /** The connected Linear workspace's options (null: none connected), or a load failure. */
  linear: null as LinearSettingsOptions | null | Error,
  linearLoads: 0,
  orgId: "",
  db: undefined as unknown as Database,
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/linear/settings-options", () => ({
  getLinearSettingsOptions: async () => {
    state.linearLoads++;
    if (state.linear instanceof Error) throw state.linear;
    return state.linear;
  },
}));
vi.mock("@/lib/auth/session", () => ({
  // The signed-in user works in `state.orgId`.
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const repositorySettings = await import("@/app/api/ui/repositories/[id]/settings/route");
const repositoryTaskTypes = await import("@/app/api/ui/repositories/[id]/task-types/route");
const repositoryCoding = await import("@/app/api/ui/repositories/[id]/coding/route");
const { enqueueReview } = await import("@/lib/review/enqueue");
const { getDispatcher } = await import("@/lib/dispatch");

const databaseAvailable = testDatabaseAvailable();

type Result = { ok: true; warning?: string } | { ok: false; error: string; fieldErrors?: object };

/** Saves through an `/api/ui` handler as the settings tabs do; answers its `ActionResult`. */
async function save(
  handler: (request: Request, route: { params: Promise<{ id: string }> }) => Promise<Response>,
  id: string,
  body: unknown,
): Promise<Result> {
  const response = await handler(
    new Request("http://localhost/api/ui", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  const json = (await response.json()) as Record<string, unknown>;
  if (response.ok) return json as Result;
  return {
    ok: false,
    error: json.error as string,
    ...(json.fieldErrors ? { fieldErrors: json.fieldErrors as object } : {}),
  };
}

// The settings tabs' requests, under the names of the server actions they replace.
const updateRepositorySettings = (id: string, input: RepositorySettingsInput) =>
  save(repositorySettings.PUT, id, input);
const updateRepositoryTaskTypes = (id: string, input: RepositoryTaskTypesInput) =>
  save(repositoryTaskTypes.PUT, id, input);
const updateCoding = (id: string, input: unknown) => save(repositoryCoding.PUT, id, input);

const SHA = (n: number) => n.toString(16).padStart(40, "0");

const baseSettings: RepositorySettingsInput = {
  depth: "standard",
  triggers: { onOpen: true, onPush: true, drafts: false },
  pathExcludes: [],
  customInstructions: "",
  pinnedHarnessIds: [],
  reviewPlaybookIds: ["builtin:review-pr"],
  correlationPlaybookId: "builtin:correlate-findings",
};

const baseCoding: RepositoryCodingInput = {
  codingEnabled: true,
  codingInstructions: null,
  openPullRequestEarly: false,
  historyRewrite: "when-asked",
  respondToReviewsAndCi: true,
};

describe.skipIf(!databaseAvailable)("repository settings: saves", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let agentA: string;
  let agentB: string;
  let revokedAgent: string;
  let prNumber = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    state.orgId = orgId;
    state.db = db;
    await db.insert(users).values([
      { id: "admin-1", email: "admin@example.com" },
      { id: "member-1", email: "member@example.com" },
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
    [agentA, agentB, revokedAgent] = (
      await db
        .insert(harnesses)
        .values([
          { organizationId: orgId, name: "coder-a" },
          { organizationId: orgId, name: "coder-b" },
          { organizationId: orgId, name: "coder-old", revokedAt: new Date() },
        ])
        .returning({ id: harnesses.id })
    ).map((a) => a.id) as [string, string, string];
  }, 180_000);

  beforeEach(async () => {
    state.user = { id: "admin-1", role: "admin", name: null, email: null, image: null };
    await db.delete(harnessRepoPins);
    await db.delete(jobs);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  async function pinnedHarnessIds(): Promise<string[]> {
    const rows = await db
      .select({ harnessId: harnessRepoPins.harnessId })
      .from(harnessRepoPins)
      .where(eq(harnessRepoPins.repositoryId, repoId));
    return rows.map((r) => r.harnessId).sort();
  }

  async function syncJobs() {
    return db.select().from(jobs).where(eq(jobs.type, "repo.sync")).orderBy(asc(jobs.createdAt));
  }

  async function enqueuedPayload(): Promise<ReviewTriggerContext> {
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
    const [job] = await db.select().from(jobs).where(eq(jobs.id, result.jobId));
    return reviewTriggerContext(job!.payload);
  }

  it("saves the depth, triggers, excludes and instructions", async () => {
    const { result, changes } = await captureChanges(() =>
      updateRepositorySettings(repoId, {
        depth: "quick",
        triggers: { onOpen: true, onPush: false, drafts: true },
        pathExcludes: ["*.snap", "/docs/**"],
        customInstructions: "  Prefer early returns.  ",
        pinnedHarnessIds: [],
        reviewPlaybookIds: ["builtin:review-pr"],
        correlationPlaybookId: "builtin:correlate-findings",
      }),
    );
    expect(result).toEqual({ ok: true });
    // The repo's review settings change event goes out for the save.
    expect(changes).toEqual([
      expect.objectContaining({
        resource: "settings",
        section: "repository.reviews",
        ids: [repoId],
        subjectId: repoId,
        organizationId: orgId,
      }),
    ]);
    expect(await getRepository(db, repoId)).toMatchObject({
      reviewDepth: "quick",
      triggers: { onOpen: true, onPush: false, drafts: true },
      pathExcludes: ["*.snap", "/docs/**"],
      customInstructions: "Prefer early returns.",
    });

    expect(await updateRepositorySettings(repoId, baseSettings)).toEqual({ ok: true });
    expect(await getRepository(db, repoId)).toMatchObject({
      reviewDepth: "standard",
      pathExcludes: [],
      customInstructions: null,
    });
  });

  it("pinning an agent enqueues a repo.sync job for that agent; unpinning removes the pin", async () => {
    expect(
      await updateRepositorySettings(repoId, { ...baseSettings, pinnedHarnessIds: [agentA] }),
    ).toEqual({ ok: true });
    expect(await pinnedHarnessIds()).toEqual([agentA]);
    const [job, ...rest] = await syncJobs();
    expect(rest).toHaveLength(0);
    expect(job).toMatchObject({
      type: "repo.sync",
      taskType: "system",
      status: "queued",
      repositoryId: repoId,
      targetHarnessId: agentA,
    });
    expect(job!.payload).toMatchObject({ repository: { fullPath: "acme/api" } });

    // Swapping A for B syncs only to B, and keeping B pinned doesn't sync again.
    expect(
      await updateRepositorySettings(repoId, { ...baseSettings, pinnedHarnessIds: [agentB] }),
    ).toEqual({ ok: true });
    expect(await pinnedHarnessIds()).toEqual([agentB]);
    expect((await syncJobs()).map((j) => j.targetHarnessId)).toEqual([agentA, agentB]);
    expect(
      await updateRepositorySettings(repoId, { ...baseSettings, pinnedHarnessIds: [agentB] }),
    ).toEqual({ ok: true });
    expect(await syncJobs()).toHaveLength(2);

    // Empty means any agent.
    expect(await updateRepositorySettings(repoId, baseSettings)).toEqual({ ok: true });
    expect(await pinnedHarnessIds()).toEqual([]);
  });

  it("rejects revoked, unknown and other organizations' agents without saving anything", async () => {
    const [otherOrg] = await db.insert(organizations).values({ name: "Other" }).returning();
    const [foreignAgent] = await db
      .insert(harnesses)
      .values({ organizationId: otherOrg!.id, name: "coder-foreign" })
      .returning({ id: harnesses.id });
    for (const harnessId of [revokedAgent, randomUUID(), foreignAgent!.id]) {
      expect(
        await updateRepositorySettings(repoId, {
          ...baseSettings,
          depth: "deep",
          pinnedHarnessIds: [agentA, harnessId],
        }),
      ).toMatchObject({ ok: false, fieldErrors: { pinnedHarnessIds: expect.any(String) } });
    }
    expect(await pinnedHarnessIds()).toEqual([]);
    expect(await db.select().from(jobs)).toHaveLength(0);
    expect((await getRepository(db, repoId))!.reviewDepth).toBe("standard");
  });

  it("saves the review tasks, and the next review run fans out to them", async () => {
    expect((await getRepository(db, repoId))!.reviewPlaybookIds).toEqual(["builtin:review-pr"]);
    expect(
      await updateRepositorySettings(repoId, {
        ...baseSettings,
        reviewPlaybookIds: [SECURITY_TASK_ID, "builtin:review-pr"],
      }),
    ).toEqual({ ok: true });
    expect(await getRepository(db, repoId)).toMatchObject({
      reviewPlaybookIds: [SECURITY_TASK_ID, "builtin:review-pr"],
      correlationPlaybookId: "builtin:correlate-findings",
    });

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
    expect(result.runs.map((run) => run.taskId)).toEqual([SECURITY_TASK_ID, "builtin:review-pr"]);

    // Removing a reviewer takes effect for the next run.
    expect(
      await updateRepositorySettings(repoId, {
        ...baseSettings,
        reviewPlaybookIds: [SECURITY_TASK_ID],
      }),
    ).toEqual({ ok: true });
    expect((await getRepository(db, repoId))!.reviewPlaybookIds).toEqual([SECURITY_TASK_ID]);
    expect(await updateRepositorySettings(repoId, baseSettings)).toEqual({ ok: true });
  });

  it("rejects no, duplicate, unknown and non-review playbooks without saving anything", async () => {
    const notReview = "Choose review or review-summary playbooks of this organization.";
    const invalid: [string[], string][] = [
      [[], "Choose at least one review playbook."],
      [["builtin:review-pr", "builtin:review-pr"], "Choose each review playbook once."],
      [["builtin:review-pr", "builtin:nope"], notReview],
      [["builtin:reply-to-finding"], notReview],
      [["builtin:correlate-findings"], notReview],
    ];
    for (const [reviewPlaybookIds, message] of invalid) {
      expect(
        await updateRepositorySettings(repoId, {
          ...baseSettings,
          depth: "deep",
          reviewPlaybookIds,
        }),
      ).toMatchObject({ ok: false, fieldErrors: { reviewPlaybookIds: message } });
    }
    expect(await getRepository(db, repoId)).toMatchObject({
      reviewDepth: "standard",
      reviewPlaybookIds: ["builtin:review-pr"],
    });
  });

  /** A playbook of `organizationId` stored as a copy of built-in `builtinId` (with `changes`). */
  async function storedPlaybook(builtinId: string, changes: object = {}, organizationId = orgId) {
    const { id: _id, name, role, ...definition } = getBuiltinPlaybook(builtinId)!;
    const row = await insertPlaybook(db, organizationId, {
      name: `Custom ${name}`,
      role,
      definition: { ...definition, ...changes },
      requirements: {},
      createdBy: null,
    });
    return row.id;
  }

  async function otherOrganization(): Promise<string> {
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    return other!.id;
  }

  it("saves a custom review playbook and correlation playbook, and the next review run fans out to the custom one", async () => {
    const review = await storedPlaybook("builtin:review-pr", {
      promptTemplate: "Review {{repository}} for security problems.",
    });
    const correlation = await storedPlaybook("builtin:correlate-findings");
    expect(
      await updateRepositorySettings(repoId, {
        ...baseSettings,
        reviewPlaybookIds: ["builtin:review-pr", review],
        correlationPlaybookId: correlation,
      }),
    ).toEqual({ ok: true });
    expect(await getRepository(db, repoId)).toMatchObject({
      reviewPlaybookIds: ["builtin:review-pr", review],
      correlationPlaybookId: correlation,
    });

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
    expect(result.runs.map((run) => run.taskId)).toEqual(["builtin:review-pr", review]);
    const [job] = await db.select().from(jobs).where(eq(jobs.id, result.runs[1]!.jobId));
    expect(job!.taskId).toBe(review);

    expect(await updateRepositorySettings(repoId, baseSettings)).toEqual({ ok: true });
  });

  it("binds review playbooks only when given, publishing the repo's review change", async () => {
    const review = await storedPlaybook("builtin:summarize-pr");
    const { result, changes } = await captureChanges(() =>
      updateRepositorySettings(repoId, { ...baseSettings, reviewPlaybookIds: [review] }),
    );
    expect(result).toEqual({ ok: true });
    expect(changes).toEqual([
      expect.objectContaining({
        resource: "settings",
        section: "repository.reviews",
        ids: [repoId],
        subjectId: repoId,
        organizationId: orgId,
      }),
    ]);
    // A save without the bindings (the old Review settings page) leaves them as they are.
    const { reviewPlaybookIds: _ids, correlationPlaybookId: _id, ...unbound } = baseSettings;
    expect(await updateRepositorySettings(repoId, { ...unbound, depth: "deep" })).toEqual({
      ok: true,
    });
    expect(await getRepository(db, repoId)).toMatchObject({
      reviewDepth: "deep",
      reviewPlaybookIds: [review],
      correlationPlaybookId: "builtin:correlate-findings",
    });
    // The coding policy never carries them.
    expect(await updateCoding(repoId, baseCoding)).toMatchObject({ codingEnabled: true });
    expect(await getRepository(db, repoId)).toMatchObject({
      storyPlaybookId: "builtin:implement-story",
      requestPlaybookId: "builtin:handle-request",
    });
    expect(await updateRepositorySettings(repoId, baseSettings)).toEqual({ ok: true });
  });

  it("rejects review and correlation playbooks of another organization or of another role without saving", async () => {
    const other = await otherOrganization();
    const othersReview = await storedPlaybook("builtin:review-pr", {}, other);
    const othersCorrelation = await storedPlaybook("builtin:correlate-findings", {}, other);
    const chatAsk = await storedPlaybook("builtin:ask-about-code");
    const correlation = await storedPlaybook("builtin:correlate-findings");
    // A stored playbook that no longer parses (a field its role sets).
    const unresolvable = await storedPlaybook("builtin:review-pr", { sink: "review" });

    for (const reviewPlaybookIds of [
      [othersReview],
      [chatAsk],
      ["builtin:review-pr", correlation],
      [unresolvable],
    ]) {
      expect(
        await updateRepositorySettings(repoId, {
          ...baseSettings,
          depth: "deep",
          reviewPlaybookIds,
        }),
      ).toMatchObject({
        ok: false,
        fieldErrors: {
          reviewPlaybookIds: "Choose review or review-summary playbooks of this organization.",
        },
      });
    }
    for (const correlationPlaybookId of [
      othersCorrelation,
      chatAsk,
      "builtin:describe-pr",
      "builtin:review-pr",
      "builtin:nope",
      randomUUID(),
    ]) {
      expect(
        await updateRepositorySettings(repoId, {
          ...baseSettings,
          depth: "deep",
          correlationPlaybookId,
        }),
      ).toMatchObject({ ok: false, fieldErrors: { correlationPlaybookId: expect.any(String) } });
    }
    expect(await getRepository(db, repoId)).toMatchObject({
      reviewDepth: "standard",
      reviewPlaybookIds: ["builtin:review-pr"],
      correlationPlaybookId: "builtin:correlate-findings",
    });
  });

  it("rejects bad globs and too-long instructions with inline field errors", async () => {
    expect(
      await updateRepositorySettings(repoId, {
        ...baseSettings,
        pathExcludes: ["*.snap", "src/[abc.ts", "!keep.ts"],
        customInstructions: "x".repeat(4001),
      }),
    ).toEqual({
      ok: false,
      error: "Fix the highlighted fields.",
      fieldErrors: {
        "pathExcludes.1": 'Missing a closing "]".',
        "pathExcludes.2": "Negated patterns (starting with !) aren't supported.",
        customInstructions: "Custom instructions can be at most 4,000 characters.",
      },
    });
    expect(await getRepository(db, repoId)).toMatchObject({ pathExcludes: [] });
  });

  it("rejects unknown repositories and non-admins", async () => {
    expect(await updateRepositorySettings(randomUUID(), baseSettings)).toMatchObject({
      ok: false,
      error: "That repository isn't connected.",
    });
    state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
    expect(
      await updateRepositorySettings(repoId, {
        ...baseSettings,
        depth: "deep",
        reviewPlaybookIds: [SECURITY_TASK_ID, "builtin:review-pr"],
      }),
    ).toMatchObject({ ok: false });
    expect(await getRepository(db, repoId)).toMatchObject({
      reviewDepth: "standard",
      reviewPlaybookIds: ["builtin:review-pr"],
    });
  });

  it("answers 400 for an unknown depth, or none, without saving anything", async () => {
    for (const depth of ["thorough", "Deep", null, undefined]) {
      const { result: response, changes } = await captureChanges(() =>
        repositorySettings.PUT(
          new Request("http://localhost/api/ui", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...baseSettings, depth, customInstructions: "Changed." }),
          }),
          { params: Promise.resolve({ id: repoId }) },
        ),
      );
      expect(response.status).toBe(400);
      expect(changes).toEqual([]);
      expect(await response.json()).toMatchObject({
        fieldErrors: { depth: "Choose a review depth: quick, standard or deep." },
      });
    }
    expect(await getRepository(db, repoId)).toMatchObject({
      reviewDepth: "standard",
      customInstructions: null,
    });
  });

  it("applies changes to the next enqueued review job", async () => {
    const before = await enqueuedPayload();
    expect(before.reviewConfig).toMatchObject({
      profile: { id: "standard" },
      pathExcludes: [],
      customInstructions: null,
    });

    expect(
      await updateRepositorySettings(repoId, {
        ...baseSettings,
        depth: "deep",
        pathExcludes: ["*.snap"],
        customInstructions: "Check error handling.",
      }),
    ).toEqual({ ok: true });

    const after = await enqueuedPayload();
    expect(after.reviewConfig).toMatchObject({
      // The Deep preset.
      profile: {
        id: "deep",
        name: "Deep",
        model: "claude-opus-5-5",
        maxTokensPerReview: 500_000,
        maxFiles: 100,
        allowRepoExploration: true,
      },
      pathExcludes: ["*.snap"],
      customInstructions: "Check error handling.",
    });
    // The earlier job keeps the config it was created with.
    expect(before.reviewConfig.profile.id).toBe("standard");
    await updateRepositorySettings(repoId, baseSettings);
  });

  describe("coding policy", () => {
    const getCoding = async (id = repoId) => {
      const response = await repositoryCoding.GET(new Request("http://localhost/api/ui"), {
        params: Promise.resolve({ id }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    it("answers exactly the six-field policy and the story playbook's round limits", async () => {
      expect(await getCoding()).toEqual({
        status: 200,
        body: {
          codingEnabled: true,
          codingInstructions: null,
          openPullRequestEarly: false,
          historyRewrite: "when-asked",
          respondToReviewsAndCi: true,
          roundLimits: { maxReviewRounds: 3, maxFixRounds: 3 },
        },
      });
    });

    it("saves the policy, answers it and publishes the repo's coding change", async () => {
      const policy: RepositoryCodingInput = {
        codingEnabled: false,
        codingInstructions: "  NEVER use `git merge` in this repo, ALWAYS rebase.  ",
        openPullRequestEarly: true,
        historyRewrite: "always",
        respondToReviewsAndCi: false,
      };
      const { result, changes } = await captureChanges(() => updateCoding(repoId, policy));
      const saved = {
        ...policy,
        codingInstructions: "NEVER use `git merge` in this repo, ALWAYS rebase.",
        roundLimits: { maxReviewRounds: 3, maxFixRounds: 3 },
      };
      expect(result).toEqual(saved);
      expect(changes).toEqual([
        expect.objectContaining({
          resource: "settings",
          section: "repository.coding",
          ids: [repoId],
          subjectId: repoId,
          organizationId: orgId,
        }),
      ]);
      expect(await getRepository(db, repoId)).toMatchObject({
        ralphEnabled: false,
        codingInstructions: "NEVER use `git merge` in this repo, ALWAYS rebase.",
        openPullRequestEarly: true,
        historyRewrite: "always",
        respondToReviewsAndCi: false,
      });
      expect((await getCoding()).body).toEqual(saved);
      // Saving the review settings leaves the coding policy alone.
      expect(await updateRepositorySettings(repoId, baseSettings)).toEqual({ ok: true });
      expect((await getCoding()).body).toEqual(saved);

      // Empty instructions are none.
      expect(await updateCoding(repoId, { ...baseCoding, codingInstructions: "" })).toEqual({
        ...baseCoding,
        roundLimits: { maxReviewRounds: 3, maxFixRounds: 3 },
      });
      expect(await getRepository(db, repoId)).toMatchObject({
        ralphEnabled: true,
        codingInstructions: null,
      });
    });

    it("rejects unknown keys and invalid values with 400, saving and publishing nothing", async () => {
      const before = await getRepository(db, repoId);
      for (const key of [
        "model",
        "verifyCommands",
        "setupCommand",
        "maxReviewRounds",
        "manualLabels",
        "storyPlaybookId",
        "roundLimits",
      ]) {
        const { result, changes } = await captureChanges(() =>
          updateCoding(repoId, { ...baseCoding, codingEnabled: false, [key]: "x" }),
        );
        expect(result, key).toMatchObject({ ok: false, error: expect.stringContaining(key) });
        expect(changes).toEqual([]);
      }
      expect(
        await updateCoding(repoId, {
          ...baseCoding,
          codingEnabled: "yes",
          historyRewrite: "sometimes",
          codingInstructions: "x".repeat(10_001),
        }),
      ).toMatchObject({
        ok: false,
        fieldErrors: {
          codingEnabled: "Choose on or off.",
          historyRewrite: "Choose a policy.",
          codingInstructions: "Extra instructions can be at most 10,000 characters.",
        },
      });
      const { codingEnabled: _missing, ...partial } = baseCoding;
      expect(await updateCoding(repoId, partial)).toMatchObject({
        ok: false,
        fieldErrors: { codingEnabled: "Choose on or off." },
      });
      expect(await getRepository(db, repoId)).toEqual(before);
    });

    it("reports the round limits of the repo's story playbook", async () => {
      const story = await storedPlaybook("builtin:implement-story", {
        coding: { maxReviewRounds: 5, maxFixRounds: 1 },
      });
      try {
        expect(
          await updateRepositorySettings(repoId, { ...baseSettings, storyPlaybookId: story }),
        ).toEqual({ ok: true });
        expect((await getCoding()).body.roundLimits).toEqual({
          maxReviewRounds: 5,
          maxFixRounds: 1,
        });
      } finally {
        await updateRepositorySettings(repoId, {
          ...baseSettings,
          storyPlaybookId: "builtin:implement-story",
        });
      }
    });

    it("rejects coding saves for unknown repositories and from non-admins", async () => {
      const before = await getRepository(db, repoId);
      expect(await updateCoding(randomUUID(), baseCoding)).toEqual({
        ok: false,
        error: "That repository isn't connected.",
      });
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(await updateCoding(repoId, { ...baseCoding, codingEnabled: false })).toMatchObject({
        ok: false,
      });
      expect((await getCoding()).status).toBe(403);
      expect(await getRepository(db, repoId)).toEqual(before);
    });
  });

  it("defaults to the built-in story and request playbooks", async () => {
    expect(await getRepository(db, repoId)).toMatchObject({
      storyPlaybookId: "builtin:implement-story",
      requestPlaybookId: "builtin:handle-request",
    });
  });

  it("saves custom story and request playbooks with the review settings, publishing the repo's coding change", async () => {
    const story = await storedPlaybook("builtin:implement-story");
    const request = await storedPlaybook("builtin:handle-request");
    const { result, changes } = await captureChanges(() =>
      updateRepositorySettings(repoId, {
        ...baseSettings,
        storyPlaybookId: story,
        requestPlaybookId: request,
      }),
    );
    expect(result).toEqual({ ok: true });
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: "settings",
          section: "repository.coding",
          ids: [repoId],
          subjectId: repoId,
          organizationId: orgId,
        }),
      ]),
    );
    expect(await getRepository(db, repoId)).toMatchObject({
      storyPlaybookId: story,
      requestPlaybookId: request,
    });
    expect(
      await updateRepositorySettings(repoId, {
        ...baseSettings,
        storyPlaybookId: "builtin:implement-story",
        requestPlaybookId: "builtin:handle-request",
      }),
    ).toEqual({ ok: true });
    expect(await getRepository(db, repoId)).toMatchObject({
      storyPlaybookId: "builtin:implement-story",
      requestPlaybookId: "builtin:handle-request",
    });
  });

  it("rejects story and request playbooks of another organization or of another role without saving", async () => {
    const other = await otherOrganization();
    const othersStory = await storedPlaybook("builtin:implement-story", {}, other);
    const othersRequest = await storedPlaybook("builtin:handle-request", {}, other);
    // A stored playbook that no longer parses (a field its role sets).
    const unresolvable = await storedPlaybook("builtin:handle-request", {
      triggers: ["chat.request"],
    });

    for (const storyPlaybookId of [
      othersStory,
      "builtin:handle-request",
      "builtin:review-pr",
      "builtin:nope",
      randomUUID(),
    ]) {
      expect(
        await updateRepositorySettings(repoId, { ...baseSettings, storyPlaybookId }),
      ).toMatchObject({
        ok: false,
        fieldErrors: { storyPlaybookId: expect.any(String) },
      });
    }
    for (const requestPlaybookId of [
      othersRequest,
      unresolvable,
      "builtin:implement-story",
      "builtin:nope",
    ]) {
      expect(
        await updateRepositorySettings(repoId, { ...baseSettings, requestPlaybookId }),
      ).toMatchObject({
        ok: false,
        fieldErrors: { requestPlaybookId: expect.any(String) },
      });
    }
    expect(await getRepository(db, repoId)).toMatchObject({
      storyPlaybookId: "builtin:implement-story",
      requestPlaybookId: "builtin:handle-request",
    });
  });

  describe("task types", () => {
    const INHERIT = { query: null, review: null, coding: null };
    const COLUMNS = { query: "queryEnabled", review: "enabled", coding: "ralphEnabled" } as const;

    it("saves each of Query, Reviews and Coding as inherit, on or off", async () => {
      try {
        for (const key of ["query", "review", "coding"] as const) {
          for (const value of [true, false, null]) {
            expect(await updateRepositoryTaskTypes(repoId, { ...INHERIT, [key]: value })).toEqual({
              ok: true,
            });
            const repo = (await getRepository(db, repoId))!;
            expect(repo[COLUMNS[key]]).toBe(value);
            // The others stay inherited.
            for (const other of ["query", "review", "coding"] as const) {
              if (other !== key) expect(repo[COLUMNS[other]]).toBeNull();
            }

            // Inherit follows the organization's default; on and off win over it either way.
            await setAllowedTaskTypeDefaults(db, orgId, [], null);
            expect((await resolveRepositorySwitches(db, repo))[key]).toBe(value ?? false);
            await setAllowedTaskTypeDefaults(db, orgId, ["query", "review", "coding"], null);
            expect((await resolveRepositorySwitches(db, repo))[key]).toBe(value ?? true);
            await setAllowedTaskTypeDefaults(db, orgId, null, null);
          }
        }
      } finally {
        await setAllowedTaskTypeDefaults(db, orgId, null, null);
        await updateRepositoryTaskTypes(repoId, INHERIT);
      }
    });

    it("saves all three at once", async () => {
      try {
        expect(
          await updateRepositoryTaskTypes(repoId, { query: false, review: true, coding: null }),
        ).toEqual({ ok: true });
        expect(await getRepository(db, repoId)).toMatchObject({
          queryEnabled: false,
          enabled: true,
          ralphEnabled: null,
        });
      } finally {
        await updateRepositoryTaskTypes(repoId, INHERIT);
      }
    });

    it("rejects invalid input, unknown repositories and non-admins without saving", async () => {
      expect(
        await updateRepositoryTaskTypes(repoId, {
          ...INHERIT,
          review: "on",
        } as unknown as typeof INHERIT),
      ).toMatchObject({ ok: false, fieldErrors: { review: expect.any(String) } });
      expect(await updateRepositoryTaskTypes(randomUUID(), INHERIT)).toEqual({
        ok: false,
        error: "That repository isn't connected.",
      });
      state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
      expect(
        await updateRepositoryTaskTypes(repoId, { query: false, review: false, coding: false }),
      ).toMatchObject({ ok: false });
      expect(await getRepository(db, repoId)).toMatchObject({
        queryEnabled: null,
        enabled: null,
        ralphEnabled: null,
      });
    });
  });
});
