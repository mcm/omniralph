// The chat playbook endpoints against a real database: the organization's choice
// (`PUT /api/ui/integrations/chat-tasks`) and a channel's overrides
// (`PUT`/`DELETE /api/ui/integrations/chat-connections/[id]/channels`) are admin-only,
// check each playbook's role, and publish their change events.
import { randomBytes } from "node:crypto";
import {
  closeDb,
  createDb,
  DEFAULT_CHAT_PLAYBOOKS,
  getChatChannelPlaybookSetting,
  getChatPlaybookDefaults,
  insertPlaybook,
  organizationMembers,
  organizations,
  saveChatConnection,
  setChatPlaybookDefaults,
  users,
  type Database,
} from "@omniralph/db";
import { captureChanges } from "@omniralph/db/changes";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { getBuiltinPlaybook, playbookRequirements } from "@omniralph/tasks";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callAction } from "@/lib/api/test-call";
import { assertRole, type Role } from "@/lib/auth/roles";

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

const chatPlaybooks = await import("./chat-tasks/route");
const channels = await import("./chat-connections/[id]/channels/route");

const databaseAvailable = testDatabaseAvailable();

const user = (id: string, role: Role): TestUser => ({
  id,
  role,
  name: id,
  email: null,
  image: null,
});
const member = user("member-1", "member");
const admin = user("admin-1", "admin");

