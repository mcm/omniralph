// The chat playbook endpoints against a real database: any member reads them
// (`GET /api/ui/integrations/chat-tasks`); the organization's choice
// (`PUT /api/ui/integrations/chat-tasks`) and a channel's overrides
// (`PUT`/`DELETE /api/ui/integrations/chat-connections/[id]/channels`) are admin-only,
// check each playbook's role, and publish one `chat_playbooks` settings event each.
import { randomBytes } from "node:crypto";
import {
  closeDb,
  createDb,
  DEFAULT_CHAT_PLAYBOOKS,
  ensureWebChatConnection,
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  /** Acme's hidden web connection: never listed, and has no channels. */
  let web: string;
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
    web = (await ensureWebChatConnection(db, acme)).id;
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

  const readSettings = () => callAction(chatPlaybooks.GET, "GET", {});
  const saveDefaults = (body: unknown) => callAction(chatPlaybooks.PUT, "PUT", {}, body);
  const chatPlaybooksChanges = (changes: { resource: string; section?: string }[]) =>
    changes.filter(
      (change) => change.resource === "settings" && change.section === "chat_playbooks",
    );
  const saveChannel = (body: unknown) => callAction(channels.PUT, "PUT", { id: slack }, body);
  const removeChannel = (channelId: string) =>
    callAction(channels.DELETE, "DELETE", { id: slack }, { channelId });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET /api/ui/integrations/chat-tasks", () => {
    it("shows any member the defaults, the choices and each connection's overrides, without secrets", async () => {
      await setChatPlaybookDefaults(
        db,
        acme,
        { ask: ownAsk, startWork: "builtin:handle-request" },
        null,
      );
      await saveChannel({ channel: "C0READ01", ask: null, startWork: "builtin:handle-request" });
      state.user = member;
      const result = (await readSettings()) as Record<string, unknown>;
      expect(result).toMatchObject({
        defaults: { ask: ownAsk, startWork: "builtin:handle-request" },
        builtinDefaults: DEFAULT_CHAT_PLAYBOOKS,
        choices: {
          ask: expect.arrayContaining([
            { id: "builtin:ask-about-code", name: "Ask about code", builtin: true },
            { id: ownAsk, name: "Security Q&A", builtin: false },
          ]),
        },
        connections: [
          {
            id: slack,
            name: "Acme Slack",
            platform: "slack",
            channels: [
              {
                channelId: "slack:C0READ01",
                channel: "C0READ01",
                ask: null,
                startWork: "builtin:handle-request",
              },
            ],
          },
        ],
      });
      const json = JSON.stringify(result);
      expect(json).not.toContain(web);
      expect(json).not.toContain("xoxb");
      expect(json).not.toContain(foreignAsk);
      state.user = admin;
      await removeChannel("slack:C0READ01");
    });
  });

  describe("PUT /api/ui/integrations/chat-tasks", () => {
    it("saves the organization's chat playbooks and publishes one chat_playbooks change", async () => {
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
            section: "chat_playbooks",
            ids: [acme],
            organizationId: acme,
          }),
        ]),
      );
      expect(chatPlaybooksChanges(changes)).toHaveLength(1);
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
    it("refuses the hidden web connection", async () => {
      expect(
        await callAction(
          channels.PUT,
          "PUT",
          { id: web },
          { channel: "C0WEB001", ask: "builtin:ask-about-code", startWork: null },
        ),
      ).toEqual({ ok: false, error: "That chat connection isn't connected." });
      expect(await getChatChannelPlaybookSetting(db, acme, web, `web:${acme}`)).toBeNull();
    });

    const overrideChange = () =>
      expect.objectContaining({
        resource: "settings",
        section: "chat_playbooks",
        ids: [slack],
        subjectId: slack,
        organizationId: acme,
      });
    const connectionChange = overrideChange;

    it("saves and removes a channel's overrides, publishing one chat_playbooks change each time", async () => {
      const saved = await captureChanges(() =>
        saveChannel({ channel: "C0123ABCD", ask: ownAsk, startWork: null }),
      );
      expect(saved.result).toEqual({
        ok: true,
        channel: {
          channelId: "slack:C0123ABCD",
          channel: "C0123ABCD",
          ask: ownAsk,
          startWork: null,
        },
      });
      expect(chatPlaybooksChanges(saved.changes)).toHaveLength(1);
      expect(await getChatChannelPlaybookSetting(db, acme, slack, "slack:C0123ABCD")).toMatchObject(
        { askPlaybookId: ownAsk, startWorkPlaybookId: null, updatedBy: admin.id },
      );
      expect(saved.changes).toEqual(expect.arrayContaining([connectionChange()]));
      expect(saved.changes.every((change) => change.organizationId === acme)).toBe(true);

      const removed = await captureChanges(() => removeChannel("slack:C0123ABCD"));
      expect(removed.result).toEqual({ ok: true });
      expect(await getChatChannelPlaybookSetting(db, acme, slack, "slack:C0123ABCD")).toBeNull();
      expect(removed.changes).toEqual(expect.arrayContaining([connectionChange()]));
      expect(chatPlaybooksChanges(removed.changes)).toHaveLength(1);

      const again = await captureChanges(() => removeChannel("slack:C0123ABCD"));
      expect(again.result).toEqual({ ok: false, error: "That channel has no playbook overrides." });
      expect(again.changes).toEqual([]);
    });

    it("looks a channel up by its name in the Slack workspace", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin + url.pathname).toBe("https://slack.com/api/conversations.list");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xoxb-1");
        const page = url.searchParams.get("cursor") === "next";
        return Response.json({
          ok: true,
          channels: page
            ? [{ id: "C0RELEASE", name: "release-train" }]
            : [{ id: "C0GEN", name: "general" }],
          response_metadata: { next_cursor: page ? "" : "next" },
        });
      });
      const saved = await captureChanges(() =>
        saveChannel({ channel: "#Release-Train", ask: null, startWork: "builtin:handle-request" }),
      );
      expect(saved.result).toEqual({
        ok: true,
        channel: {
          channelId: "slack:C0RELEASE",
          channel: "C0RELEASE",
          ask: null,
          startWork: "builtin:handle-request",
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(chatPlaybooksChanges(saved.changes)).toHaveLength(1);
      await removeChannel("slack:C0RELEASE");
    });

    it("refuses a channel name the workspace doesn't have, or can't be looked up, and publishes nothing", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({ ok: true, channels: [{ id: "C0GEN", name: "general" }] }),
      );
      const missing = await captureChanges(() =>
        saveChannel({ channel: "nowhere", ask: ownAsk, startWork: null }),
      );
      expect(missing.result).toMatchObject({
        ok: false,
        fieldErrors: {
          channel: "Om can't find #nowhere in Acme Slack. Enter its channel ID instead.",
        },
      });
      expect(missing.changes).toEqual([]);

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({ ok: false, error: "missing_scope" }),
      );
      const unavailable = await captureChanges(() =>
        saveChannel({ channel: "general", ask: ownAsk, startWork: null }),
      );
      expect(unavailable.result).toMatchObject({
        ok: false,
        fieldErrors: {
          channel: "Couldn't look up #general in Acme Slack. Enter its channel ID instead.",
        },
      });
      expect(unavailable.changes).toEqual([]);

      const fetchMock = vi.spyOn(globalThis, "fetch");
      fetchMock.mockClear();
      const malformed = await saveChannel({
        channel: "not a channel!",
        ask: ownAsk,
        startWork: null,
      });
      expect(malformed).toMatchObject({
        ok: false,
        fieldErrors: {
          channel:
            "Enter a Slack channel ID like C0123ABCD (in the channel's details), or its name.",
        },
      });
      // A bad playbook is refused before any lookup.
      await saveChannel({ channel: "general", ask: "builtin:handle-request", startWork: null });
      expect(fetchMock).not.toHaveBeenCalled();
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
