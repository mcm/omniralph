import { randomBytes } from "node:crypto";
import {
  captureChanges,
  closeDb,
  createDb,
  deleteChatConnection,
  deleteIntegration,
  deleteScmConnection,
  organizationMembers,
  organizations,
  saveChatConnection,
  saveIntegration,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import type { QueryKey } from "@tanstack/react-query";
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
      expect(body.connections).toEqual([
        {
          provider: "github",
          id: ids.github,
          name: "acme-corp",
          host: "github.com",
          account: "acme-corp",
        },
        {
          provider: "gitlab",
          id: ids.gitlabA,
          name: "ann @ gitlab.example.com",
          host: "gitlab.example.com",
          account: "ann-bot",
        },
        {
          provider: "gitlab",
          id: ids.gitlabZ,
          name: "zed @ gitlab.example.com",
          host: "gitlab.example.com",
          account: "zed-bot",
        },
        {
          provider: "linear",
          id: ids.linear,
          name: "Acme workspace",
          host: null,
          account: "Acme workspace",
        },
        { provider: "slack", id: ids.slack, name: "Acme Slack", host: null, account: "Acme Slack" },
        {
          provider: "discord",
          id: ids.discord,
          name: "Acme Discord",
          host: null,
          account: "Acme Discord",
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
});