describe.skipIf(!databaseAvailable)("chat playbook endpoints", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: string;
  let other: string;
  let slack: string;
  /** Acme's own chat-ask playbook, and another organization's. */
  let ownAsk: string;
  let foreignAsk: string;

  async function storeAsk(organizationId: string, name: string): Promise<string> {
    const builtin = getBuiltinPlaybook("builtin:ask-about-code")!;
    const { id: _id, name: _name, role, ...definition } = builtin;
    const stored = await insertPlaybook(db, organizationId, {
      name,
      role,
      definition,
      requirements: playbookRequirements(builtin),
      createdBy: null,
    });
    return stored.id;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [acmeOrg, otherOrg] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    acme = acmeOrg!.id;
    other = otherOrg!.id;
    await db
      .insert(users)
      .values([member, admin].map((u) => ({ id: u.id, name: u.name, email: `${u.id}@x.io` })));
    await db.insert(organizationMembers).values([
      { organizationId: acme, userId: member.id, role: "member" },
      { organizationId: acme, userId: admin.id, role: "admin" },
    ]);
    const connection = await saveChatConnection(db, {
      organizationId: acme,
      platform: "slack",
      externalId: "T-CHAT-PLAYBOOKS",
      name: "Acme Slack",
      credentials: { botToken: "xoxb-1" },
      installedByUserId: null,
    });
    if (connection === "other_organization") throw new Error("setup");
    slack = connection.id;
    ownAsk = await storeAsk(acme, "Security Q&A");
    foreignAsk = await storeAsk(other, "Their Q&A");
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    state.user = admin;
    state.orgId = acme;
    await setChatPlaybookDefaults(db, acme, null, null);
  });

  const saveDefaults = (body: unknown) => callAction(chatPlaybooks.PUT, "PUT", {}, body);
  const saveChannel = (body: unknown) => callAction(channels.PUT, "PUT", { id: slack }, body);
  const removeChannel = (channelId: string) =>
    callAction(channels.DELETE, "DELETE", { id: slack }, { channelId });

  describe("PUT /api/ui/integrations/chat-tasks", () => {
    it("saves the organization's chat playbooks and publishes the connection settings change", async () => {
      const { result, changes } = await captureChanges(() =>
        saveDefaults({ ask: ownAsk, startWork: "builtin:handle-request" }),
      );
      expect(result).toEqual({ ok: true });
      expect(await getChatPlaybookDefaults(db, acme)).toEqual({
        ask: ownAsk,
        startWork: "builtin:handle-request",
      });
      expect(changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resource: "settings",
            section: "connection",
            ids: [acme],
            organizationId: acme,
          }),
        ]),
      );
      expect(changes.every((change) => change.organizationId === acme)).toBe(true);
    });

    it("refuses members, and publishes nothing", async () => {
      state.user = member;
      const { result, changes } = await captureChanges(() =>
        saveDefaults({ ask: ownAsk, startWork: "builtin:handle-request" }),
      );
      expect(result).toMatchObject({ ok: false });
      expect(changes).toEqual([]);
      expect(await getChatPlaybookDefaults(db, acme)).toEqual(DEFAULT_CHAT_PLAYBOOKS);
    });

    it("refuses a playbook of another role or another organization's, and publishes nothing", async () => {
      for (const [body, field, error] of [
        [
          { ask: "builtin:handle-request", startWork: "builtin:handle-request" },
          "ask",
          "Ask about code needs a chat-ask playbook; Handle a request is a request playbook.",
        ],
        [
          { ask: "builtin:ask-about-code", startWork: "builtin:implement-story" },
          "startWork",
          "Start work needs a request playbook; Implement a story is a story playbook.",
        ],
        [
          { ask: foreignAsk, startWork: "builtin:handle-request" },
          "ask",
          `There's no playbook ${foreignAsk}.`,
        ],
        [{ ask: "builtin:ask-about-code" }, "startWork", "Choose a playbook."],
      ] as const) {
        const { result, changes } = await captureChanges(() => saveDefaults(body));
        expect(result).toMatchObject({ ok: false, fieldErrors: { [field]: error } });
        expect(changes).toEqual([]);
      }
      expect(await getChatPlaybookDefaults(db, acme)).toEqual(DEFAULT_CHAT_PLAYBOOKS);
    });
  });

  describe("PUT and DELETE /api/ui/integrations/chat-connections/[id]/channels", () => {
    const connectionChange = () =>
      expect.objectContaining({ resource: "connection", ids: [slack], organizationId: acme });

    it("saves and removes a channel's overrides, publishing the connection's change each time", async () => {
      const saved = await captureChanges(() =>
        saveChannel({ channel: "C0123ABCD", ask: ownAsk, startWork: null }),
      );
      expect(saved.result).toEqual({ ok: true });
      expect(await getChatChannelPlaybookSetting(db, acme, slack, "slack:C0123ABCD")).toMatchObject(
        { askPlaybookId: ownAsk, startWorkPlaybookId: null, updatedBy: admin.id },
      );
      expect(saved.changes).toEqual(expect.arrayContaining([connectionChange()]));
      expect(saved.changes.every((change) => change.organizationId === acme)).toBe(true);

      const removed = await captureChanges(() => removeChannel("slack:C0123ABCD"));
      expect(removed.result).toEqual({ ok: true });
      expect(await getChatChannelPlaybookSetting(db, acme, slack, "slack:C0123ABCD")).toBeNull();
      expect(removed.changes).toEqual(expect.arrayContaining([connectionChange()]));

      const again = await captureChanges(() => removeChannel("slack:C0123ABCD"));
      expect(again.result).toEqual({ ok: false, error: "That channel has no playbook overrides." });
      expect(again.changes).toEqual([]);
    });

    it("refuses members, and publishes nothing", async () => {
      state.user = member;
      const { result, changes } = await captureChanges(async () => [
        await saveChannel({ channel: "C0MEMBER", ask: ownAsk, startWork: null }),
        await removeChannel("slack:C0MEMBER"),
      ]);
      expect(result).toEqual([
        expect.objectContaining({ ok: false }),
        expect.objectContaining({ ok: false }),
      ]);
      expect(changes).toEqual([]);
      expect(await getChatChannelPlaybookSetting(db, acme, slack, "slack:C0MEMBER")).toBeNull();
    });

    it("refuses a playbook of another role, and publishes nothing", async () => {
      const { result, changes } = await captureChanges(() =>
        saveChannel({ channel: "C0WRONG", ask: null, startWork: "builtin:ask-about-code" }),
      );
      expect(result).toMatchObject({
        ok: false,
        fieldErrors: {
          startWork: "Start work needs a request playbook; Ask about code is a chat-ask playbook.",
        },
      });
      expect(changes).toEqual([]);
      expect(await getChatChannelPlaybookSetting(db, acme, slack, "slack:C0WRONG")).toBeNull();
    });
  });
});
