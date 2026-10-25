import { randomBytes, randomUUID } from "node:crypto";
import {
  harnessRepoPins,
  harnesses,
  connectRepository,
  insertTaskDefinition,
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
  DEFAULT_RALPH_SETTINGS,
  ralphSettingsFormValues,
  reviewTriggerContext,
  type ReviewTriggerContext,
  type RalphSettingsInput,
  type RepositorySettingsInput,
  type RepositoryTaskTypesInput,
} from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinTask } from "@omniralph/tasks";
import type * as Tasks from "@omniralph/tasks";
import { assertRole, type Role } from "@/lib/auth/roles";
import type { LinearSettingsOptions } from "@/lib/linear/settings-values";

vi.mock("server-only", () => ({}));
// A second built-in review task, beside `builtin:review-pr`.
vi.mock("@omniralph/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof Tasks>();
  const security = {
    ...actual.getBuiltinTask("builtin:review-pr")!,
    id: "builtin:security-review",
    name: "Security review",
  };
  // A review task that only runs when asked, never on a push.
  const onRequest = {
    ...actual.getBuiltinTask("builtin:review-pr")!,
    id: "builtin:on-request-review",
    name: "On-request review",
    triggers: ["pr.mention", "review.rerun"],
  };
  const injected = new Map([security, onRequest].map((task) => [task.id, task]));
  return {
    ...actual,
    getBuiltinTask: (id: string) => injected.get(id) ?? actual.getBuiltinTask(id),
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
const updateRalphSettings = (id: string, input: RalphSettingsInput) =>
  save(repositoryCoding.PUT, id, input);

const SHA = (n: number) => n.toString(16).padStart(40, "0");

const baseSettings: RepositorySettingsInput = {
  depth: "standard",
  triggers: { onOpen: true, onPush: true, drafts: false },
  pathExcludes: [],
  customInstructions: "",
  pinnedHarnessIds: [],
  reviewTaskIds: ["builtin:review-pr"],
  correlationTaskId: "builtin:correlate-findings",
};

const baseRalph: RalphSettingsInput = {
  storyTaskId: "builtin:implement-story",
  requestTaskId: "builtin:handle-request",
  ...ralphSettingsFormValues(DEFAULT_RALPH_SETTINGS),
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
    expect(
      await updateRepositorySettings(repoId, {
        depth: "quick",
        triggers: { onOpen: true, onPush: false, drafts: true },
        pathExcludes: ["*.snap", "/docs/**"],
        customInstructions: "  Prefer early returns.  ",
        pinnedHarnessIds: [],
        reviewTaskIds: ["builtin:review-pr"],
        correlationTaskId: "builtin:correlate-findings",
      }),
    ).toEqual({ ok: true });
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
    expect((await getRepository(db, repoId))!.reviewTaskIds).toEqual(["builtin:review-pr"]);
    expect(
      await updateRepositorySettings(repoId, {
        ...baseSettings,
        reviewTaskIds: [SECURITY_TASK_ID, "builtin:review-pr"],
      }),
    ).toEqual({ ok: true });
    expect(await getRepository(db, repoId)).toMatchObject({
      reviewTaskIds: [SECURITY_TASK_ID, "builtin:review-pr"],
      correlationTaskId: "builtin:correlate-findings",
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
        reviewTaskIds: [SECURITY_TASK_ID],
      }),
    ).toEqual({ ok: true });
    expect((await getRepository(db, repoId))!.reviewTaskIds).toEqual([SECURITY_TASK_ID]);
    expect(await updateRepositorySettings(repoId, baseSettings)).toEqual({ ok: true });
  });

  it("rejects no, duplicate, unknown, non-review and push-less tasks without saving anything", async () => {
    const invalid: [string[], string][] = [
      [[], "Choose at least one review task."],
      [["builtin:review-pr", "builtin:review-pr"], "Choose each review task once."],
      [["builtin:review-pr", "builtin:nope"], "Some selected review tasks don't exist."],
      [["builtin:reply-to-finding"], "Some selected review tasks don't exist."],
      [["builtin:on-request-review"], "Some selected review tasks don't exist."],
    ];
    for (const [reviewTaskIds, message] of invalid) {
      expect(
        await updateRepositorySettings(repoId, {
          ...baseSettings,
          depth: "deep",
          reviewTaskIds,
        }),
      ).toMatchObject({ ok: false, fieldErrors: { reviewTaskIds: message } });
    }
    expect(await getRepository(db, repoId)).toMatchObject({
      reviewDepth: "standard",
      reviewTaskIds: ["builtin:review-pr"],
    });
  });

  /** A task of `organizationId` stored as a copy of built-in `builtinId` (with `changes`). */
  async function storedTask(builtinId: string, changes: object = {}, organizationId = orgId) {
    const { name, ...definition } = getBuiltinTask(builtinId)!;
    const row = await insertTaskDefinition(db, organizationId, {
      name: `Custom ${name}`,
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

  it("saves a custom review task and correlation task, and the next review run fans out to the custom task", async () => {
    const review = await storedTask("builtin:review-pr", {
      promptTemplate: "Review {{repository}} for security problems.",
    });
    const correlation = await storedTask("builtin:correlate-findings");
    expect(
      await updateRepositorySettings(repoId, {
        ...baseSettings,
        reviewTaskIds: ["builtin:review-pr", review],
        correlationTaskId: correlation,
      }),
    ).toEqual({ ok: true });
    expect(await getRepository(db, repoId)).toMatchObject({
      reviewTaskIds: ["builtin:review-pr", review],
      correlationTaskId: correlation,
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

  it("rejects review and correlation tasks of another organization or of the wrong type without saving", async () => {
    const other = await otherOrganization();
    const othersReview = await storedTask("builtin:review-pr", {}, other);
    const othersCorrelation = await storedTask("builtin:correlate-findings", {}, other);
    const queryReview = await storedTask("builtin:ask-about-code");
    // A query task taking run.invoked whose output isn't the correlation's.
    const wrongOutput = await storedTask("builtin:correlate-findings", {
      outputSchema: { type: "object", properties: { summary: { type: "string" } } },
    });

    for (const reviewTaskIds of [
      [othersReview],
      [queryReview],
      ["builtin:review-pr", wrongOutput],
    ]) {
      expect(
        await updateRepositorySettings(repoId, {
          ...baseSettings,
          depth: "deep",
          reviewTaskIds,
        }),
      ).toMatchObject({
        ok: false,
        fieldErrors: { reviewTaskIds: "Some selected review tasks don't exist." },
      });
    }
    for (const correlationTaskId of [
      othersCorrelation,
      wrongOutput,
      "builtin:describe-pr",
      "builtin:review-pr",
      "builtin:nope",
      randomUUID(),
    ]) {
      expect(
        await updateRepositorySettings(repoId, {
          ...baseSettings,
          depth: "deep",
          correlationTaskId,
        }),
      ).toMatchObject({ ok: false, fieldErrors: { correlationTaskId: expect.any(String) } });
    }
    expect(await getRepository(db, repoId)).toMatchObject({
      reviewDepth: "standard",
      reviewTaskIds: ["builtin:review-pr"],
      correlationTaskId: "builtin:correlate-findings",
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
        reviewTaskIds: [SECURITY_TASK_ID, "builtin:review-pr"],
      }),
    ).toMatchObject({ ok: false });
    expect(await getRepository(db, repoId)).toMatchObject({
      reviewDepth: "standard",
      reviewTaskIds: ["builtin:review-pr"],
    });
  });

  it("answers 400 for an unknown depth, or none, without saving anything", async () => {
    for (const depth of ["thorough", "Deep", null, undefined]) {
      const response = await repositorySettings.PUT(
        new Request("http://localhost/api/ui", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...baseSettings, depth, customInstructions: "Changed." }),
        }),
        { params: Promise.resolve({ id: repoId }) },
      );
      expect(response.status).toBe(400);
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

  it("saves the Ralph section: openPullRequestEarly, setup command, model and manual labels", async () => {
    expect(await getRepository(db, repoId)).toMatchObject({
      ralphEnabled: null,
      ralphSettings: {
        openPullRequestEarly: false,
        setupCommand: null,
        model: "opus",
        manualLabels: ["manual"],
      },
    });
    expect(
      await updateRalphSettings(repoId, {
        ...baseRalph,
        openPullRequestEarly: true,
        setupCommand: "  pnpm install --frozen-lockfile  ",
        model: "claude-opus-5-5",
        manualLabels: ["by hand", "manual"],
      }),
    ).toEqual({ ok: true });
    expect(await getRepository(db, repoId)).toMatchObject({
      // Coding is switched under Task types, not by the Ralph section.
      ralphEnabled: null,
      ralphSettings: {
        openPullRequestEarly: true,
        setupCommand: "pnpm install --frozen-lockfile",
        model: "claude-opus-5-5",
        manualLabels: ["by hand", "manual"],
      },
    });
    // Saving the review settings leaves the Ralph section alone, and the other way round.
    expect(await updateRepositorySettings(repoId, baseSettings)).toEqual({ ok: true });
    expect((await getRepository(db, repoId))!.ralphSettings.model).toBe("claude-opus-5-5");

    expect(await updateRalphSettings(repoId, baseRalph)).toEqual({ ok: true });
    expect(await getRepository(db, repoId)).toMatchObject({
      ralphEnabled: null,
      ralphSettings: {
        openPullRequestEarly: false,
        setupCommand: null,
        model: "opus",
        manualLabels: ["manual"],
      },
      reviewDepth: "standard",
    });
  });

  it("defaults to the built-in story and request tasks", async () => {
    expect(await getRepository(db, repoId)).toMatchObject({
      storyTaskId: "builtin:implement-story",
      requestTaskId: "builtin:handle-request",
    });
  });

  it("saves custom story and request tasks", async () => {
    const story = await storedTask("builtin:implement-story");
    const request = await storedTask("builtin:handle-request");
    expect(
      await updateRalphSettings(repoId, {
        ...baseRalph,
        storyTaskId: story,
        requestTaskId: request,
      }),
    ).toEqual({ ok: true });
    expect(await getRepository(db, repoId)).toMatchObject({
      storyTaskId: story,
      requestTaskId: request,
    });
    expect(await updateRalphSettings(repoId, baseRalph)).toEqual({ ok: true });
    expect(await getRepository(db, repoId)).toMatchObject({
      storyTaskId: "builtin:implement-story",
      requestTaskId: "builtin:handle-request",
    });
  });

  it("rejects story and request tasks of another organization or of the wrong type or triggers without saving", async () => {
    const other = await otherOrganization();
    const othersStory = await storedTask("builtin:implement-story", {}, other);
    const othersRequest = await storedTask("builtin:handle-request", {}, other);
    const chatOnly = await storedTask("builtin:handle-request", { triggers: ["chat.request"] });

    for (const storyTaskId of [
      othersStory,
      "builtin:handle-request",
      "builtin:review-pr",
      "builtin:nope",
      randomUUID(),
    ]) {
      expect(await updateRalphSettings(repoId, { ...baseRalph, storyTaskId })).toMatchObject({
        ok: false,
        fieldErrors: { storyTaskId: expect.any(String) },
      });
    }
    for (const requestTaskId of [
      othersRequest,
      chatOnly,
      "builtin:implement-story",
      "builtin:nope",
    ]) {
      expect(await updateRalphSettings(repoId, { ...baseRalph, requestTaskId })).toMatchObject({
        ok: false,
        fieldErrors: { requestTaskId: expect.any(String) },
      });
    }
    expect(await getRepository(db, repoId)).toMatchObject({
      storyTaskId: "builtin:implement-story",
      requestTaskId: "builtin:handle-request",
    });
  });

  it("saves every cyralph setting, storing empty text and lists as none", async () => {
    expect((await getRepository(db, repoId))!.ralphSettings).toEqual(DEFAULT_RALPH_SETTINGS);
    expect(
      await updateRalphSettings(repoId, {
        ...baseRalph,
        verifyCommands: ["pnpm typecheck", "pnpm test"],
        runPrdQualityGates: false,
        appendInstruction: "  Keep commits small.  ",
        fallbackModel: "sonnet",
        allowedTools: ["Read", "Bash(pnpm test:*)"],
        disallowedTools: ["WebFetch"],
        allowPreparation: false,
        manualLabels: ["by hand"],
        blockedLabels: [],
        historyRewrite: "never",
        respondToReviews: false,
        maxReviewRounds: 5,
        respondToCiFailures: false,
        maxFixRounds: 0,
        cleanupMergedWorktrees: false,
        unmergedBranchTimeoutMinutes: 120,
        epicCompletedState: "In Review",
      }),
    ).toEqual({ ok: true });
    expect((await getRepository(db, repoId))!.ralphSettings).toEqual({
      ...DEFAULT_RALPH_SETTINGS,
      verifyCommands: ["pnpm typecheck", "pnpm test"],
      runPrdQualityGates: false,
      appendInstruction: "Keep commits small.",
      fallbackModel: "sonnet",
      allowedTools: ["Read", "Bash(pnpm test:*)"],
      disallowedTools: ["WebFetch"],
      allowPreparation: false,
      manualLabels: ["by hand"],
      blockedLabels: [],
      historyRewrite: "never",
      respondToReviews: false,
      maxReviewRounds: 5,
      respondToCiFailures: false,
      maxFixRounds: 0,
      cleanupMergedWorktrees: false,
      unmergedBranchTimeoutMinutes: 120,
      epicCompletedState: "In Review",
    });
    expect(await updateRalphSettings(repoId, { ...baseRalph, historyRewrite: "always" })).toEqual({
      ok: true,
    });
    expect((await getRepository(db, repoId))!.ralphSettings.historyRewrite).toBe("always");
    expect(await updateRalphSettings(repoId, baseRalph)).toEqual({ ok: true });
    expect((await getRepository(db, repoId))!.ralphSettings).toEqual(DEFAULT_RALPH_SETTINGS);
  });

  it("rejects invalid cyralph settings with field errors without saving", async () => {
    expect(
      await updateRalphSettings(repoId, {
        ...baseRalph,
        verifyCommands: ["pnpm test", "  "],
        allowedTools: ["not a tool"],
        fallbackModel: "x y",
        historyRewrite: "sometimes" as never,
        maxReviewRounds: -1,
        maxFixRounds: 2.5,
        unmergedBranchTimeoutMinutes: 0,
        epicCompletedState: "Done, really",
      }),
    ).toEqual({
      ok: false,
      error: "Fix the highlighted fields.",
      fieldErrors: {
        "verifyCommands.1": "Enter a command.",
        "allowedTools.0": "Enter a tool name or rule, e.g. Read or Bash(pnpm test:*).",
        fallbackModel: "Enter a Claude model ID, e.g. claude-sonnet-5-5.",
        historyRewrite: "Choose a policy.",
        maxReviewRounds: "Enter 0 or more.",
        maxFixRounds: "Enter a whole number.",
        unmergedBranchTimeoutMinutes: "Enter at least 1 minute.",
        epicCompletedState: "Names can't contain commas or control characters.",
      },
    });
    expect((await getRepository(db, repoId))!.ralphSettings).toEqual(DEFAULT_RALPH_SETTINGS);
  });

  it("rejects invalid Ralph settings with field errors without saving", async () => {
    expect(
      await updateRalphSettings(repoId, {
        ...baseRalph,
        model: "",
        manualLabels: [],
        blockedLabels: ["a,b"],
      }),
    ).toEqual({
      ok: false,
      error: "Fix the highlighted fields.",
      fieldErrors: {
        model: "Enter a model.",
        manualLabels: "Enter at least one manual label.",
        "blockedLabels.0": "Names can't contain commas or control characters.",
      },
    });
    // Not a valid input shape at all.
    expect(
      await updateRalphSettings(repoId, {
        ...baseRalph,
        runPrdQualityGates: "yes",
      } as unknown as RalphSettingsInput),
    ).toMatchObject({ ok: false, fieldErrors: { runPrdQualityGates: expect.any(String) } });
  });

  it("rejects Ralph settings for unknown repositories and from non-admins", async () => {
    expect(await updateRalphSettings(randomUUID(), baseRalph)).toEqual({
      ok: false,
      error: "That repository isn't connected.",
    });
    const before = (await getRepository(db, repoId))!.ralphSettings;
    state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
    expect(
      await updateRalphSettings(repoId, { ...baseRalph, manualLabels: ["members"] }),
    ).toMatchObject({ ok: false });
    expect((await getRepository(db, repoId))!.ralphSettings).toEqual(before);
  });

  describe("Linear values", () => {
    const workspace = {
      teams: [{ key: "ENG", name: "Engineering" }],
      labels: ["backend", "manual", "Needs Human"],
      projects: ["Omniralph"],
      states: ["In Review"],
      projectMilestones: [],
      cycles: [],
      users: [],
    };

    beforeEach(async () => {
      state.linear = null;
      state.linearLoads = 0;
      expect(await updateRalphSettings(repoId, baseRalph)).toEqual({ ok: true });
      state.linearLoads = 0;
    });

    afterAll(() => {
      state.linear = null;
    });

    it("saves values of the connected workspace, ignoring case", async () => {
      state.linear = workspace;
      expect(
        await updateRalphSettings(repoId, {
          ...baseRalph,
          manualLabels: ["needs human", "manual"],
          blockedLabels: ["blocked", "BACKEND"],
          epicCompletedState: "in review",
        }),
      ).toEqual({ ok: true });
      expect(await getRepository(db, repoId)).toMatchObject({
        ralphSettings: { manualLabels: ["needs human", "manual"], epicCompletedState: "in review" },
      });
      expect(
        await updateRalphSettings(repoId, { ...baseRalph, epicCompletedState: "completed" }),
      ).toEqual({ ok: true });
    });

    it("rejects values the workspace doesn't have, with an error on each field", async () => {
      state.linear = workspace;
      expect(
        await updateRalphSettings(repoId, {
          ...baseRalph,
          manualLabels: ["by-hand"],
          // The default "under-review" is already saved, so only "on-hold" is checked.
          blockedLabels: ["under-review", "on-hold"],
          epicCompletedState: "Shipped",
        }),
      ).toEqual({
        ok: false,
        error: "Fix the highlighted fields.",
        fieldErrors: {
          manualLabels: "“by-hand” isn't a label in your Linear workspace.",
          blockedLabels: "“on-hold” isn't a label in your Linear workspace.",
          epicCompletedState: "“Shipped” isn't a workflow state in your Linear workspace.",
        },
      });
      expect(await getRepository(db, repoId)).toMatchObject({
        ralphSettings: { manualLabels: ["manual"], epicCompletedState: null },
      });
    });

    it("keeps saved values that went stale, rejecting only new ones", async () => {
      // Saved while the workspace still had them.
      state.linear = { ...workspace, labels: [...workspace.labels, "old-name"] };
      const saved = { ...baseRalph, manualLabels: ["old-name"] };
      expect(await updateRalphSettings(repoId, saved)).toEqual({ ok: true });
      // Renamed in Linear since: other changes still save, and the stale label stays.
      state.linear = workspace;
      expect(await updateRalphSettings(repoId, { ...saved, maxFixRounds: 2 })).toEqual({
        ok: true,
      });
      expect((await getRepository(db, repoId))!.ralphSettings.manualLabels).toEqual(["old-name"]);
      expect(
        await updateRalphSettings(repoId, { ...saved, manualLabels: ["old-name", "new-one"] }),
      ).toMatchObject({
        ok: false,
        fieldErrors: { manualLabels: "“new-one” isn't a label in your Linear workspace." },
      });
    });

    it("doesn't check the values without a connected workspace", async () => {
      state.linear = null;
      expect(
        await updateRalphSettings(repoId, { ...baseRalph, manualLabels: ["anything"] }),
      ).toEqual({ ok: true });
      expect(state.linearLoads).toBe(1);
    });

    it("reads Linear only when a Linear value changed, and fails when it can't", async () => {
      state.linear = new Error("Linear is down");
      expect(await updateRalphSettings(repoId, { ...baseRalph, maxFixRounds: 1 })).toEqual({
        ok: true,
      });
      expect(state.linearLoads).toBe(0);
      expect(
        await updateRalphSettings(repoId, { ...baseRalph, manualLabels: ["backend"] }),
      ).toEqual({
        ok: false,
        error: "Couldn't check the Linear values against your workspace. Try again in a moment.",
      });
      expect((await getRepository(db, repoId))!.ralphSettings.manualLabels).toEqual(["manual"]);
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
