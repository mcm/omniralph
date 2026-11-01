// The Repos page's card saves: `PUT /api/ui/repositories/{id}/reviews`, `/coding` (with
// `POST …/coding/match-check`), `/ask`, `/agents` and `/playbooks`. Each saves its whole card in one
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
  integrations,
  jobs,
  organizations,
  repositories,
  saveIntegration,
  saveWorkItemMatch,
  settingsChanges,
  upsertScmConnection,
  users,
  workItemMatches,
  type Database,
  type WorkItemMatchFields,
} from "@omniralph/db";
import { captureChanges, type RecordedChange } from "@omniralph/db/changes";
import {
  createTestDatabase,
  setCodingEnabled,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { reviewTriggerContext, type ReviewTriggerContext } from "@omniralph/shared";
import { getBuiltinPlaybook } from "@omniralph/tasks";
import type * as Tasks from "@omniralph/tasks";
import { and, asc, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentsCardSchema,
  askCardSchema,
  cardSaveResultSchema,
  codingCardSaveResultSchema,
  playbooksCardSchema,
  reviewsCardSchema,
  type CodingCardInput,
  type PlaybooksCardInput,
  type ReviewsCardInput,
} from "@/lib/api/repositories";
import type { WorkItemMatchRow } from "@/lib/api/work-item-matches";
import { assertRole, type Role } from "@/lib/auth/roles";
import { trackerNotConnectedForMatch } from "@/lib/repositories/work-item-match";
import { labelsInclude, setRoutingRules, teamIs } from "@/lib/routing/testing";

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
/** The Linear workspace options the match editor reads (null: none connected; Error: fails). */
const linear = vi.hoisted(() => ({
  options: null as unknown,
  organizations: [] as string[],
}));
vi.mock("@/lib/tracker/settings-options", () => ({
  getTrackerSettingsOptions: async (organizationId: string) => {
    linear.organizations.push(organizationId);
    if (linear.options instanceof Error) throw linear.options;
    return linear.options;
  },
}));
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
const matchCheckRoute = await import("@/app/api/ui/repositories/[id]/coding/match-check/route");
const trackerOptionsRoute =
  await import("@/app/api/ui/repositories/[id]/coding/tracker-options/route");
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

const baseCoding: CodingCardInput = {
  codingEnabled: true,
  workItemMatch: null,
  codingInstructions: null,
  openPullRequestEarly: false,
  historyRewrite: "when-asked",
  respondToReviewsAndCi: true,
  checks: [],
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
          { organizationId: orgId, name: "coder-a", lastHeartbeatAt: now, liveOnline: true },
          { organizationId: orgId, name: "coder-b", lastHeartbeatAt: now, liveOnline: true },
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
      const detail = await detailRoute.GET(new Request("http://localhost/api/ui"), {
        params: Promise.resolve({ id: repoId }),
      });
      expect(
        ((await detail.json()) as { coding: { roundLimits: unknown } }).coding.roundLimits,
      ).toEqual({ review: 5, fix: 1 });

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
        [codingRoute.PUT, { ...baseCoding, codingEnabled: false, historyRewrite: "always" }],
        [matchCheckRoute.POST, { workItemMatch: { tracker: "linear", team: "ENG" } }],
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
        codingEnabled: true,
        historyRewrite: "when-asked",
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

  describe("PUT …/coding", () => {
    let codingRepo: string;
    let docsRepo: string;
    let portalRepo: string;
    let gitlabRepo: string;

    const coding = (body: unknown, id = codingRepo) => put(codingRoute.PUT, id, body);
    const matchCheck = (body: unknown, id = codingRepo) => put(matchCheckRoute.POST, id, body);
    const soc = { tracker: "linear", team: "SOC", labels: ["product:portal"] } as const;
    /** The match as the card shows it. */
    const shown = (match: Partial<WorkItemMatchRow>) => ({
      tracker: "linear",
      project: null,
      withoutProject: false,
      labels: [],
      ...match,
      updatedAt: expect.any(String),
    });
    /** Sets `id`'s match directly (Coding stays as it is). */
    const setMatch = (id: string, match: Partial<WorkItemMatchFields> & { team: string }) =>
      saveWorkItemMatch(db, {
        organizationId: orgId,
        repositoryId: id,
        userId: null,
        match: { tracker: "linear", project: null, withoutProject: false, labels: [], ...match },
      });
    const detailCoding = async (id = codingRepo) => {
      const response = await detailRoute.GET(new Request("http://localhost/api/ui"), {
        params: Promise.resolve({ id }),
      });
      return ((await response.json()) as { coding: unknown }).coding;
    };
    const repositoryChange = (changes: RecordedChange[]) =>
      changes.find((c) => c.resource === "repository");

    beforeAll(async () => {
      codingRepo = await connect(orgId, "github", "acme/coding");
      docsRepo = await connect(orgId, "github", "acme/docs");
      portalRepo = await connect(orgId, "github", "acme/portal");
      gitlabRepo = await connect(orgId, "gitlab", "acme/gitlab-coding");
    });

    beforeEach(async () => {
      await db.delete(workItemMatches);
      await db.delete(integrations);
      await setRoutingRules(db, orgId);
      await db
        .update(repositories)
        .set({
          codingEnabled: false,
          codingInstructions: null,
          openPullRequestEarly: false,
          historyRewrite: "when-asked",
          respondToReviewsAndCi: true,
          checks: [],
        })
        .where(eq(repositories.organizationId, orgId));
      await setCodingEnabled(db, repoId);
      await saveIntegration(db, {
        organizationId: orgId,
        provider: "linear",
        externalId: "linear-org",
        name: "Acme",
        credentials: { accessToken: "t" },
        installedByUserId: null,
      });
    });

    it("turns Coding on with a new match in one save: one entry, the repo's change, the card", async () => {
      const { status, body, changes } = await coding({
        ...baseCoding,
        workItemMatch: { ...soc, team: " SOC ", labels: ["product:portal", "Product:Portal"] },
        codingInstructions: "  Always rebase.  ",
        openPullRequestEarly: true,
        historyRewrite: "always",
        respondToReviewsAndCi: false,
      });
      expect(status).toBe(200);
      const card = {
        enabled: true,
        workItemMatch: shown({ team: "SOC", labels: ["product:portal"] }),
        codingInstructions: "Always rebase.",
        openPullRequestEarly: true,
        historyRewrite: "always",
        respondToReviewsAndCi: false,
        checks: [],
        roundLimits: { review: 3, fix: 3 },
        routingRules: [],
      };
      expect(codingCardSaveResultSchema.parse(body)).toEqual({ ok: true, card, warnings: [] });
      expect(await getRepository(db, codingRepo)).toMatchObject({
        codingEnabled: true,
        codingInstructions: "Always rebase.",
        openPullRequestEarly: true,
        historyRewrite: "always",
        respondToReviewsAndCi: false,
      });
      const [row] = await db
        .select()
        .from(workItemMatches)
        .where(eq(workItemMatches.repositoryId, codingRepo));
      expect(row).toMatchObject({ createdBy: ADMIN.id, updatedBy: ADMIN.id });
      // The detail shows the same card.
      expect(await detailCoding()).toEqual(body.card);

      // One entry, labeled as the card, with the match as its sentence.
      const [entry, ...rest] = await history("repository.coding", codingRepo);
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({ actorUserId: ADMIN.id, actorName: "Ada Admin" });
      expect(entry!.changes).toEqual([
        { field: "coding", label: "Coding", before: "Off", after: "On" },
        {
          field: "workItemMatch",
          label: "Work item match",
          before: null,
          after: "Linear team SOC, label product:portal",
        },
        {
          field: "codingInstructions",
          label: "Extra instructions",
          before: null,
          after: "Always rebase.",
        },
        {
          field: "openPullRequestEarly",
          label: "Open a draft pull request after the first story",
          before: "Off",
          after: "On",
        },
        {
          field: "respondToReviewsAndCi",
          label: "Fix review comments and CI failures",
          before: "On",
          after: "Off",
        },
        {
          field: "historyRewrite",
          label: "Rewrite history",
          before: "When asked",
          after: "Always",
        },
      ]);
      // The repo's change (rail row and detail) and the history's, after commit.
      expect(kinds(changes)).toEqual(["repository", "settings:repository.coding"]);
      expect(repositoryChange(changes)).toMatchObject({ ids: [codingRepo], organizationId: orgId });

      // The same card again writes, records and publishes nothing.
      const again = await coding({
        ...baseCoding,
        workItemMatch: soc,
        codingInstructions: "Always rebase.",
        openPullRequestEarly: true,
        historyRewrite: "always",
        respondToReviewsAndCi: false,
      });
      expect(again).toMatchObject({
        status: 200,
        body: { ok: true, card, warnings: [] },
        changes: [],
      });
      expect(await history("repository.coding", codingRepo)).toHaveLength(1);
    });

    it("turns Coding off and clears the match in one save", async () => {
      expect((await coding({ ...baseCoding, workItemMatch: soc })).status).toBe(200);
      const { status, body, changes } = await coding({
        ...baseCoding,
        codingEnabled: false,
        workItemMatch: null,
      });
      expect(status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        card: { enabled: false, workItemMatch: null },
        warnings: [],
      });
      expect(await getRepository(db, codingRepo)).toMatchObject({ codingEnabled: false });
      expect(await db.select().from(workItemMatches)).toEqual([]);
      expect(kinds(changes)).toEqual(["repository", "settings:repository.coding"]);
      expect((await history("repository.coding", codingRepo))[0]!.changes).toEqual([
        { field: "coding", label: "Coding", before: "On", after: "Off" },
        {
          field: "workItemMatch",
          label: "Work item match",
          before: "Linear team SOC, label product:portal",
          after: null,
        },
      ]);
    });

    it("answers 409 for Coding on without a match, and for clearing the match with Coding on", async () => {
      const noMatch = await coding({ ...baseCoding, codingInstructions: "x" });
      expect(noMatch).toEqual({
        status: 409,
        body: {
          error: "Add a work item match before turning on Coding.",
          code: "work_item_match_required",
        },
        changes: [],
      });
      expect(await getRepository(db, codingRepo)).toMatchObject({
        codingEnabled: false,
        codingInstructions: null,
      });

      await coding({ ...baseCoding, workItemMatch: soc });
      const cleared = await coding({ ...baseCoding, workItemMatch: null, historyRewrite: "never" });
      expect(cleared).toEqual({
        status: 409,
        body: {
          error: "Turn off Coding before removing the work item match.",
          code: "coding_enabled",
        },
        changes: [],
      });
      expect(await getRepository(db, codingRepo)).toMatchObject({
        codingEnabled: true,
        historyRewrite: "when-asked",
      });
      expect(await db.select().from(workItemMatches)).toHaveLength(1);
      expect(await history("repository.coding", codingRepo)).toHaveLength(1);

      // A repo that had Coding on before work item matches keeps it without one.
      expect(await coding({ ...baseCoding, codingInstructions: "Kept on." }, repoId)).toMatchObject(
        { status: 200, body: { card: { enabled: true, workItemMatch: null } } },
      );
    });

    it("changes the match and the policy with Coding staying on", async () => {
      await coding({ ...baseCoding, workItemMatch: soc });
      const { body, changes } = await coding({
        ...baseCoding,
        workItemMatch: { tracker: "linear", team: "MOD", withoutProject: true },
      });
      expect(body).toMatchObject({
        card: { enabled: true, workItemMatch: shown({ team: "MOD", withoutProject: true }) },
      });
      expect(kinds(changes)).toEqual(["repository", "settings:repository.coding"]);
      expect((await history("repository.coding", codingRepo))[0]!.changes).toEqual([
        {
          field: "workItemMatch",
          label: "Work item match",
          before: "Linear team SOC, label product:portal",
          after: "Linear team MOD, no project",
        },
      ]);
    });

    it("saves checks in order: one entry, the repo's change, the card and the detail", async () => {
      const { status, body, changes } = await coding({
        ...baseCoding,
        codingEnabled: false,
        checks: [" pnpm build ", "pnpm test", "pnpm build"],
      });
      expect(status).toBe(200);
      const checks = ["pnpm build", "pnpm test", "pnpm build"];
      expect(body).toMatchObject({ ok: true, card: { checks } });
      expect(await getRepository(db, codingRepo)).toMatchObject({ checks });
      expect(await detailCoding()).toMatchObject({ checks });
      expect(kinds(changes)).toEqual(["repository", "settings:repository.coding"]);
      expect((await history("repository.coding", codingRepo))[0]!.changes).toEqual([
        { field: "checks", label: "Checks", before: [], after: checks },
      ]);

      // Reordering is a change; the same checks again are not.
      const reordered = ["pnpm test", "pnpm build", "pnpm build"];
      const moved = await coding({ ...baseCoding, codingEnabled: false, checks: reordered });
      expect(moved.body).toMatchObject({ card: { checks: reordered } });
      expect((await history("repository.coding", codingRepo))[0]!.changes).toEqual([
        { field: "checks", label: "Checks", before: checks, after: reordered },
      ]);
      const again = await coding({ ...baseCoding, codingEnabled: false, checks: reordered });
      expect(again).toMatchObject({ status: 200, changes: [] });

      // Removing every check clears them.
      const cleared = await coding({ ...baseCoding, codingEnabled: false });
      expect(cleared.body).toMatchObject({ card: { checks: [] } });
      expect(await getRepository(db, codingRepo)).toMatchObject({ checks: [] });
    });

    it("refuses bad checks with their field errors, saving nothing", async () => {
      const before = await getRepository(db, codingRepo);
      expect(
        await coding({ ...baseCoding, codingEnabled: false, checks: ["pnpm lint", "a\nb", ""] }),
      ).toMatchObject({
        status: 400,
        body: {
          fieldErrors: {
            "checks.1": "Commands are one line, without control characters.",
            "checks.2": "Enter a command.",
          },
        },
        changes: [],
      });
      expect(
        await coding({
          ...baseCoding,
          codingEnabled: false,
          checks: Array.from({ length: 51 }, (_, index) => `echo ${index}`),
        }),
      ).toMatchObject({ status: 400, body: { fieldErrors: { checks: "Add at most 50 checks." } } });
      const { checks: _missing, ...withoutChecks } = baseCoding;
      expect((await coding(withoutChecks)).status).toBe(400);
      expect(await getRepository(db, codingRepo)).toEqual(before);
    });

    it("labels Open a draft merge request on GitLab", async () => {
      await coding({ ...baseCoding, codingEnabled: false, openPullRequestEarly: true }, gitlabRepo);
      expect((await history("repository.coding", gitlabRepo))[0]!.changes).toEqual([
        {
          field: "openPullRequestEarly",
          label: "Open a draft merge request after the first story",
          before: "Off",
          after: "On",
        },
      ]);
    });

    it("warns about conflicting matches on save and publishes those repos' changes", async () => {
      await setMatch(docsRepo, { team: "SOC", labels: ["portal", "app"] });
      await setMatch(portalRepo, { team: "SOC", labels: ["docs"] });
      const { body, changes } = await coding({
        ...baseCoding,
        workItemMatch: { tracker: "linear", team: "soc", labels: ["App"] },
      });
      const docsWarning = {
        id: docsRepo,
        fullPath: "acme/docs",
        provider: "github",
        message: "acme/docs matches the same work items, so Om will ask which repo to use.",
      };
      expect(body.warnings).toEqual([docsWarning]);
      expect(repositoryChange(changes)!.ids.sort()).toEqual([codingRepo, docsRepo].sort());

      // Moving to a match that conflicts with the portal repo changes the docs repo's too.
      const moved = await coding({
        ...baseCoding,
        workItemMatch: { tracker: "linear", team: "SOC", labels: ["docs"] },
      });
      expect(moved.body.warnings).toEqual([
        expect.objectContaining({ id: portalRepo, fullPath: "acme/portal" }),
      ]);
      expect(repositoryChange(moved.changes)!.ids.sort()).toEqual(
        [codingRepo, docsRepo, portalRepo].sort(),
      );

      // A save that leaves the match alone still answers its conflicts, but publishes only its own.
      const policy = await coding({
        ...baseCoding,
        workItemMatch: { tracker: "linear", team: "SOC", labels: ["docs"] },
        historyRewrite: "never",
      });
      expect(policy.body.warnings).toEqual([expect.objectContaining({ id: portalRepo })]);
      expect(repositoryChange(policy.changes)!.ids).toEqual([codingRepo]);
    });

    it("checks an unsaved match's conflicts without writing or publishing", async () => {
      await setMatch(docsRepo, { team: "MOD" });
      await setMatch(portalRepo, { team: "MOD", project: "Portal" });
      const check = await matchCheck({ workItemMatch: { tracker: "linear", team: "mod" } });
      expect(check).toEqual({
        status: 200,
        body: {
          warnings: [
            {
              id: docsRepo,
              fullPath: "acme/docs",
              provider: "github",
              message: "acme/docs matches the same work items, so Om will ask which repo to use.",
            },
          ],
        },
        changes: [],
      });
      // The same check the save answers.
      const saved = await coding({
        ...baseCoding,
        workItemMatch: { tracker: "linear", team: "mod" },
      });
      expect(saved.body.warnings).toEqual(check.body.warnings);
      await coding({ ...baseCoding, codingEnabled: false, workItemMatch: null });
      const writes = await db.select().from(settingsChanges);
      expect(
        (await matchCheck({ workItemMatch: { tracker: "linear", team: "ENG" } })).changes,
      ).toEqual([]);
      expect(await db.select().from(settingsChanges)).toEqual(writes);
      expect(
        await db.select().from(workItemMatches).where(eq(workItemMatches.repositoryId, codingRepo)),
      ).toEqual([]);
      expect(await matchCheck({ workItemMatch: { tracker: "linear", team: " " } })).toMatchObject({
        status: 400,
        body: { fieldErrors: { "workItemMatch.team": "Enter the team's key, e.g. ENG." } },
      });
    });

    it("validates the match, and needs its tracker connected to change it", async () => {
      const team = await coding({ ...baseCoding, workItemMatch: { tracker: "linear", team: " " } });
      expect(team).toMatchObject({
        status: 400,
        body: { fieldErrors: { "workItemMatch.team": "Enter the team's key, e.g. ENG." } },
        changes: [],
      });
      expect(
        await coding({
          ...baseCoding,
          workItemMatch: {
            tracker: "linear",
            team: "ENG",
            project: "Portal",
            withoutProject: true,
          },
        }),
      ).toMatchObject({
        status: 400,
        body: {
          fieldErrors: { "workItemMatch.project": 'Choose a project or "no project", not both.' },
        },
      });
      expect(
        (await coding({ ...baseCoding, workItemMatch: { tracker: "jira", team: "ENG" } })).status,
      ).toBe(400);

      await coding({ ...baseCoding, workItemMatch: soc });
      await db.delete(integrations);
      const refused = await coding({
        ...baseCoding,
        workItemMatch: { tracker: "linear", team: "ENG" },
      });
      expect(refused).toEqual({
        status: 409,
        body: { error: trackerNotConnectedForMatch("Linear"), code: "tracker_not_connected" },
        changes: [],
      });
      // The saved match isn't a change: the rest of the card still saves, and it can be cleared.
      expect(
        (await coding({ ...baseCoding, workItemMatch: soc, historyRewrite: "never" })).status,
      ).toBe(200);
      expect(
        (await coding({ ...baseCoding, codingEnabled: false, workItemMatch: null })).status,
      ).toBe(200);
      expect(await db.select().from(workItemMatches)).toEqual([]);
    });

    it("rejects unknown keys and invalid values with 400, saving and publishing nothing", async () => {
      const before = await getRepository(db, codingRepo);
      for (const key of [
        "model",
        "worktreeSetupCommand",
        "maxReviewRounds",
        "storyPlaybookId",
        "roundLimits",
        "match",
      ]) {
        const { status, body, changes } = await coding({
          ...baseCoding,
          codingEnabled: false,
          [key]: "x",
        });
        expect(status, key).toBe(400);
        expect(body.error, key).toEqual(expect.stringContaining(key));
        expect(changes).toEqual([]);
      }
      expect(
        await coding({
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
      const { workItemMatch: _missing, ...partial } = baseCoding;
      expect((await coding(partial)).status).toBe(400);
      expect(await getRepository(db, codingRepo)).toEqual(before);
    });

    it("names the routing rules that target the repo", async () => {
      await setRoutingRules(
        db,
        orgId,
        [codingRepo, teamIs("ENG")],
        [docsRepo, labelsInclude("ui")],
        [codingRepo, labelsInclude("backend")],
      );
      const { body } = await coding({ ...baseCoding, workItemMatch: soc });
      expect((body.card as { routingRules: unknown }).routingRules).toEqual([
        { position: 1, description: "Team is ENG" },
        { position: 3, description: "Labels contains any of backend" },
      ]);
      expect(await detailCoding(docsRepo)).toMatchObject({
        routingRules: [{ position: 2, description: "Labels contains any of ui" }],
      });
    });
  });

  describe("GET …/coding/tracker-options", () => {
    const options = async (id = repoId) => {
      const response = await trackerOptionsRoute.GET(new Request("http://localhost/api/ui"), {
        params: Promise.resolve({ id }),
      });
      return { status: response.status, body: (await response.json()) as unknown };
    };

    beforeEach(() => {
      linear.organizations = [];
      linear.options = null;
    });

    it("answers the repo's organization's Linear teams, projects and labels", async () => {
      linear.options = {
        teams: [{ key: "SOC", name: "Social" }],
        labels: ["product:portal"],
        projects: ["Portal"],
        states: ["Todo"],
        projectMilestones: [],
        cycles: [],
        users: [],
      };
      expect(await options()).toEqual({
        status: 200,
        body: {
          status: "connected",
          teams: [{ key: "SOC", name: "Social" }],
          projects: ["Portal"],
          labels: ["product:portal"],
        },
      });
      expect(linear.organizations).toEqual([orgId]);
    });

    it("says disconnected without a workspace and unavailable when Linear fails", async () => {
      expect(await options()).toEqual({ status: 200, body: { status: "disconnected" } });
      linear.options = new Error("Linear is down");
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await options()).toEqual({ status: 200, body: { status: "unavailable" } });
    });

    it("answers 403 for members and 404 for another organization's, an unknown or a removed repo", async () => {
      const removedId = await connect(orgId, "gitlab", "acme/removed");
      await db
        .update(repositories)
        .set({ disconnectedAt: new Date() })
        .where(eq(repositories.id, removedId));
      state.user = MEMBER;
      expect((await options()).status).toBe(403);
      state.user = ADMIN;
      expect((await options(otherRepoId)).status).toBe(404);
      expect((await options(randomUUID())).status).toBe(404);
      expect((await options("not-a-uuid")).status).toBe(404);
      expect((await options(removedId)).status).toBe(404);
      expect(linear.organizations).toEqual([]);
    });
  });
});
