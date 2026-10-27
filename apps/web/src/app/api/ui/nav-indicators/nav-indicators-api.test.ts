// `GET /api/ui/nav-indicators`: the Fleet dot's agents (offline or failing to update, by
// organization scope) and the Settings dots' failed deliveries not yet replayed (the active
// organization's, per connection), in a fixed number of queries.
import { randomBytes } from "node:crypto";
import {
  agents,
  closeDb,
  createDb,
  createOrganization,
  organizationMembers,
  recordWebhookEvent,
  saveIntegration,
  setActiveOrganization,
  setDesiredAgentVersion,
  TRACK_LATEST_AGENT_VERSION,
  upsertScmConnection,
  users,
  webhookEvents,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { navIndicatorsSchema, type NavIndicators } from "@/lib/api/nav-indicators";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
// The signed-in user with their real role in their active organization.
vi.mock("@/lib/auth/session", async () => {
  const { getActiveOrganization } = await import("@omniralph/db");
  const current = async (role: Role) => {
    const active = state.userId ? await getActiveOrganization(state.db, state.userId) : null;
    return assertRole(
      state.userId === null
        ? null
        : {
            id: state.userId,
            organization: active ? { id: active.id, name: active.name } : null,
            role: active?.role ?? null,
            name: null,
            email: null,
            image: null,
            theme: null,
            showAdvanced: false,
          },
      role,
    );
  };
  return { requireUser: async (role: Role = "member") => current(role) };
});
vi.mock("@/lib/agents/npm", () => ({
  NpmRegistryError: class extends Error {},
  latestAgentVersion: async () => "2.1.0",
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const route = await import("./route");

async function indicators(organization?: string) {
  const query = organization ? `?organization=${organization}` : "";
  const response = await route.GET(new Request(`http://localhost/api/ui/nav-indicators${query}`), {
    params: Promise.resolve({}),
  });
  const body = (await response.json()) as NavIndicators;
  if (response.ok) navIndicatorsSchema.parse(body);
  return { status: response.status, body };
}

const DAY = 24 * 3600_000;

describe.skipIf(!testDatabaseAvailable())("GET /api/ui/nav-indicators", () => {
  let testDb: TestDatabase;
  let db: Database;
  let alpha: string;
  let beta: string;
  let alphaGitHub: string;
  let alphaGitLab: string;
  let alphaLinear: string;
  let betaGitHub: string;
  const ago = (ms: number) => new Date(Date.now() - ms);

  async function agent(
    organizationId: string,
    name: string,
    values: Partial<typeof agents.$inferInsert>,
  ) {
    const [row] = await db
      .insert(agents)
      .values({ organizationId, name, ...values })
      .returning();
    return row!.id;
  }

  const delivery = (
    organizationId: string,
    source: { scmConnectionId: string } | { integrationId: string },
    outcome: "failed" | "started_run" | "ignored",
    replayOfId: string | null = null,
  ) =>
    recordWebhookEvent(db, {
      organizationId,
      provider: "scmConnectionId" in source ? "github" : "linear",
      source,
      event: "pull_request.opened",
      rawBody: "{}",
      outcome,
      replayOfId,
    });

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    await db.insert(users).values([
      { id: "alpha-member", email: "member@alpha.io" },
      { id: "alpha-admin", email: "admin@alpha.io" },
      { id: "beta-admin", email: "admin@beta.io" },
      { id: "both", email: "both@alpha.io" },
    ]);
    alpha = (await createOrganization(db, { name: "Alpha", createdBy: "alpha-admin" })).id;
    beta = (await createOrganization(db, { name: "Beta", createdBy: "beta-admin" })).id;
    await db.insert(organizationMembers).values([
      { organizationId: alpha, userId: "alpha-member", role: "member" },
      { organizationId: alpha, userId: "both", role: "member" },
      { organizationId: beta, userId: "both", role: "member" },
    ]);
    await setActiveOrganization(db, { userId: "alpha-member", organizationId: alpha });
    await setActiveOrganization(db, { userId: "both", organizationId: alpha });
    await setActiveOrganization(db, { userId: "beta-admin", organizationId: beta });
    await setDesiredAgentVersion(db, alpha, "2.0.3", null);
    await setDesiredAgentVersion(db, beta, TRACK_LATEST_AGENT_VERSION, null);

    // Alpha: offline (3: one gone quiet, one never connected, one also failing its update)
    // and one online agent whose update failed; the rest don't count.
    const online = {
      liveOnline: true,
      lastHeartbeatAt: ago(10_000),
      selfUpdate: "supported" as const,
    };
    await agent(alpha, "online", { ...online, reportedVersion: "2.0.3" });
    // Its last heartbeat is old, but the server still has it live online: it counts as online.
    await agent(alpha, "online-old-heartbeat", {
      ...online,
      lastHeartbeatAt: ago(3 * DAY),
      reportedVersion: "2.0.3",
    });
    await agent(alpha, "offline", {
      liveOnline: false,
      lastHeartbeatAt: ago(DAY),
      reportedVersion: "2.0.3",
    });
    await agent(alpha, "never", {});
    await agent(alpha, "offline-failed", {
      liveOnline: false,
      lastHeartbeatAt: ago(DAY),
      reportedVersion: "2.0.2",
      failedVersions: ["2.0.3"],
    });
    await agent(alpha, "failed", {
      ...online,
      reportedVersion: "2.0.2",
      failedVersions: ["2.0.3"],
    });
    await agent(alpha, "revoked-offline", {
      liveOnline: false,
      lastHeartbeatAt: ago(DAY),
      revokedAt: ago(DAY),
    });
    await agent(alpha, "revoked-failed", {
      ...online,
      revokedAt: ago(DAY),
      reportedVersion: "2.0.2",
      failedVersions: ["2.0.3"],
    });
    await agent(alpha, "deleted", { liveOnline: false, revokedAt: ago(DAY), deletedAt: ago(DAY) });
    // Beta tracks latest (2.1.0): one offline, one whose update to it failed.
    await agent(beta, "beta-offline", { liveOnline: false, lastHeartbeatAt: ago(DAY) });
    await agent(beta, "beta-failed", {
      ...online,
      reportedVersion: "2.0.9",
      failedVersions: ["2.1.0"],
    });
    await agent(beta, "beta-online", { ...online, reportedVersion: "2.1.0" });

    const scm = async (organizationId: string, provider: "github" | "gitlab", name: string) =>
      (await upsertScmConnection(db, {
        organizationId,
        provider,
        name,
        baseUrl: provider === "github" ? "https://api.github.com" : "https://gitlab.example.com",
        externalId: `${name}-id`,
        credentials: {},
      }))!.id;
    alphaGitHub = await scm(alpha, "github", "alpha-gh");
    alphaGitLab = await scm(alpha, "gitlab", "alpha-gl");
    betaGitHub = await scm(beta, "github", "beta-gh");
    const linear = await saveIntegration(db, {
      organizationId: alpha,
      provider: "linear",
      externalId: "alpha-workspace",
      name: "Alpha",
      credentials: { accessToken: "lin" },
      installedByUserId: null,
    });
    if (linear === "other_organization") throw new Error("setup");
    alphaLinear = linear.id;

    // Alpha's GitHub: two failures, one replayed successfully (doesn't count), one whose
    // replay failed again (the replay counts, the original doesn't), one past the 14-day
    // retention and an ignored one: 3 count. Linear: 1. GitLab: none. Beta's GitHub: 2.
    const onGitHub = { scmConnectionId: alphaGitHub };
    await delivery(alpha, onGitHub, "failed");
    await delivery(alpha, onGitHub, "failed");
    await delivery(alpha, onGitHub, "started_run", await delivery(alpha, onGitHub, "failed"));
    await delivery(alpha, onGitHub, "failed", await delivery(alpha, onGitHub, "failed"));
    await delivery(alpha, onGitHub, "ignored");
    await delivery(alpha, { scmConnectionId: alphaGitLab }, "started_run");
    const old = await delivery(alpha, onGitHub, "failed");
    await db
      .update(webhookEvents)
      .set({ receivedAt: ago(15 * DAY) })
      .where(eq(webhookEvents.id, old));
    await delivery(alpha, { integrationId: alphaLinear }, "failed");
    await delivery(beta, { scmConnectionId: betaGitHub }, "failed");
    await delivery(beta, { scmConnectionId: betaGitHub }, "failed");
  }, 120_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  const alphaSettings = () => ({
    failedDeliveries: 4,
    byConnection: [
      { id: alphaGitHub, failed: 3 },
      { id: alphaLinear, failed: 1 },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  });

  it("counts the active organization's offline and update-failed agents and unreplayed failures", async () => {
    state.userId = "alpha-member";
    for (const organization of [undefined, alpha]) {
      const { status, body } = await indicators(organization);
      expect(status).toBe(200);
      expect(body).toEqual({ fleet: { offline: 3, updateFailed: 1 }, settings: alphaSettings() });
    }
  });

  it("counts every organization's agents under All organizations, and the active organization's deliveries", async () => {
    state.userId = "both";
    const all = await indicators("all");
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ fleet: { offline: 4, updateFailed: 2 }, settings: alphaSettings() });
    // One of the user's other organizations by ID: its agents, still the active one's deliveries.
    const other = await indicators(beta);
    expect(other.body).toEqual({
      fleet: { offline: 1, updateFailed: 1 },
      settings: alphaSettings(),
    });
  });

  it("answers 404 for an organization the user isn't a member of, and 401 signed out", async () => {
    state.userId = "alpha-member";
    expect((await indicators(beta)).status).toBe(404);
    expect((await indicators("not-an-id")).status).toBe(400);
    state.userId = null;
    expect((await indicators()).status).toBe(401);
  });

  it("drops a failure once it is replayed successfully", async () => {
    state.userId = "beta-admin";
    expect((await indicators()).body.settings).toEqual({
      failedDeliveries: 2,
      byConnection: [{ id: betaGitHub, failed: 2 }],
    });
    const [first] = await db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(eq(webhookEvents.scmConnectionId, betaGitHub));
    await delivery(beta, { scmConnectionId: betaGitHub }, "started_run", first!.id);
    expect((await indicators()).body.settings).toEqual({
      failedDeliveries: 1,
      byConnection: [{ id: betaGitHub, failed: 1 }],
    });
  });

  it("uses a fixed number of queries whatever the number of agents and deliveries", async () => {
    state.userId = "both";
    const count = async () => {
      let queries = 0;
      const real = db;
      state.db = new Proxy(real, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === "execute" || prop === "select") {
            return (...args: unknown[]) => {
              queries += 1;
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return value;
        },
      });
      try {
        await indicators("all");
      } finally {
        state.db = real;
      }
      return queries;
    };
    const before = await count();
    expect(before).toBeGreaterThan(0);
    for (let i = 0; i < 15; i++) {
      await agent(alpha, `more-${i}`, { liveOnline: i % 2 === 0, lastHeartbeatAt: ago(DAY) });
      await delivery(alpha, { scmConnectionId: alphaGitLab }, "failed");
    }
    expect(await count()).toBe(before);
    const { body } = await indicators("all");
    expect(body.fleet.offline).toBe(4 + 7);
    expect(body.settings.byConnection).toContainEqual({ id: alphaGitLab, failed: 15 });
  });
});
