// The Repos page's card saves: `PUT /api/ui/repositories/{id}/reviews`, `/ask`, `/agents` and
// `/playbooks` (and the coding policy's `PUT …/coding`). Each saves its whole card in one
// transaction, records one change-history entry, publishes the repo's change after commit and
// answers the saved card in the detail's shape; a save that changes nothing does none of it.
import { randomBytes, randomUUID } from "node:crypto";
import {
  agentRepoPins,
  agents,
  closeDb,
  connectRepository,
  createDb,
  getRepository,
  insertPlaybook,
  jobs,
  organizations,
  repositories,
  settingsChanges,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import { captureChanges, type RecordedChange } from "@omniralph/db/changes";
import {
  createTestDatabase,
  setCodingEnabled,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import {
  reviewTriggerContext,
  type RepositoryCodingInput,
  type ReviewTriggerContext,
} from "@omniralph/shared";
import { getBuiltinPlaybook } from "@omniralph/tasks";
import type * as Tasks from "@omniralph/tasks";
import { and, asc, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentsCardSchema,
  askCardSchema,
  cardSaveResultSchema,
  playbooksCardSchema,
  reviewsCardSchema,
  type PlaybooksCardInput,
  type ReviewsCardInput,
} from "@/lib/api/repositories";
import { assertRole, type Role } from "@/lib/auth/roles";

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
vi.mock("@/lib/agents/npm", () => ({
  NpmRegistryError: class extends Error {},
  latestAgentVersion: async () => "9.9.9",
}));

const state = vi.hoisted(() => ({
  orgId: "",
  db: undefined as unknown as Database,
  user: null as {
    id: string;
    role: "admin" | "member";
    name: string;
    showAdvanced: boolean;
  } | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  // The signed-in user works in `state.orgId`.
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && {
        ...state.user,
        email: null,
        image: null,
        theme: null,
        organization: { id: state.orgId, name: "Acme" },
      },
      role,
    ),
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const reviewsRoute = await import("@/app/api/ui/repositories/[id]/reviews/route");
const askRoute = await import("@/app/api/ui/repositories/[id]/ask/route");
const agentsRoute = await import("@/app/api/ui/repositories/[id]/agents/route");
const playbooksRoute = await import("@/app/api/ui/repositories/[id]/playbooks/route");
const codingRoute = await import("@/app/api/ui/repositories/[id]/coding/route");
const detailRoute = await import("@/app/api/ui/repositories/[id]/route");
const { enqueueReview } = await import("@/lib/review/enqueue");
const { getDispatcher } = await import("@/lib/dispatch");

const databaseAvailable = testDatabaseAvailable();

type Handler = (request: Request, route: { params: Promise<{ id: string }> }) => Promise<Response>;

/** A `PUT` to `handler` as the page sends it; its status, JSON body and published changes. */
async function put(handler: Handler, id: string, body: unknown) {
  const { result: response, changes } = await captureChanges(() =>
    handler(
      new Request("http://localhost/api/ui", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    changes,
  };
}

/** What the changes are about: `resource` (and `:section`), sorted. */
const kinds = (changes: RecordedChange[]) =>
  changes.map((c) => (c.section ? `${c.resource}:${c.section}` : c.resource)).sort();

const SHA = (n: number) => n.toString(16).padStart(40, "0");

const ADMIN = { id: "admin-1", role: "admin" as const, name: "Ada Admin", showAdvanced: false };
const MEMBER = { id: "member-1", role: "member" as const, name: "Max Member", showAdvanced: true };

const baseReviews: ReviewsCardInput = {
  reviewsEnabled: true,
  triggers: { onOpen: true, onPush: true, drafts: false },
  depth: "standard",
  pathExcludes: [],
  reviewerInstructions: "",
};

const baseBindings: PlaybooksCardInput["bindings"] = {
  review: ["builtin:review-pr"],
  correlation: "builtin:correlate-findings",
  story: "builtin:implement-story",
  request: "builtin:handle-request",
};

const baseCoding: RepositoryCodingInput = {
  codingEnabled: true,
  codingInstructions: null,
  openPullRequestEarly: false,
  historyRewrite: "when-asked",
  respondToReviewsAndCi: true,
};

describe.skipIf(!databaseAvailable)("repo card saves", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let repoId: string;
  let githubRepoId: string;
  let otherRepoId: string;
  let agentA: string;
  let agentB: string;
  let revokedAgent: string;
  let deletedAgent: string;
  let foreignAgent: string;
  let prNumber = 0;

  const reviews = (body: unknown, id = repoId) => put(reviewsRoute.PUT, id, body);
  const ask = (body: unknown, id = repoId) => put(askRoute.PUT, id, body);
  const pins = (body: unknown, id = repoId) => put(agentsRoute.PUT, id, body);
  const playbooks = (body: unknown, id = repoId) => put(playbooksRoute.PUT, id, body);

  /** The repo's change-history entries of `section`, newest first. */
  async function history(section: string, id = repoId) {
    return db
      .select()
      .from(settingsChanges)
      .where(and(eq(settingsChanges.section, section), eq(settingsChanges.subjectId, id)))
      .orderBy(desc(settingsChanges.changedAt));
  }

  async function pinnedAgentIds(): Promise<string[]> {
    const rows = await db
      .select({ agentId: agentRepoPins.agentId })
      .from(agentRepoPins)
      .where(eq(agentRepoPins.repositoryId, repoId));
    return rows.map((r) => r.agentId).sort();
  }

  async function syncJobs() {
    return db.select().from(jobs).where(eq(jobs.type, "repo.sync")).orderBy(asc(jobs.createdAt));
  }

  async function enqueue() {
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
    return result;
  }

  async function enqueuedPayload(): Promise<ReviewTriggerContext> {
    const result = await enqueue();
    const [job] = await db.select().from(jobs).where(eq(jobs.id, result.jobId));
    return reviewTriggerContext(job!.payload);
  }

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

  async function connect(organizationId: string, provider: "github" | "gitlab", path: string) {
    const connection = (await upsertScmConnection(db, {
      organizationId,
      provider,
      name: `${path} bot`,
      baseUrl: provider === "gitlab" ? "https://gitlab.example.com" : "https://api.github.com",
      externalId: `${path}-connection`,
      credentials: { token: "glpat-bot", webhookSecret: "hook" },
    }))!;
    return (
      await connectRepository(db, {
        connectionId: connection.id,
        provider,
        externalId: `${path}-1`,
        fullPath: path,
      })
    ).id;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgId = org!.id;
    otherOrgId = other!.id;
    state.orgId = orgId;
    await db.insert(users).values([
      { id: ADMIN.id, email: "admin@example.com" },
      { id: MEMBER.id, email: "member@example.com" },
    ]);
    repoId = await connect(orgId, "gitlab", "acme/api");
    githubRepoId = await connect(orgId, "github", "acme/web");
    otherRepoId = await connect(otherOrgId, "gitlab", "other/api");
    // Coding on without a work item match, as on a repository that had it before matches.
    await setCodingEnabled(db, repoId);
    const now = new Date();
    [agentA, agentB, revokedAgent, deletedAgent, foreignAgent] = (
      await db
        .insert(agents)
        .values([
          { organizationId: orgId, name: "coder-a", lastHeartbeatAt: now },
          { organizationId: orgId, name: "coder-b", lastHeartbeatAt: now },
          { organizationId: orgId, name: "coder-old", revokedAt: now },
          { organizationId: orgId, name: "coder-gone", revokedAt: now, deletedAt: now },
          { organizationId: otherOrgId, name: "coder-foreign" },
        ])
        .returning({ id: agents.id })
    ).map((a) => a.id) as [string, string, string, string, string];
  }, 180_000);

  beforeEach(async () => {
    state.user = ADMIN;
    state.orgId = orgId;
    await db.delete(agentRepoPins);
    await db.delete(jobs);
    await db.delete(settingsChanges);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  describe("PUT …/reviews", () => {
    it("saves the whole card in one entry, publishes the repo's change and answers the card", async () => {
      const { status, body, changes } = await reviews({
        reviewsEnabled: false,
        triggers: { onOpen: false, onPush: true, drafts: true },
        depth: "quick",
        pathExcludes: ["*.snap", "/docs/**"],
        reviewerInstructions: "  Prefer early returns.  ",
      });
      expect(status).toBe(200);
      const card = {
        enabled: false,
        triggers: { onOpen: false, onPush: true, drafts: true },
        depth: "quick",
        pathExcludes: ["*.snap", "/docs/**"],
        reviewerInstructions: "Prefer early returns.",
      };
      expect(cardSaveResultSchema(reviewsCardSchema).parse(body)).toEqual({ ok: true, card });
      expect(await getRepository(db, repoId)).toMatchObject({
        reviewsEnabled: false,
        reviewDepth: "quick",
        triggers: { onOpen: false, onPush: true, drafts: true },
        pathExcludes: ["*.snap", "/docs/**"],
        customInstructions: "Prefer early returns.",
      });
      // The detail shows the same card.
      const detail = await detailRoute.GET(new Request("http://localhost/api/ui"), {
        params: Promise.resolve({ id: repoId }),
      });
      expect(((await detail.json()) as { reviews: unknown }).reviews).toEqual(card);

      // One entry, labeled as the card (MR on GitLab), by the admin.
      const [entry, ...rest] = await history("repository.reviews");
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({ organizationId: orgId, actorUserId: ADMIN.id });
      expect(entry!.actorName).toBe("Ada Admin");
      expect(entry!.changes).toEqual([
        { field: "reviews", label: "Reviews", before: "On", after: "Off" },
        { field: "onOpen", label: "MR opened", before: "On", after: "Off" },
        { field: "drafts", label: "Drafts too", before: "Off", after: "On" },
        { field: "depth", label: "Depth", before: "Standard", after: "Quick" },
        { field: "pathExcludes", label: "Skip paths", before: [], after: ["*.snap", "/docs/**"] },
        {
          field: "reviewerInstructions",
          label: "Reviewer instructions",
          before: null,
          after: "Prefer early returns.",
        },
      ]);
      // The repo's change (its rail row and detail) and the history's, after commit.
      expect(kinds(changes)).toEqual(["repository", "settings:repository.reviews"]);
      expect(changes.find((c) => c.resource === "repository")).toMatchObject({
        ids: [repoId],
        organizationId: orgId,
      });

      // The same card again changes, records and publishes nothing.
      const again = await reviews({
        reviewsEnabled: false,
        triggers: { onOpen: false, onPush: true, drafts: true },
        depth: "quick",
        pathExcludes: ["*.snap", "/docs/**"],
        reviewerInstructions: "Prefer early returns.",
      });
      expect(again).toMatchObject({ status: 200, body: { ok: true, card }, changes: [] });
      expect(await history("repository.reviews")).toHaveLength(1);

      // Back to the defaults: empty instructions are none.
      expect((await reviews(baseReviews)).status).toBe(200);
      expect(await getRepository(db, repoId)).toMatchObject({
        reviewsEnabled: true,
        reviewDepth: "standard",
        pathExcludes: [],
        customInstructions: null,
      });
    });

    it("labels the open trigger PR opened on GitHub", async () => {
      expect(
        (
          await reviews(
            { ...baseReviews, triggers: { ...baseReviews.triggers, onOpen: false } },
            githubRepoId,
          )
        ).status,
      ).toBe(200);
      expect((await history("repository.reviews", githubRepoId))[0]!.changes).toEqual([
        { field: "onOpen", label: "PR opened", before: "On", after: "Off" },
      ]);
      await reviews(baseReviews, githubRepoId);
    });

    it("applies to the next enqueued review job", async () => {
      const before = await enqueuedPayload();
      expect(before.reviewConfig).toMatchObject({
        profile: { id: "standard" },
        pathExcludes: [],
        customInstructions: null,
      });
      expect(
        (
          await reviews({
            ...baseReviews,
            depth: "deep",
            pathExcludes: ["*.snap"],
            reviewerInstructions: "Check error handling.",
          })
        ).status,
      ).toBe(200);
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
      await reviews(baseReviews);
    });

    it("answers field errors keyed by path for bad globs, long instructions and unknown depths", async () => {
      expect(
        await reviews({
          ...baseReviews,
          pathExcludes: ["*.snap", "src/[abc.ts", "!keep.ts"],
          reviewerInstructions: "x".repeat(4001),
        }),
      ).toMatchObject({
        status: 400,
        body: {
          fieldErrors: {
            "pathExcludes.1": 'Missing a closing "]".',
            "pathExcludes.2": "Negated patterns (starting with !) aren't supported.",
            reviewerInstructions: "Reviewer instructions can be at most 4,000 characters.",
          },
        },
        changes: [],
      });
      for (const depth of ["thorough", "Deep", null, undefined]) {
        expect(
          await reviews({ ...baseReviews, depth, reviewerInstructions: "Changed." }),
        ).toMatchObject({
          status: 400,
          body: { fieldErrors: { depth: "Choose a review depth: quick, standard or deep." } },
          changes: [],
        });
      }
      expect(
        await reviews({ ...baseReviews, triggers: { ...baseReviews.triggers, onOpen: "yes" } }),
      ).toMatchObject({
        status: 400,
        body: { fieldErrors: { "triggers.onOpen": "Choose on or off." } },
      });
      expect(await getRepository(db, repoId)).toMatchObject({
        reviewDepth: "standard",
        pathExcludes: [],
        customInstructions: null,
      });
      expect(await history("repository.reviews")).toEqual([]);
    });
  });

  describe("PUT …/ask", () => {
    it("saves the switch in its own section, publishes the repo's change and answers the card", async () => {
      const off = await ask({ askEnabled: false });
      expect(off.status).toBe(200);
      expect(cardSaveResultSchema(askCardSchema).parse(off.body)).toEqual({
        ok: true,
        card: { enabled: false },
      });
      expect((await getRepository(db, repoId))!.askEnabled).toBe(false);
      expect(kinds(off.changes)).toEqual(["repository", "settings:repository.ask"]);
      const [entry, ...rest] = await history("repository.ask");
      expect(rest).toEqual([]);
      expect(entry!.changes).toEqual([{ field: "ask", label: "Ask", before: "On", after: "Off" }]);
      // Nothing of the Coding card's.
      expect(await history("repository.coding")).toEqual([]);

      expect(await ask({ askEnabled: false })).toMatchObject({
        status: 200,
        body: { ok: true, card: { enabled: false } },
        changes: [],
      });
      expect(await history("repository.ask")).toHaveLength(1);

      expect((await ask({ askEnabled: true })).status).toBe(200);
      expect((await getRepository(db, repoId))!.askEnabled).toBe(true);
    });
  });

  describe("PUT …/agents", () => {
    it("pins and unpins, records one entry, publishes the agents' and repo's changes and syncs new pins", async () => {
      const first = await pins({ pinnedAgentIds: [agentA] });
      expect(first.status).toBe(200);
      const { card } = cardSaveResultSchema(agentsCardSchema).parse(first.body);
      expect(card.pinned).toEqual([
        { id: agentA, name: "coder-a", state: "idle", runningForRepo: 0 },
      ]);
      expect(card.pinnable.map((a) => a.name)).toEqual(["coder-b"]);
      expect(await pinnedAgentIds()).toEqual([agentA]);
      // (and the `repo.sync` job's own change).
      expect(kinds(first.changes)).toEqual([
        "agent",
        "repository",
        "run",
        "settings:repository.agents",
      ]);
      expect(first.changes.find((c) => c.resource === "agent")!.ids).toEqual([agentA]);
      expect((await history("repository.agents"))[0]!.changes).toEqual([
        { field: "agents", label: "Pinned agents", before: [], after: ["coder-a"] },
      ]);
      const [job, ...others] = await syncJobs();
      expect(others).toHaveLength(0);
      expect(job).toMatchObject({
        type: "repo.sync",
        taskType: "system",
        status: "queued",
        repositoryId: repoId,
        targetAgentId: agentA,
      });
      expect(job!.payload).toMatchObject({ repository: { fullPath: "acme/api" } });

      // Swapping A for B syncs only to B; keeping B pinned changes and syncs nothing.
      const swap = await pins({ pinnedAgentIds: [agentB] });
      expect(swap.status).toBe(200);
      expect(swap.changes.find((c) => c.resource === "agent")!.ids.sort()).toEqual(
        [agentA, agentB].sort(),
      );
      expect(await pinnedAgentIds()).toEqual([agentB]);
      expect((await syncJobs()).map((j) => j.targetAgentId)).toEqual([agentA, agentB]);
      expect(await pins({ pinnedAgentIds: [agentB, agentB] })).toMatchObject({
        status: 200,
        changes: [],
      });
      expect(await syncJobs()).toHaveLength(2);
      expect(await history("repository.agents")).toHaveLength(2);

      // None pinned means any agent.
      const none = await pins({ pinnedAgentIds: [] });
      expect(none).toMatchObject({ status: 200, body: { card: { pinned: [] } } });
      expect(await pinnedAgentIds()).toEqual([]);
      expect((await history("repository.agents"))[0]!.changes).toEqual([
        { field: "agents", label: "Pinned agents", before: ["coder-b"], after: [] },
      ]);
    });

    it("rejects revoked, deleted, unknown and other organizations' agents with 400, saving nothing", async () => {
      await pins({ pinnedAgentIds: [agentB] });
      await db.delete(jobs);
      await db.delete(settingsChanges);
      for (const agentId of [revokedAgent, deletedAgent, randomUUID(), foreignAgent]) {
        expect(await pins({ pinnedAgentIds: [agentA, agentId] })).toMatchObject({
          status: 400,
          body: {
            error: "Some selected agents don't exist or were revoked.",
            fieldErrors: { pinnedAgentIds: "Some selected agents don't exist or were revoked." },
          },
          changes: [],
        });
      }
      expect(await pins({ pinnedAgentIds: ["not-a-uuid"] })).toMatchObject({
        status: 400,
        body: { fieldErrors: { "pinnedAgentIds.0": "Choose an agent." } },
      });
      expect(await pinnedAgentIds()).toEqual([agentB]);
      expect(await db.select().from(jobs)).toHaveLength(0);
      expect(await history("repository.agents")).toEqual([]);
    });
  });

  describe("PUT …/playbooks", () => {
    it("saves custom bindings for an admin whose Show advanced settings is off", async () => {
      expect(state.user!.showAdvanced).toBe(false);
      const review = await storedPlaybook("builtin:review-pr", {
        promptTemplate: "Review {{repository}} for security problems.",
      });
      const correlation = await storedPlaybook("builtin:correlate-findings");
      const story = await storedPlaybook("builtin:implement-story", {
        coding: { maxReviewRounds: 5, maxFixRounds: 1 },
      });
      const request = await storedPlaybook("builtin:handle-request");
      const saved = await playbooks({
        bindings: { review: ["builtin:review-pr", review], correlation, story, request },
      });
      expect(saved.status).toBe(200);
      const { card } = cardSaveResultSchema(playbooksCardSchema).parse(saved.body);
      expect(card.bindings).toEqual({
        review: ["builtin:review-pr", review],
        correlation,
        story,
        request,
      });
      expect(card.choices.story.map((c) => c.id)).toContain(story);
      expect(await getRepository(db, repoId)).toMatchObject({
        reviewPlaybookIds: ["builtin:review-pr", review],
        correlationPlaybookId: correlation,
        storyPlaybookId: story,
        requestPlaybookId: request,
      });
      expect(kinds(saved.changes)).toEqual(["repository", "settings:repository.playbooks"]);
      const [entry, ...rest] = await history("repository.playbooks");
      expect(rest).toEqual([]);
      expect(entry!.changes).toEqual([
        {
          field: "review",
          label: "Review playbook",
          before: ["Review a pull request"],
          after: ["Review a pull request", "Custom Review a pull request"],
        },
        {
          field: "correlation",
          label: "Combine review findings playbook",
          before: expect.any(String),
          after: expect.stringMatching(/^Custom /),
        },
        {
          field: "story",
          label: "Stories playbook",
          before: expect.any(String),
          after: expect.stringMatching(/^Custom /),
        },
        {
          field: "request",
          label: "Requests playbook",
          before: expect.any(String),
          after: expect.stringMatching(/^Custom /),
        },
      ]);
      // Nothing of the Reviews or Coding cards'.
      expect(await history("repository.reviews")).toEqual([]);
      expect(await history("repository.coding")).toEqual([]);

      // The next review run fans out to the bound playbooks; the coding card reads the
      // story playbook's rounds.
      const run = await enqueue();
      expect(run.runs.map((r) => r.taskId)).toEqual(["builtin:review-pr", review]);
      const coding = await codingRoute.GET(new Request("http://localhost/api/ui"), {
        params: Promise.resolve({ id: repoId }),
      });
      expect(((await coding.json()) as { roundLimits: unknown }).roundLimits).toEqual({
        maxReviewRounds: 5,
        maxFixRounds: 1,
      });

      // The same bindings again change nothing.
      expect(
        await playbooks({
          bindings: { review: ["builtin:review-pr", review], correlation, story, request },
        }),
      ).toMatchObject({ status: 200, changes: [] });
      expect(await history("repository.playbooks")).toHaveLength(1);

      expect((await playbooks({ bindings: baseBindings })).status).toBe(200);
      expect(await getRepository(db, repoId)).toMatchObject({
        reviewPlaybookIds: ["builtin:review-pr"],
        storyPlaybookId: "builtin:implement-story",
      });
    });

    it("saves a second built-in review playbook, and the next review run fans out to both", async () => {
      expect(
        (
          await playbooks({
            bindings: { ...baseBindings, review: [SECURITY_TASK_ID, "builtin:review-pr"] },
          })
        ).status,
      ).toBe(200);
      expect((await enqueue()).runs.map((r) => r.taskId)).toEqual([
        SECURITY_TASK_ID,
        "builtin:review-pr",
      ]);
      await playbooks({ bindings: baseBindings });
    });

    it("checks each playbook's role against its binding (400), saving nothing", async () => {
      const othersReview = await storedPlaybook("builtin:review-pr", {}, otherOrgId);
      const othersStory = await storedPlaybook("builtin:implement-story", {}, otherOrgId);
      const chatAsk = await storedPlaybook("builtin:ask-about-code");
      const correlation = await storedPlaybook("builtin:correlate-findings");
      // A stored playbook that no longer parses (a field its role sets).
      const unresolvable = await storedPlaybook("builtin:review-pr", { sink: "review" });
      const notReview = "Choose review or review-summary playbooks of this organization.";
      const refusals: [Partial<PlaybooksCardInput["bindings"]>, string, string][] = [
        [{ review: [othersReview] }, "bindings.review", notReview],
        [{ review: [chatAsk] }, "bindings.review", notReview],
        [{ review: ["builtin:review-pr", correlation] }, "bindings.review", notReview],
        [{ review: [unresolvable] }, "bindings.review", notReview],
        [{ review: ["builtin:reply-to-finding"] }, "bindings.review", notReview],
        [{ review: [] }, "bindings.review", "Choose a review playbook."],
        [
          { review: ["builtin:review-pr", "builtin:review-pr"] },
          "bindings.review",
          "Choose each review playbook once.",
        ],
        [{ correlation: "builtin:review-pr" }, "bindings.correlation", expect.any(String)],
        [{ correlation: randomUUID() }, "bindings.correlation", expect.any(String)],
        [{ story: othersStory }, "bindings.story", expect.any(String)],
        [{ story: "builtin:handle-request" }, "bindings.story", expect.any(String)],
        [{ request: "builtin:implement-story" }, "bindings.request", expect.any(String)],
        [{ request: "builtin:nope" }, "bindings.request", expect.any(String)],
      ];
      for (const [binding, field, message] of refusals) {
        expect(await playbooks({ bindings: { ...baseBindings, ...binding } }), field).toMatchObject(
          {
            status: 400,
            body: { fieldErrors: { [field]: message } },
            changes: [],
          },
        );
      }
      expect(await getRepository(db, repoId)).toMatchObject({
        reviewPlaybookIds: ["builtin:review-pr"],
        correlationPlaybookId: "builtin:correlate-findings",
        storyPlaybookId: "builtin:implement-story",
        requestPlaybookId: "builtin:handle-request",
      });
      expect(await history("repository.playbooks")).toEqual([]);
    });
  });

  describe("every card", () => {
    const valid = () =>
      [
        [reviewsRoute.PUT, { ...baseReviews, depth: "deep" }],
        [askRoute.PUT, { askEnabled: false }],
        [agentsRoute.PUT, { pinnedAgentIds: [agentA] }],
        [playbooksRoute.PUT, { bindings: { ...baseBindings, review: [SECURITY_TASK_ID] } }],
      ] as const;

    it("answers 400 for unknown keys", async () => {
      for (const [handler, body] of valid()) {
        for (const extra of [
          { storyPlaybookId: "x" },
          { customInstructions: "x" },
          { ask: true },
        ]) {
          expect(await put(handler, repoId, { ...body, ...extra })).toMatchObject({
            status: 400,
            changes: [],
          });
        }
      }
      expect(
        await put(playbooksRoute.PUT, repoId, { bindings: { ...baseBindings, chat: "x" } }),
      ).toMatchObject({ status: 400 });
      expect(await history("repository.reviews")).toEqual([]);
    });

    it("answers 403 for members, 404 for another organization's, unknown or removed repos", async () => {
      const removedId = await connect(orgId, "gitlab", "acme/removed");
      await db
        .update(repositories)
        .set({ disconnectedAt: new Date() })
        .where(eq(repositories.id, removedId));
      for (const [handler, body] of valid()) {
        for (const id of [otherRepoId, randomUUID(), "not-a-uuid", removedId]) {
          expect(await put(handler, id, body)).toMatchObject({ status: 404, changes: [] });
        }
        state.user = MEMBER;
        expect(await put(handler, repoId, body)).toMatchObject({ status: 403, changes: [] });
        state.user = ADMIN;
      }
      expect(await getRepository(db, repoId)).toMatchObject({
        reviewDepth: "standard",
        askEnabled: true,
        reviewPlaybookIds: ["builtin:review-pr"],
      });
      expect(await getRepository(db, otherRepoId)).toMatchObject({
        reviewDepth: "standard",
        askEnabled: true,
      });
      expect(await pinnedAgentIds()).toEqual([]);
      expect(await db.select().from(settingsChanges)).toEqual([]);
    });
  });

  describe("coding policy (PUT …/coding)", () => {
    const getCoding = async (id = repoId) => {
      const response = await codingRoute.GET(new Request("http://localhost/api/ui"), {
        params: Promise.resolve({ id }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const updateCoding = (body: unknown, id = repoId) => put(codingRoute.PUT, id, body);

    beforeEach(() => setCodingEnabled(db, repoId));

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
      const { status, body, changes } = await updateCoding(policy);
      const saved = {
        ...policy,
        codingInstructions: "NEVER use `git merge` in this repo, ALWAYS rebase.",
        roundLimits: { maxReviewRounds: 3, maxFixRounds: 3 },
      };
      expect(status).toBe(200);
      expect(body).toEqual(saved);
      expect(kinds(changes)).toEqual(["settings:repository.coding"]);
      expect((await getCoding()).body).toEqual(saved);
      // Saving the Reviews card leaves the coding policy alone.
      expect((await reviews({ ...baseReviews, depth: "deep" })).status).toBe(200);
      expect((await getCoding()).body).toEqual(saved);
      await reviews(baseReviews);

      // Switched off, Coding can't come back on without a work item match.
      const refused = await updateCoding({ ...baseCoding, codingInstructions: "" });
      expect(refused).toMatchObject({
        status: 409,
        body: { error: "Add a work item match before turning on Coding." },
        changes: [],
      });
      expect(await getRepository(db, repoId)).toMatchObject({
        codingEnabled: false,
        codingInstructions: "NEVER use `git merge` in this repo, ALWAYS rebase.",
      });

      // Empty instructions are none.
      await setCodingEnabled(db, repoId);
      expect((await updateCoding({ ...baseCoding, codingInstructions: "" })).body).toEqual({
        ...baseCoding,
        roundLimits: { maxReviewRounds: 3, maxFixRounds: 3 },
      });
      expect(await getRepository(db, repoId)).toMatchObject({
        codingEnabled: true,
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
        const { status, body, changes } = await updateCoding({
          ...baseCoding,
          codingEnabled: false,
          [key]: "x",
        });
        expect(status, key).toBe(400);
        expect(body.error, key).toEqual(expect.stringContaining(key));
        expect(changes).toEqual([]);
      }
      expect(
        await updateCoding({
          ...baseCoding,
          codingEnabled: "yes",
          historyRewrite: "sometimes",
          codingInstructions: "x".repeat(10_001),
        }),
      ).toMatchObject({
        status: 400,
        body: {
          fieldErrors: {
            codingEnabled: "Choose on or off.",
            historyRewrite: "Choose a policy.",
            codingInstructions: "Extra instructions can be at most 10,000 characters.",
          },
        },
      });
      const { codingEnabled: _missing, ...partial } = baseCoding;
      expect(await updateCoding(partial)).toMatchObject({
        status: 400,
        body: { fieldErrors: { codingEnabled: "Choose on or off." } },
      });
      expect(await getRepository(db, repoId)).toEqual(before);
    });

    it("rejects coding saves for unknown repositories and from non-admins", async () => {
      const before = await getRepository(db, repoId);
      expect(await updateCoding(baseCoding, randomUUID())).toMatchObject({
        status: 400,
        body: { error: "That repository isn't connected." },
      });
      state.user = MEMBER;
      expect((await updateCoding({ ...baseCoding, codingEnabled: false })).status).toBe(403);
      expect((await getCoding()).status).toBe(403);
      expect(await getRepository(db, repoId)).toEqual(before);
    });
  });
});
