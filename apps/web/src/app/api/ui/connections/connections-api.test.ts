import { randomBytes } from "node:crypto";
import {
  captureChanges,
  closeDb,
  createDb,
  deleteChatConnection,
  deleteIntegration,
  deleteScmConnection,
  organizationMembers,
  chatIdentities,
  organizations,
  recordWebhookEvent,
  repositories,
  saveChatConnection,
  setScmConnectionHealth,
  saveIntegration,
  upsertScmConnection,
  users,
  webhookEvents,
  workItemMatches,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import type { QueryKey } from "@tanstack/react-query";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  connectionListSchema,
  type ConnectionList,
  type ConnectionProvider,
} from "@/lib/api/connections";
import { connectionKeys, queryKeys } from "@/lib/api/keys";
import { assertRole, type Role } from "@/lib/auth/roles";
import { liveInvalidations } from "@/lib/live/invalidations";

vi.mock("server-only", () => ({}));

type TestUser = { id: string; role: Role; name: string | null; email: string | null; image: null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  orgId: "",
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const route = await import("./route");
const { changeMessage } = await import("@/lib/live/publisher");

const member: TestUser = { id: "member-1", role: "member", name: "Mia", email: null, image: null };

/** Every secret the fixtures store: none may appear in a response. */
const SECRETS = ["glpat-secret-token", "gitlab-webhook-secret", "lin-secret", "xoxb-secret"];

async function getList() {
  const response = await route.GET(new Request("http://localhost/api/ui/connections"), {
    params: Promise.resolve({}),
  });
  return { status: response.status, body: (await response.json()) as ConnectionList };
}

/** Whether invalidating `prefix` refetches the query `key` (TanStack's partial match). */
function isPrefix(prefix: QueryKey, key: QueryKey): boolean {
  return prefix.every((part, index) => JSON.stringify(part) === JSON.stringify(key[index]));
}

/** Every key of every object in `value`, recursively. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
  }
  return [];
}

describe.skipIf(!testDatabaseAvailable())("GET /api/ui/connections", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: string;
  let beta: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [acmeOrg, betaOrg] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Beta" }])
      .returning();
    acme = acmeOrg!.id;
    beta = betaOrg!.id;
    state.orgId = acme;
    state.user = member;
    await db.insert(users).values({ id: member.id, name: member.name, email: "mia@acme.io" });
    await db.insert(organizationMembers).values([
      { organizationId: acme, userId: member.id, role: "member" },
      { organizationId: beta, userId: member.id, role: "admin" },
    ]);
  }, 120_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  /** Connects one connection of `provider` to `organizationId`; answers its ID. */
  async function connect(
    provider: ConnectionProvider,
    organizationId: string,
    name: string,
  ): Promise<string> {
    switch (provider) {
      case "github":
        return (await upsertScmConnection(db, {
          organizationId,
          provider: "github",
          name,
          baseUrl: "https://api.github.com",
          externalId: `${name}-installation`,
          credentials: {},
        }))!.id;
      case "gitlab":
        return (await upsertScmConnection(db, {
          organizationId,
          provider: "gitlab",
          name: `${name} @ gitlab.example.com`,
          baseUrl: "https://gitlab.example.com",
          externalId: `${name}-user`,
          credentials: { token: SECRETS[0], webhookSecret: SECRETS[1] },
          botUsername: `${name}-bot`,
        }))!.id;
      case "linear": {
        const saved = await saveIntegration(db, {
          organizationId,
          provider: "linear",
          externalId: `${name}-workspace`,
          name,
          credentials: { accessToken: SECRETS[2] },
          installedByUserId: null,
        });
        if (saved === "other_organization") throw new Error("setup");
        return saved.id;
      }
      case "slack":
      case "discord": {
        const saved = await saveChatConnection(db, {
          organizationId,
          platform: provider,
          externalId: `${name}-team`,
          name,
          credentials: provider === "slack" ? { botToken: SECRETS[3] } : null,
          installedByUserId: null,
        });
        if (saved === "other_organization") throw new Error("setup");
        return saved.id;
      }
    }
  }

  /** Disconnects the connection `id` of `provider` from `organizationId`. */
  async function disconnect(provider: ConnectionProvider, organizationId: string, id: string) {
    if (provider === "github" || provider === "gitlab") {
      await deleteScmConnection(db, organizationId, id);
    } else if (provider === "linear") {
      await deleteIntegration(db, organizationId, "linear");
    } else {
      await deleteChatConnection(db, organizationId, id);
    }
  }

  it("lists the active organization's connections to members, by provider, without secrets", async () => {
    const ids = {
      github: await connect("github", acme, "acme-corp"),
      gitlabZ: await connect("gitlab", acme, "zed"),
      gitlabA: await connect("gitlab", acme, "ann"),
      linear: await connect("linear", acme, "Acme workspace"),
      slack: await connect("slack", acme, "Acme Slack"),
      discord: await connect("discord", acme, "Acme Discord"),
    };
    // Beta's (the member is an admin there, but Settings acts on the active organization).
    const betaGitHub = await connect("github", beta, "beta-corp");
    const betaSlack = await connect("slack", beta, "Beta Slack");
    try {
      const { status, body } = await getList();
      expect(status).toBe(200);
      expect(connectionListSchema.parse(body)).toEqual(body);
      const unused = { failedDeliveries: 0, linkedAccounts: null };
      const connected = { state: "connected", problems: [] };
      expect(body.connections).toEqual([
        {
          provider: "github",
          id: ids.github,
          name: "acme-corp",
          host: "github.com",
          account: "acme-corp",
          health: connected,
          reposUsing: 0,
          usedAs: "code_host",
          ...unused,
        },
        {
          provider: "gitlab",
          id: ids.gitlabA,
          name: "ann @ gitlab.example.com",
          host: "gitlab.example.com",
          account: "ann-bot",
          health: { state: "not_checked", problems: [] },
          reposUsing: 0,
          usedAs: "code_host",
          ...unused,
        },
        {
          provider: "gitlab",
          id: ids.gitlabZ,
          name: "zed @ gitlab.example.com",
          host: "gitlab.example.com",
          account: "zed-bot",
          health: { state: "not_checked", problems: [] },
          reposUsing: 0,
          usedAs: "code_host",
          ...unused,
        },
        {
          provider: "linear",
          id: ids.linear,
          name: "Acme workspace",
          host: null,
          account: "Acme workspace",
          health: connected,
          reposUsing: 0,
          usedAs: "tracker",
          ...unused,
        },
        {
          provider: "slack",
          id: ids.slack,
          name: "Acme Slack",
          host: null,
          account: "Acme Slack",
          health: connected,
          reposUsing: null,
          usedAs: "chat",
          failedDeliveries: 0,
          linkedAccounts: 0,
        },
        {
          provider: "discord",
          id: ids.discord,
          name: "Acme Discord",
          host: null,
          account: "Acme Discord",
          health: connected,
          reposUsing: null,
          usedAs: "chat",
          failedDeliveries: 0,
          linkedAccounts: 0,
        },
      ]);
      const text = JSON.stringify(body);
      for (const id of [betaGitHub, betaSlack]) expect(text).not.toContain(id);
      // No credential field, and no stored secret anywhere in the response.
      for (const key of keysOf(body)) {
        expect(key).not.toMatch(/token|secret|credential|password|key/i);
      }
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    } finally {
      for (const [provider, id] of [
        ["github", ids.github],
        ["gitlab", ids.gitlabA],
        ["gitlab", ids.gitlabZ],
        ["linear", ids.linear],
        ["slack", ids.slack],
        ["discord", ids.discord],
      ] as const) {
        await disconnect(provider, acme, id);
      }
      await disconnect("github", beta, betaGitHub);
      await disconnect("slack", beta, betaSlack);
    }
  });

  it("answers an empty list for an organization without connections", async () => {
    expect(await getList()).toEqual({ status: 200, body: { connections: [] } });
  });

  it.each(["github", "gitlab", "linear", "slack", "discord"] as const)(
    "publishes a connection event that refreshes Settings' connections when %s connects and disconnects",
    async (provider) => {
      const settingsList: QueryKey = connectionKeys(queryKeys(acme)).list;
      /** Whether the writes in `fn` publish a `connection` event that invalidates the list. */
      const reachesTheList = async (fn: () => Promise<unknown>) => {
        const { changes } = await captureChanges(fn);
        const events = changes.map((change) => changeMessage(change).event);
        expect(events.map((event) => event.resource)).toEqual(["connection"]);
        return events.some((event) =>
          liveInvalidations(event).some((prefix) => isPrefix(prefix, settingsList)),
        );
      };
      let id = "";
      expect(
        await reachesTheList(async () => {
          id = await connect(provider, acme, `live-${provider}`);
        }),
      ).toBe(true);
      expect((await getList()).body.connections.map((row) => row.id)).toEqual([id]);
      expect(await reachesTheList(() => disconnect(provider, acme, id))).toBe(true);
      expect((await getList()).body.connections).toEqual([]);
    },
  );
  it("shows each connection's health, the repos using it, unreplayed failed deliveries and linked accounts", async () => {
    const ids = {
      github: await connect("github", acme, "acme-corp"),
      healthy: await connect("gitlab", acme, "healthy"),
      expiring: await connect("gitlab", acme, "expiring"),
      attention: await connect("gitlab", acme, "attention"),
      unchecked: await connect("gitlab", acme, "unchecked"),
      linear: await connect("linear", acme, "Acme workspace"),
      slack: await connect("slack", acme, "Acme Slack"),
      discord: await connect("discord", acme, "Acme Discord"),
    };
    const betaGitHub = await connect("github", beta, "beta-corp");
    const betaSlack = await connect("slack", beta, "Beta Slack");
    const day = 24 * 60 * 60 * 1000;
    const checkedAt = new Date().toISOString();
    const inDays = (days: number) => new Date(Date.now() + days * day).toISOString().slice(0, 10);
    try {
      await setScmConnectionHealth(db, ids.healthy, {
        checkedAt,
        tokenExpiresAt: inDays(60),
        problems: [],
      });
      await setScmConnectionHealth(db, ids.expiring, {
        checkedAt,
        tokenExpiresAt: inDays(5),
        problems: [],
      });

      // Repos: two connected and one disconnected on GitHub, one on the healthy GitLab.
      const repo = (connectionId: string, fullPath: string, disconnected = false) =>
        db
          .insert(repositories)
          .values({
            organizationId: acme,
            provider: connectionId === ids.github ? "github" : "gitlab",
            connectionId,
            externalId: fullPath,
            fullPath,
            disconnectedAt: disconnected ? new Date() : null,
          })
          .returning()
          .then(([row]) => row!.id);
      const web = await repo(ids.github, "acme/web");
      await repo(ids.github, "acme/api");
      const gone = await repo(ids.github, "acme/gone", true);
      await repo(ids.healthy, "acme/infra");
      await setScmConnectionHealth(db, ids.attention, {
        checkedAt,
        tokenExpiresAt: inDays(60),
        problems: [{ code: "webhook_missing", message: "The webhook is gone.", repositoryId: web }],
      });
      // Linear: a work item match on a connected repo counts; one on a disconnected repo doesn't.
      await db.insert(workItemMatches).values([
        { organizationId: acme, repositoryId: web, tracker: "linear", team: "ENG" },
        { organizationId: acme, repositoryId: gone, tracker: "linear", team: "ENG" },
      ]);

      // Deliveries: on GitHub a failed one, one replayed successfully, one whose replay failed
      // again (the replay counts, the original doesn't), an old failure past the retention and
      // an ignored one; on Linear one failure; on Beta's GitHub one failure.
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
      const onGitHub = { scmConnectionId: ids.github };
      await delivery(acme, onGitHub, "failed");
      await delivery(acme, onGitHub, "started_run", await delivery(acme, onGitHub, "failed"));
      await delivery(acme, onGitHub, "failed", await delivery(acme, onGitHub, "failed"));
      await delivery(acme, onGitHub, "ignored");
      const old = await delivery(acme, onGitHub, "failed");
      await db
        .update(webhookEvents)
        .set({ receivedAt: new Date(Date.now() - 15 * day) })
        .where(eq(webhookEvents.id, old));
      await delivery(acme, { integrationId: ids.linear }, "failed");
      await delivery(beta, { scmConnectionId: betaGitHub }, "failed");

      // Linked chat accounts: two on Slack and one on Discord in Acme, one on Beta's Slack.
      await db.insert(chatIdentities).values([
        {
          organizationId: acme,
          platform: "slack",
          externalUserId: "U1",
          userId: member.id,
          source: "manual",
        },
        {
          organizationId: acme,
          platform: "slack",
          externalUserId: "U2",
          userId: member.id,
          source: "email",
        },
        {
          organizationId: acme,
          platform: "discord",
          externalUserId: "D1",
          userId: member.id,
          source: "manual",
        },
        {
          organizationId: beta,
          platform: "slack",
          externalUserId: "U9",
          userId: member.id,
          source: "manual",
        },
      ]);

      const { body } = await getList();
      expect(connectionListSchema.parse(body)).toEqual(body);
      const byId = new Map(body.connections.map((row) => [row.id, row]));
      const pick = (id: string) => {
        const row = byId.get(id)!;
        return {
          state: row.health.state,
          reposUsing: row.reposUsing,
          usedAs: row.usedAs,
          failedDeliveries: row.failedDeliveries,
          linkedAccounts: row.linkedAccounts,
        };
      };
      expect(pick(ids.github)).toEqual({
        state: "connected",
        reposUsing: 2,
        usedAs: "code_host",
        failedDeliveries: 2,
        linkedAccounts: null,
      });
      expect(pick(ids.healthy)).toMatchObject({ state: "healthy", reposUsing: 1 });
      expect(byId.get(ids.expiring)!.health).toEqual({
        state: "expiring",
        expiresAt: inDays(5),
        problems: [],
      });
      expect(byId.get(ids.attention)!.health).toEqual({
        state: "needs_attention",
        expiresAt: inDays(60),
        problems: [
          { code: "webhook_missing", sentence: "The webhook is gone.", repositoryId: web },
        ],
      });
      expect(pick(ids.unchecked)).toMatchObject({ state: "not_checked", reposUsing: 0 });
      expect(pick(ids.linear)).toEqual({
        state: "connected",
        reposUsing: 1,
        usedAs: "tracker",
        failedDeliveries: 1,
        linkedAccounts: null,
      });
      expect(pick(ids.slack)).toEqual({
        state: "connected",
        reposUsing: null,
        usedAs: "chat",
        failedDeliveries: 0,
        linkedAccounts: 2,
      });
      expect(pick(ids.discord)).toMatchObject({ usedAs: "chat", linkedAccounts: 1 });
    } finally {
      await db.delete(chatIdentities);
      await db.delete(webhookEvents);
      for (const [provider, id] of [
        ["github", ids.github],
        ["gitlab", ids.healthy],
        ["gitlab", ids.expiring],
        ["gitlab", ids.attention],
        ["gitlab", ids.unchecked],
        ["linear", ids.linear],
        ["slack", ids.slack],
        ["discord", ids.discord],
      ] as const) {
        await disconnect(provider, acme, id);
      }
      await disconnect("github", beta, betaGitHub);
      await disconnect("slack", beta, betaSlack);
    }
  });

  it("refreshes Settings' connections when a delivery is recorded or replayed", async () => {
    const id = await connect("github", acme, "live-deliveries");
    try {
      const settingsList: QueryKey = connectionKeys(queryKeys(acme)).list;
      const { changes } = await captureChanges(() =>
        recordWebhookEvent(db, {
          organizationId: acme,
          provider: "github",
          source: { scmConnectionId: id },
          event: "pull_request.opened",
          rawBody: "{}",
          outcome: "failed",
        }),
      );
      const events = changes.map((change) => changeMessage(change).event);
      expect(events.map((event) => event.resource)).toEqual(["webhook_event"]);
      expect(liveInvalidations(events[0]!).some((prefix) => isPrefix(prefix, settingsList))).toBe(
        true,
      );
      expect((await getList()).body.connections[0]!.failedDeliveries).toBe(1);
    } finally {
      await db.delete(webhookEvents);
      await disconnect("github", acme, id);
    }
  });
});
