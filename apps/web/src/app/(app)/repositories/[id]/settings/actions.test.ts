import { randomBytes, randomUUID } from "node:crypto";
import {
  agentRepoPins,
  agents,
  connectRepository,
  createDb,
  getRepository,
  jobs,
  listReviewProfiles,
  runMigrations,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import {
  ReviewJobPayload,
  type RalphSettingsInput,
  type RepositorySettingsInput,
} from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  sends: [] as { topic: string; payload: unknown; options: unknown }[],
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") => assertRole(state.user, role),
}));
vi.mock("@vercel/queue", () => ({
  QueueClient: class {
    async send(topic: string, payload: unknown, options: unknown) {
      state.sends.push({ topic, payload, options });
      return { messageId: `msg-${state.sends.length}` };
    }
  },
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.QUEUE_REGIONS = "iad1";

const { updateRalphSettings, updateRepositorySettings } = await import("./actions");
const { updateReviewProfile } = await import("../../../settings/profiles/actions");
const { enqueueReview } = await import("@/lib/review/enqueue");
const { getDispatcher } = await import("@/lib/dispatch");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const SHA = (n: number) => n.toString(16).padStart(40, "0");

const baseSettings: RepositorySettingsInput = {
  profileId: "standard",
  triggers: { onOpen: true, onPush: true, drafts: false },
  pathExcludes: [],
  customInstructions: "",
  pinnedAgentIds: [],
};

const baseRalph: RalphSettingsInput = {
  ralphEnabled: false,
  linearTeamKeys: [],
  linearProjectNames: [],
  linearLabels: [],
  openPullRequestEarly: false,
  setupCommand: "",
  model: "opus",
  manualLabels: ["manual"],
};

const standardProfile = {
  model: "claude-sonnet-5-5",
  maxTokensPerReview: 200_000,
  maxFiles: 40,
  allowRepoExploration: true,
};

describe.skipIf(!dockerAvailable)("repository settings and review profiles: server actions", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let repoId: string;
  let agentA: string;
  let agentB: string;
  let revokedAgent: string;
  let prNumber = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    state.db = db;
    await db.insert(users).values([
      { id: "admin-1", email: "admin@example.com", role: "admin" },
      { id: "member-1", email: "member@example.com", role: "member" },
    ]);
    const connection = await upsertScmConnection(db, {
      provider: "gitlab",
      name: "bot",
      baseUrl: "https://gitlab.example.com",
      externalId: "5",
      credentials: { token: "glpat-bot", webhookSecret: "hook" },
    });
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
        .insert(agents)
        .values([
          { name: "coder-a" },
          { name: "coder-b" },
          { name: "coder-old", revokedAt: new Date() },
        ])
        .returning({ id: agents.id })
    ).map((a) => a.id) as [string, string, string];
  }, 180_000);

  beforeEach(async () => {
    state.user = { id: "admin-1", role: "admin", name: null, email: null, image: null };
    state.sends.length = 0;
    await db.delete(agentRepoPins);
    await db.delete(jobs);
  });

  afterAll(async () => {
    await db?.$client.end();
    await container?.stop();
  });

  async function pinnedAgentIds(): Promise<string[]> {
    const rows = await db
      .select({ agentId: agentRepoPins.agentId })
      .from(agentRepoPins)
      .where(eq(agentRepoPins.repositoryId, repoId));
    return rows.map((r) => r.agentId).sort();
  }

  async function enqueuedPayload(): Promise<ReviewJobPayload> {
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
    return ReviewJobPayload.parse(job!.payload);
  }

  it("saves the profile, triggers, excludes and instructions", async () => {
    expect(
      await updateRepositorySettings(repoId, {
        profileId: "quick",
        triggers: { onOpen: true, onPush: false, drafts: true },
        pathExcludes: ["*.snap", "/docs/**"],
        customInstructions: "  Prefer early returns.  ",
        pinnedAgentIds: [],
      }),
    ).toEqual({ ok: true });
    expect(await getRepository(db, repoId)).toMatchObject({
      profileId: "quick",
      triggers: { onOpen: true, onPush: false, drafts: true },
      pathExcludes: ["*.snap", "/docs/**"],
      customInstructions: "Prefer early returns.",
    });

    expect(await updateRepositorySettings(repoId, baseSettings)).toEqual({ ok: true });
    expect(await getRepository(db, repoId)).toMatchObject({
      profileId: "standard",
      pathExcludes: [],
      customInstructions: null,
    });
  });

  it("pinning an agent enqueues a repo.sync job for that agent; unpinning removes the pin", async () => {
    expect(
      await updateRepositorySettings(repoId, { ...baseSettings, pinnedAgentIds: [agentA] }),
    ).toEqual({ ok: true });
    expect(await pinnedAgentIds()).toEqual([agentA]);
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0]!.topic).toBe(`system-jobs-agent-${agentA}`);
    const { jobId } = state.sends[0]!.payload as { jobId: string };
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job).toMatchObject({
      capability: "system",
      type: "repo.sync",
      status: "queued",
      repositoryId: repoId,
      topic: `system-jobs-agent-${agentA}`,
    });
    expect(job!.payload).toMatchObject({ repository: { fullPath: "acme/api" } });

    // Swapping A for B syncs only to B, and keeping B pinned doesn't sync again.
    state.sends.length = 0;
    expect(
      await updateRepositorySettings(repoId, { ...baseSettings, pinnedAgentIds: [agentB] }),
    ).toEqual({ ok: true });
    expect(await pinnedAgentIds()).toEqual([agentB]);
    expect(state.sends.map((s) => s.topic)).toEqual([`system-jobs-agent-${agentB}`]);
    state.sends.length = 0;
    expect(
      await updateRepositorySettings(repoId, { ...baseSettings, pinnedAgentIds: [agentB] }),
    ).toEqual({ ok: true });
    expect(state.sends).toHaveLength(0);

    // Empty means any agent.
    expect(await updateRepositorySettings(repoId, baseSettings)).toEqual({ ok: true });
    expect(await pinnedAgentIds()).toEqual([]);
  });

  it("rejects revoked or unknown agents without saving anything", async () => {
    for (const agentId of [revokedAgent, randomUUID()]) {
      expect(
        await updateRepositorySettings(repoId, {
          ...baseSettings,
          profileId: "deep",
          pinnedAgentIds: [agentA, agentId],
        }),
      ).toMatchObject({ ok: false, fieldErrors: { pinnedAgentIds: expect.any(String) } });
    }
    expect(await pinnedAgentIds()).toEqual([]);
    expect(state.sends).toHaveLength(0);
    expect((await getRepository(db, repoId))!.profileId).toBe("standard");
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
      await updateRepositorySettings(repoId, { ...baseSettings, profileId: "deep" }),
    ).toMatchObject({ ok: false });
    expect(await updateReviewProfile("standard", standardProfile)).toMatchObject({ ok: false });
    expect((await getRepository(db, repoId))!.profileId).toBe("standard");
  });

  it("edits a profile and rejects a token cap below 5,000", async () => {
    expect(
      await updateReviewProfile("quick", {
        model: "claude-haiku-4-5",
        maxTokensPerReview: 4999,
        maxFiles: 15,
        allowRepoExploration: false,
      }),
    ).toEqual({
      ok: false,
      error: "Fix the highlighted fields.",
      fieldErrors: { maxTokensPerReview: "The token cap must be at least 5,000." },
    });
    expect(await updateReviewProfile("turbo", standardProfile)).toMatchObject({
      ok: false,
      error: "That profile doesn't exist.",
    });
    expect(
      await updateReviewProfile("quick", {
        model: "claude-haiku-4-5",
        maxTokensPerReview: 5000,
        maxFiles: 10,
        allowRepoExploration: true,
      }),
    ).toEqual({ ok: true });
    const quick = (await listReviewProfiles(db)).find((p) => p.id === "quick");
    expect(quick).toMatchObject({
      maxTokensPerReview: 5000,
      maxFiles: 10,
      allowRepoExploration: true,
      builtIn: true,
    });
    expect((await listReviewProfiles(db)).map((p) => p.id).sort()).toEqual([
      "deep",
      "quick",
      "standard",
    ]);
  });

  it("applies changes to the next enqueued review job", async () => {
    const before = await enqueuedPayload();
    expect(before.reviewConfig).toMatchObject({
      profile: { id: "standard" },
      pathExcludes: [],
      customInstructions: null,
    });

    expect(
      await updateReviewProfile("deep", {
        model: "claude-opus-5-5",
        maxTokensPerReview: 123_000,
        maxFiles: 7,
        allowRepoExploration: false,
      }),
    ).toEqual({ ok: true });
    expect(
      await updateRepositorySettings(repoId, {
        ...baseSettings,
        profileId: "deep",
        pathExcludes: ["*.snap"],
        customInstructions: "Check error handling.",
      }),
    ).toEqual({ ok: true });

    const after = await enqueuedPayload();
    expect(after.reviewConfig).toMatchObject({
      profile: {
        id: "deep",
        model: "claude-opus-5-5",
        maxTokensPerReview: 123_000,
        maxFiles: 7,
        allowRepoExploration: false,
      },
      pathExcludes: ["*.snap"],
      customInstructions: "Check error handling.",
    });
    // The earlier job keeps the config it was created with.
    expect(before.reviewConfig.profile.id).toBe("standard");
    await updateRepositorySettings(repoId, baseSettings);
  });

  it("saves the Ralph section: enabled, Linear routing, openPullRequestEarly, setup command, model and manual labels", async () => {
    expect(await getRepository(db, repoId)).toMatchObject({
      ralphEnabled: false,
      linearTeamKeys: [],
      ralphSettings: {
        openPullRequestEarly: false,
        setupCommand: null,
        model: "opus",
        manualLabels: ["manual"],
      },
    });
    expect(
      await updateRalphSettings(repoId, {
        ralphEnabled: true,
        linearTeamKeys: ["tool", "ENG"],
        linearProjectNames: ["Omniralph"],
        linearLabels: ["backend", "api"],
        openPullRequestEarly: true,
        setupCommand: "  pnpm install --frozen-lockfile  ",
        model: "claude-opus-5-5",
        manualLabels: ["by hand", "manual"],
      }),
    ).toEqual({ ok: true });
    expect(await getRepository(db, repoId)).toMatchObject({
      ralphEnabled: true,
      linearTeamKeys: ["TOOL", "ENG"],
      linearProjectNames: ["Omniralph"],
      linearLabels: ["backend", "api"],
      ralphSettings: {
        openPullRequestEarly: true,
        setupCommand: "pnpm install --frozen-lockfile",
        model: "claude-opus-5-5",
        manualLabels: ["by hand", "manual"],
      },
    });
    // Saving the review settings leaves the Ralph section alone, and the other way round.
    expect(await updateRepositorySettings(repoId, baseSettings)).toEqual({ ok: true });
    expect((await getRepository(db, repoId))!.ralphEnabled).toBe(true);

    expect(await updateRalphSettings(repoId, baseRalph)).toEqual({ ok: true });
    expect(await getRepository(db, repoId)).toMatchObject({
      ralphEnabled: false,
      linearTeamKeys: [],
      linearProjectNames: [],
      linearLabels: [],
      ralphSettings: {
        openPullRequestEarly: false,
        setupCommand: null,
        model: "opus",
        manualLabels: ["manual"],
      },
      profileId: "standard",
    });
  });

  it("rejects invalid Ralph settings with field errors without saving", async () => {
    expect(
      await updateRalphSettings(repoId, {
        ...baseRalph,
        ralphEnabled: true,
        linearTeamKeys: ["E N G"],
        linearLabels: ["a,b"],
        model: "",
        manualLabels: [],
      }),
    ).toEqual({
      ok: false,
      error: "Fix the highlighted fields.",
      fieldErrors: {
        "linearTeamKeys.0": "Team keys are letters and digits, e.g. ENG.",
        "linearLabels.0": "Names can't contain commas or control characters.",
        model: "Enter a model.",
        manualLabels: "Enter at least one manual label.",
      },
    });
    // Not a valid input shape at all.
    expect(
      await updateRalphSettings(repoId, {
        ...baseRalph,
        ralphEnabled: "yes",
      } as unknown as RalphSettingsInput),
    ).toMatchObject({ ok: false, fieldErrors: { ralphEnabled: expect.any(String) } });
    expect((await getRepository(db, repoId))!.ralphEnabled).toBe(false);
  });

  it("rejects Ralph settings for unknown repositories and from non-admins", async () => {
    expect(await updateRalphSettings(randomUUID(), baseRalph)).toEqual({
      ok: false,
      error: "That repository isn't connected.",
    });
    state.user = { id: "member-1", role: "member", name: null, email: null, image: null };
    expect(await updateRalphSettings(repoId, { ...baseRalph, ralphEnabled: true })).toMatchObject({
      ok: false,
    });
    expect((await getRepository(db, repoId))!.ralphEnabled).toBe(false);
  });
});
