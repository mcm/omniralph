import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPostgresState, postgresSchemaStatements } from "@chat-adapter/state-pg";
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_PLAYBOOKS_KEY,
  DEFAULT_CHAT_PLAYBOOKS,
  getAppSetting,
  getChatPlaybookDefaults,
  setChatPlaybookDefaults,
} from "./app-settings.js";
import {
  appendChatMessage,
  deleteChatChannelPlaybookSetting,
  deleteChatConnection,
  deleteChatConnectionByExternalId,
  ensureChatThread,
  getChatChannelPlaybookSetting,
  getChatConnectionByExternalId,
  getChatConnectionWithCredentials,
  getChatIdentity,
  getChatUserProfile,
  hasChatIdentityOptOut,
  isChatLinkStateUsed,
  latestThreadRun,
  linkChatIdentity,
  linkChatIdentityWithState,
  listChatChannelPlaybookSettings,
  listChatConnections,
  listChatIdentities,
  listChatMessages,
  listRunEvents,
  listThreadRuns,
  mapThreadRun,
  setThreadRunJob,
  recordRunEvent,
  recordRunEventAttempt,
  markRunEventsProcessed,
  listThreadsWithPendingRunEvents,
  runRequester,
  saveChatConnection,
  saveChatUserProfile,
  threadOfRun,
  threadRunOf,
  unlinkChatIdentity,
  upsertChatChannelPlaybookSetting,
  type ChatConnection,
  type ChatPlatform,
} from "./chat.js";
import { closeDb, createDb, type Database } from "./client.js";
import { captureChanges } from "./changes.js";
import { decrypt } from "./crypto.js";
import { migrationsFolder } from "./migrate.js";
import {
  chatChannelTaskSettings,
  chatConnections,
  chatIdentities,
  chatLinkStateUses,
  chatMessages,
  chatRunEvents,
  chatThreadRuns,
  chatThreads,
  chatUserProfiles,
  jobs,
  organizations,
  ralphRuns,
  users,
} from "./schema.js";

const databaseAvailable = testDatabaseAvailable();

interface Creds {
  botToken: string;
}

describe("chat state migration", () => {
  it("is the @chat-adapter/state-pg schema", () => {
    const sql = readFileSync(join(migrationsFolder, "0040_chat_state.sql"), "utf8");
    const statements = sql
      .replace(/^--.*\n/gm, "")
      .split("--> statement-breakpoint\n")
      .map((s) => s.trim().replace(/;$/, ""));
    expect(statements).toEqual([...postgresSchemaStatements]);
  });
});

describe.skipIf(!databaseAvailable)("chat queries", () => {
  const key = randomBytes(32);
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    await db.insert(users).values([
      { id: "admin-1", email: "admin@example.com" },
      { id: "member-1", email: "member@example.com" },
    ]);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(organizations);
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgId = org!.id;
    otherOrgId = other!.id;
  });

  const connect = async (
    platform: ChatPlatform,
    externalId: string,
    credentials: Creds | null,
    organizationId = orgId,
    name = "Acme",
  ): Promise<ChatConnection> => {
    const saved = await saveChatConnection<Creds>(
      db,
      { organizationId, platform, externalId, name, credentials, installedByUserId: "admin-1" },
      key,
    );
    if (saved === "other_organization") throw new Error("connected to another organization");
    return saved;
  };

  it("stores Slack credentials encrypted and reads them back", async () => {
    const saved = await connect("slack", "T1", { botToken: "xoxb-secret" });
    expect(saved).toMatchObject({
      organizationId: orgId,
      platform: "slack",
      externalId: "T1",
      name: "Acme",
      installedByUserId: "admin-1",
    });
    expect(saved).not.toHaveProperty("encryptedCredentials");

    const [row] = await db.select().from(chatConnections);
    expect(row!.encryptedCredentials).not.toContain("xoxb-secret");
    expect(JSON.parse(decrypt(row!.encryptedCredentials!, key))).toEqual({
      botToken: "xoxb-secret",
    });

    expect(await getChatConnectionByExternalId(db, "slack", "T1")).toEqual(saved);
    expect(await getChatConnectionByExternalId(db, "discord", "T1")).toBeNull();
    expect(
      (await getChatConnectionWithCredentials<Creds>(db, "slack", "T1", key))?.credentials,
    ).toEqual({ botToken: "xoxb-secret" });
    expect(await getChatConnectionWithCredentials(db, "slack", "T2", key)).toBeNull();
  });

  it("stores connections without credentials", async () => {
    await connect("discord", "G1", null);
    const [row] = await db.select().from(chatConnections);
    expect(row!.encryptedCredentials).toBeNull();
    expect(
      (await getChatConnectionWithCredentials<Creds>(db, "discord", "G1", key))?.credentials,
    ).toBeNull();
  });

  it("updates the connection on reconnect", async () => {
    const first = await connect("slack", "T1", { botToken: "old" });
    const second = await connect("slack", "T1", { botToken: "new" }, orgId, "Acme Renamed");
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Acme Renamed");
    expect(
      (await getChatConnectionWithCredentials<Creds>(db, "slack", "T1", key))?.credentials,
    ).toEqual({ botToken: "new" });
  });

  it("refuses a workspace connected to another organization", async () => {
    await connect("slack", "T1", { botToken: "acme" });
    const result = await saveChatConnection<Creds>(
      db,
      {
        organizationId: otherOrgId,
        platform: "slack",
        externalId: "T1",
        name: "Other",
        credentials: { botToken: "other" },
        installedByUserId: null,
      },
      key,
    );
    expect(result).toBe("other_organization");
    const connection = await getChatConnectionWithCredentials<Creds>(db, "slack", "T1", key);
    expect(connection).toMatchObject({ organizationId: orgId, name: "Acme" });
    expect(connection?.credentials).toEqual({ botToken: "acme" });
    // The same ID on the other platform is a different connection.
    await expect(connect("discord", "T1", null, otherOrgId)).resolves.toMatchObject({
      organizationId: otherOrgId,
    });
  });

  it("lists the organization's connections", async () => {
    const slack = await connect("slack", "T1", { botToken: "t" });
    const discord = await connect("discord", "G1", null);
    await connect("slack", "T2", { botToken: "t" }, otherOrgId);
    expect((await listChatConnections(db, orgId)).map((c) => c.id)).toEqual([slack.id, discord.id]);
  });

  it("deletes a connection of the organization only", async () => {
    const slack = await connect("slack", "T1", { botToken: "xoxb" });
    expect(await deleteChatConnection(db, otherOrgId, slack.id, key)).toBeNull();
    const removed = await deleteChatConnection<Creds>(db, orgId, slack.id, key);
    expect(removed).toMatchObject({ id: slack.id, credentials: { botToken: "xoxb" } });
    expect(await getChatConnectionByExternalId(db, "slack", "T1")).toBeNull();
    expect(await deleteChatConnection(db, orgId, slack.id, key)).toBeNull();
  });

  it("deletes a workspace's connection by its external ID", async () => {
    const discord = await connect("discord", "G1", null);
    expect(await deleteChatConnectionByExternalId(db, "slack", "G1")).toBeNull();
    expect(await deleteChatConnectionByExternalId(db, "discord", "G1")).toMatchObject({
      id: discord.id,
      organizationId: orgId,
    });
    expect(await getChatConnectionByExternalId(db, "discord", "G1")).toBeNull();
    expect(await deleteChatConnectionByExternalId(db, "discord", "G1")).toBeNull();
  });

  describe("channel playbook settings", () => {
    const save = (connectionId: string, channelId: string, organizationId = orgId) =>
      upsertChatChannelPlaybookSetting(db, {
        organizationId,
        connectionId,
        channelId,
        askPlaybookId: "builtin:ask-about-code",
        startWorkPlaybookId: null,
        updatedBy: "admin-1",
      });

    it("creates and replaces a channel's overrides", async () => {
      const slack = await connect("slack", "T1", { botToken: "t" });
      const created = await save(slack.id, "C1");
      expect(created).toMatchObject({
        organizationId: orgId,
        connectionId: slack.id,
        channelId: "C1",
        askPlaybookId: "builtin:ask-about-code",
        startWorkPlaybookId: null,
        updatedBy: "admin-1",
      });
      const replaced = await upsertChatChannelPlaybookSetting(db, {
        organizationId: orgId,
        connectionId: slack.id,
        channelId: "C1",
        askPlaybookId: null,
        startWorkPlaybookId: "builtin:handle-request",
        updatedBy: "member-1",
      });
      expect(replaced).toMatchObject({
        id: created!.id,
        askPlaybookId: null,
        startWorkPlaybookId: "builtin:handle-request",
        updatedBy: "member-1",
      });
      await save(slack.id, "C0");
      expect(
        (await listChatChannelPlaybookSettings(db, orgId, slack.id)).map((s) => s.channelId),
      ).toEqual(["C0", "C1"]);
      expect(await getChatChannelPlaybookSetting(db, orgId, slack.id, "C1")).toEqual(replaced);
      expect(await getChatChannelPlaybookSetting(db, orgId, slack.id, "C2")).toBeNull();
    });

    it("deletes a channel's overrides", async () => {
      const slack = await connect("slack", "T1", { botToken: "t" });
      await save(slack.id, "C1");
      await save(slack.id, "C2");
      expect(await deleteChatChannelPlaybookSetting(db, otherOrgId, slack.id, "C1")).toBe(false);
      expect(await deleteChatChannelPlaybookSetting(db, orgId, slack.id, "C1")).toBe(true);
      expect(await deleteChatChannelPlaybookSetting(db, orgId, slack.id, "C1")).toBe(false);
      expect(
        (await listChatChannelPlaybookSettings(db, orgId, slack.id)).map((s) => s.channelId),
      ).toEqual(["C2"]);
    });

    it("records one chat_playbooks change per save and removal, none when nothing changed", async () => {
      const slack = await connect("slack", "T1", { botToken: "t" });
      const change = expect.objectContaining({
        resource: "settings",
        section: "chat_playbooks",
        ids: [slack.id],
        subjectId: slack.id,
        organizationId: orgId,
      });
      expect((await captureChanges(() => save(slack.id, "C1"))).changes).toEqual([change]);
      expect(
        (await captureChanges(() => deleteChatChannelPlaybookSetting(db, orgId, slack.id, "C1")))
          .changes,
      ).toEqual([change]);
      expect(
        (await captureChanges(() => deleteChatChannelPlaybookSetting(db, orgId, slack.id, "C1")))
          .changes,
      ).toEqual([]);
      const theirs = await connect("slack", "T2", { botToken: "t" }, otherOrgId);
      expect((await captureChanges(() => save(theirs.id, "C1"))).changes).toEqual([]);
    });

    it("goes with its connection", async () => {
      const slack = await connect("slack", "T1", { botToken: "t" });
      const discord = await connect("discord", "G1", null);
      await save(slack.id, "C1");
      await save(discord.id, "C1");
      await deleteChatConnection(db, orgId, slack.id, key);
      expect((await listChatChannelPlaybookSettings(db, orgId)).map((s) => s.connectionId)).toEqual(
        [discord.id],
      );
      expect(await db.select().from(chatChannelTaskSettings)).toHaveLength(1);
    });

    it("never touches another organization's rows", async () => {
      const ours = await connect("slack", "T1", { botToken: "t" });
      const theirs = await connect("slack", "T2", { botToken: "t" }, otherOrgId);
      await save(ours.id, "C1");
      await save(theirs.id, "C1", otherOrgId);
      // Another organization's connection can't be given overrides.
      expect(await save(theirs.id, "C9")).toBeNull();
      expect(await listChatChannelPlaybookSettings(db, orgId, theirs.id)).toEqual([]);
      expect(await getChatChannelPlaybookSetting(db, orgId, theirs.id, "C1")).toBeNull();
      const listed = await listChatChannelPlaybookSettings(db, orgId);
      expect(listed.map((s) => [s.organizationId, s.connectionId])).toEqual([[orgId, ours.id]]);
      expect(await deleteChatChannelPlaybookSetting(db, orgId, theirs.id, "C1")).toBe(false);
      expect(await listChatChannelPlaybookSettings(db, otherOrgId)).toHaveLength(1);
    });
  });

  it("stores the organization's chat playbooks, defaulting to the built-ins", async () => {
    expect(await getChatPlaybookDefaults(db, orgId)).toEqual(DEFAULT_CHAT_PLAYBOOKS);
    expect(DEFAULT_CHAT_PLAYBOOKS).toEqual({
      ask: "builtin:ask-about-code",
      startWork: "builtin:handle-request",
    });
    const chosen = { ask: "builtin:other-query", startWork: "builtin:other-coding" };
    const saved = await captureChanges(() => setChatPlaybookDefaults(db, orgId, chosen, "admin-1"));
    expect(saved.changes).toEqual([
      expect.objectContaining({
        resource: "settings",
        section: "chat_playbooks",
        ids: [orgId],
        organizationId: orgId,
      }),
    ]);
    expect(await getChatPlaybookDefaults(db, orgId)).toEqual(chosen);
    expect(await getChatPlaybookDefaults(db, otherOrgId)).toEqual(DEFAULT_CHAT_PLAYBOOKS);
    expect((await getAppSetting(db, orgId, CHAT_PLAYBOOKS_KEY))?.updatedBy).toBe("admin-1");
    await setChatPlaybookDefaults(db, orgId, null, "admin-1");
    expect(await getChatPlaybookDefaults(db, orgId)).toEqual(DEFAULT_CHAT_PLAYBOOKS);
  });

  it("links, relinks and unlinks chat identities", async () => {
    expect(await getChatIdentity(db, orgId, "slack", "U1")).toBeNull();
    const linked = await linkChatIdentity(db, {
      organizationId: orgId,
      platform: "slack",
      externalUserId: "U1",
      userId: "admin-1",
      source: "email",
    });
    expect(linked).toMatchObject({ userId: "admin-1", source: "email" });
    expect(await getChatIdentity(db, orgId, "slack", "U1")).toEqual(linked);
    expect(await getChatIdentity(db, otherOrgId, "slack", "U1")).toBeNull();
    expect(await getChatIdentity(db, orgId, "discord", "U1")).toBeNull();

    const relinked = await linkChatIdentity(db, {
      organizationId: orgId,
      platform: "slack",
      externalUserId: "U1",
      userId: "member-1",
      source: "manual",
      displayName: "Ada",
    });
    expect(relinked).toMatchObject({ userId: "member-1", source: "manual", displayName: "Ada" });
    expect(await db.select().from(chatIdentities)).toHaveLength(1);

    await linkChatIdentity(db, {
      organizationId: otherOrgId,
      platform: "discord",
      externalUserId: "D1",
      userId: "member-1",
      source: "manual",
    });
    expect(
      (await listChatIdentities(db, "member-1")).map((i) => [
        i.organizationId,
        i.organizationName,
        i.externalUserId,
      ]),
    ).toEqual([
      [orgId, "Acme", "U1"],
      [otherOrgId, "Other", "D1"],
    ]);
    expect(await listChatIdentities(db, "admin-1")).toEqual([]);

    // Only the linked user can unlink.
    expect(await unlinkChatIdentity(db, "admin-1", orgId, "slack", "U1")).toBe(false);
    expect(await unlinkChatIdentity(db, "member-1", orgId, "slack", "U1")).toBe(true);
    expect(await getChatIdentity(db, orgId, "slack", "U1")).toBeNull();
    expect(await unlinkChatIdentity(db, "member-1", orgId, "slack", "U1")).toBe(false);
  });

  it("records an opt-out on unlink that a manual link withdraws", async () => {
    const link = (source: "email" | "manual", displayName?: string) =>
      linkChatIdentity(db, {
        organizationId: orgId,
        platform: "slack",
        externalUserId: "U1",
        userId: "member-1",
        source,
        displayName,
      });
    await link("email", "Ada");
    expect(await hasChatIdentityOptOut(db, orgId, "slack", "U1")).toBe(false);
    // Another user's unlink attempt records nothing.
    await unlinkChatIdentity(db, "admin-1", orgId, "slack", "U1");
    expect(await hasChatIdentityOptOut(db, orgId, "slack", "U1")).toBe(false);

    expect(await unlinkChatIdentity(db, "member-1", orgId, "slack", "U1")).toBe(true);
    expect(await hasChatIdentityOptOut(db, orgId, "slack", "U1")).toBe(true);
    expect(await hasChatIdentityOptOut(db, otherOrgId, "slack", "U1")).toBe(false);
    expect(await hasChatIdentityOptOut(db, orgId, "discord", "U1")).toBe(false);

    // Linking by email keeps the opt-out; linking manually withdraws it.
    await link("email");
    expect(await hasChatIdentityOptOut(db, orgId, "slack", "U1")).toBe(true);
    expect(await link("manual", "Bea")).toMatchObject({ source: "manual", displayName: "Bea" });
    expect(await hasChatIdentityOptOut(db, orgId, "slack", "U1")).toBe(false);
    // A link without a display name keeps the known one.
    expect(await link("email")).toMatchObject({ source: "email", displayName: "Bea" });
  });

  it("uses a link state once, in the link's transaction", async () => {
    const id = "6f1c1d1e-0000-4000-8000-000000000001";
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const link = (userId: string) =>
      linkChatIdentityWithState(
        db,
        {
          organizationId: orgId,
          platform: "discord",
          externalUserId: "D1",
          userId,
          source: "manual",
        },
        { id, expiresAt },
      );
    expect(await isChatLinkStateUsed(db, id)).toBe(false);
    expect(await link("member-1")).toMatchObject({ userId: "member-1", source: "manual" });
    expect(await isChatLinkStateUsed(db, id)).toBe(true);
    // A replay links nothing: the chat user stays linked to the first user.
    expect(await link("admin-1")).toBeNull();
    expect(await getChatIdentity(db, orgId, "discord", "D1")).toMatchObject({ userId: "member-1" });

    // Expired uses are purged by a later use.
    const stale = "6f1c1d1e-0000-4000-8000-000000000002";
    await db
      .insert(chatLinkStateUses)
      .values({ id: stale, expiresAt: new Date(Date.now() - 1000) });
    await linkChatIdentityWithState(
      db,
      {
        organizationId: orgId,
        platform: "discord",
        externalUserId: "D2",
        userId: "admin-1",
        source: "manual",
      },
      { id: "6f1c1d1e-0000-4000-8000-000000000003", expiresAt },
    );
    expect(await isChatLinkStateUsed(db, stale)).toBe(false);
    expect(await isChatLinkStateUsed(db, id)).toBe(true);
  });

  it("names each linked account's workspace", async () => {
    const link = (organizationId: string, platform: ChatPlatform, externalUserId: string) =>
      linkChatIdentity(db, {
        organizationId,
        platform,
        externalUserId,
        userId: "member-1",
        source: "manual",
      });
    // Acme has two Slack workspaces (U1 was seen in Platform) and no Discord server; Other
    // has one Discord server.
    await connect("slack", "T1", null, orgId, "Engineering");
    const platform = await connect("slack", "T2", null, orgId, "Platform");
    await connect("discord", "G1", null, otherOrgId, "Other guild");
    await saveChatUserProfile(db, {
      connectionId: platform.id,
      externalUserId: "U1",
      email: null,
      displayName: "Ada",
    });
    await link(orgId, "slack", "U1");
    await link(orgId, "slack", "U2");
    await link(orgId, "discord", "D9");
    await link(otherOrgId, "discord", "D1");
    expect(
      (await listChatIdentities(db, "member-1")).map((i) => [i.externalUserId, i.workspaceName]),
    ).toEqual([
      ["U1", "Platform"],
      // Two workspaces and never seen in either: unknown.
      ["U2", null],
      ["D9", null],
      // The organization's only server.
      ["D1", "Other guild"],
    ]);
  });

  it("records a linked-accounts change on the user's own channel", async () => {
    const link = (userId: string) =>
      linkChatIdentity(db, {
        organizationId: orgId,
        platform: "slack",
        externalUserId: "U1",
        userId,
        source: "manual",
      });
    const change = (userId: string) =>
      expect.objectContaining({
        resource: "settings",
        section: "linked_accounts",
        ids: [userId],
        organizationId: orgId,
        userId,
      });
    expect((await captureChanges(() => link("member-1"))).changes).toEqual([change("member-1")]);
    // Linking it to another member takes it from the first.
    expect((await captureChanges(() => link("admin-1"))).changes).toEqual([
      change("admin-1"),
      change("member-1"),
    ]);
    expect(
      (await captureChanges(() => unlinkChatIdentity(db, "admin-1", orgId, "slack", "U1"))).changes,
    ).toEqual([change("admin-1")]);
    // Nothing unlinked, nothing recorded.
    expect(
      (await captureChanges(() => unlinkChatIdentity(db, "admin-1", orgId, "slack", "U1"))).changes,
    ).toEqual([]);
  });

  it("caches chat user profiles per connection", async () => {
    const slack = await connect("slack", "T1", { botToken: "t" });
    expect(await getChatUserProfile(db, slack.id, "U1")).toBeNull();
    const first = new Date("2026-10-01T10:00:00Z");
    await saveChatUserProfile(
      db,
      { connectionId: slack.id, externalUserId: "U1", email: "a@example.com", displayName: "A" },
      first,
    );
    expect(await getChatUserProfile(db, slack.id, "U1")).toEqual({
      connectionId: slack.id,
      externalUserId: "U1",
      email: "a@example.com",
      displayName: "A",
      fetchedAt: first,
    });
    const second = new Date("2026-10-01T11:00:00Z");
    await saveChatUserProfile(
      db,
      { connectionId: slack.id, externalUserId: "U1", email: null, displayName: "Alice" },
      second,
    );
    expect(await getChatUserProfile(db, slack.id, "U1")).toMatchObject({
      email: null,
      displayName: "Alice",
      fetchedAt: second,
    });
  });

  it("creates a thread once, from the connection's organization and platform", async () => {
    const discord = await connect("discord", "G1", null);
    const input = {
      connectionId: discord.id,
      externalThreadId: "discord:G1:C1:M1",
      channelId: "C1",
      startedByExternalUserId: "D1",
    };
    const thread = await ensureChatThread(db, input);
    expect(thread).toMatchObject({ ...input, organizationId: orgId, platform: "discord" });
    const again = await ensureChatThread(db, input);
    expect(again?.id).toBe(thread!.id);
    expect(again!.updatedAt.getTime()).toBeGreaterThanOrEqual(thread!.updatedAt.getTime());
    expect(await db.select().from(chatThreads)).toHaveLength(1);

    await db.delete(chatConnections).where(eq(chatConnections.id, discord.id));
    expect(await ensureChatThread(db, input)).toBeNull();
  });

  it("appends messages and lists the latest ones in order", async () => {
    const slack = await connect("slack", "T1", { botToken: "t" });
    const thread = (await ensureChatThread(db, {
      connectionId: slack.id,
      externalThreadId: "slack:C1:1.0",
      channelId: "C1",
      startedByExternalUserId: "U1",
    }))!;
    const user = await appendChatMessage(db, {
      threadId: thread.id,
      role: "user",
      externalUserId: "U1",
      authorName: "Alice",
      content: [{ type: "text", text: "what runs are active?" }],
    });
    expect(user).toMatchObject({
      role: "user",
      externalUserId: "U1",
      authorName: "Alice",
      content: [{ type: "text", text: "what runs are active?" }],
    });
    // Inserted in one transaction (same `now()`): still ordered.
    await db.transaction(async (tx) => {
      await tx
        .insert(chatMessages)
        .values({ threadId: thread.id, role: "tool", content: { runs: [] } });
      await tx
        .insert(chatMessages)
        .values({ threadId: thread.id, role: "assistant", content: "None are active." });
    });

    const all = await listChatMessages(db, thread.id, 10);
    expect(all.map((m) => m.role)).toEqual(["user", "tool", "assistant"]);
    expect(all[1]).toMatchObject({ externalUserId: null, authorName: null });
    expect((await listChatMessages(db, thread.id, 2)).map((m) => m.role)).toEqual([
      "tool",
      "assistant",
    ]);
  });

  describe("thread runs", () => {
    const newThread = async (organizationId = orgId, externalId = "T1") => {
      const slack = await connect("slack", externalId, { botToken: "t" }, organizationId);
      return (await ensureChatThread(db, {
        connectionId: slack.id,
        externalThreadId: `slack:C1:${Math.random()}`,
        channelId: "slack:C1",
        startedByExternalUserId: "U1",
      }))!;
    };
    const newJob = async (organizationId = orgId) =>
      (
        await db
          .insert(jobs)
          .values({ organizationId, type: "chat.ask", taskType: "query" })
          .returning()
      )[0]!;
    const newRalphRun = async (organizationId = orgId) =>
      (
        await db
          .insert(ralphRuns)
          .values({
            organizationId,
            origin: "chat",
            kind: "single",
            mode: "request",
            repositoryId: null,
            status: "completed",
          })
          .returning()
      )[0]!;

    it("maps query and coding runs to a thread, both ways", async () => {
      const thread = await newThread();
      const first = await newJob();
      const coding = await newRalphRun();
      const second = await newJob();

      const query = await mapThreadRun(db, {
        organizationId: orgId,
        chatThreadId: thread.id,
        jobId: first.id,
      });
      expect(query).toMatchObject({
        organizationId: orgId,
        chatThreadId: thread.id,
        kind: "query",
        jobId: first.id,
        ralphRunId: null,
      });
      // The job is linked to its run.
      expect((await db.select().from(jobs).where(eq(jobs.id, first.id)))[0]?.chatThreadRunId).toBe(
        query!.id,
      );
      // Idempotent: mapping it again returns the same row.
      expect(
        await mapThreadRun(db, { organizationId: orgId, chatThreadId: thread.id, jobId: first.id }),
      ).toEqual(query);
      await mapThreadRun(db, {
        organizationId: orgId,
        chatThreadId: thread.id,
        ralphRunId: coding.id,
      });
      await mapThreadRun(db, { organizationId: orgId, chatThreadId: thread.id, jobId: second.id });

      expect(
        (await listThreadRuns(db, orgId, thread.id)).map((r) => [r.kind, r.jobId ?? r.ralphRunId]),
      ).toEqual([
        ["query", first.id],
        ["coding", coding.id],
        ["query", second.id],
      ]);
      expect((await latestThreadRun(db, orgId, thread.id))?.jobId).toBe(second.id);
      expect((await latestThreadRun(db, orgId, thread.id, "coding"))?.ralphRunId).toBe(coding.id);
      expect((await latestThreadRun(db, orgId, thread.id, "query"))?.jobId).toBe(second.id);
      expect((await threadOfRun(db, orgId, { jobId: first.id }))?.id).toBe(thread.id);
      expect((await threadOfRun(db, orgId, { ralphRunId: coding.id }))?.id).toBe(thread.id);
      // A run nobody mapped has no thread; a thread without runs has none.
      expect(await threadOfRun(db, orgId, { jobId: (await newJob()).id })).toBeNull();
      const empty = await newThread(orgId, "T2");
      expect(await listThreadRuns(db, orgId, empty.id)).toEqual([]);
      expect(await latestThreadRun(db, orgId, empty.id)).toBeNull();
    });

    it("points an ask at its retried attempt, in its organization only", async () => {
      const thread = await newThread();
      const first = await newJob();
      const ask = (await mapThreadRun(db, {
        organizationId: orgId,
        chatThreadId: thread.id,
        jobId: first.id,
      }))!;
      const retry = await newJob();
      expect(
        await setThreadRunJob(db, {
          organizationId: otherOrgId,
          chatThreadRunId: ask.id,
          jobId: retry.id,
        }),
      ).toBeNull();
      expect(
        await setThreadRunJob(db, {
          organizationId: orgId,
          chatThreadRunId: ask.id,
          jobId: retry.id,
        }),
      ).toMatchObject({ id: ask.id, jobId: retry.id });
      expect((await db.select().from(jobs).where(eq(jobs.id, retry.id)))[0]?.chatThreadRunId).toBe(
        ask.id,
      );
      // Both attempts stay the ask's; the retry's answer reaches the same thread.
      expect((await db.select().from(jobs).where(eq(jobs.id, first.id)))[0]?.chatThreadRunId).toBe(
        ask.id,
      );
      expect((await threadOfRun(db, orgId, { jobId: retry.id }))?.id).toBe(thread.id);
    });

    it("is scoped to the organization", async () => {
      const thread = await newThread();
      const job = await newJob();
      await mapThreadRun(db, { organizationId: orgId, chatThreadId: thread.id, jobId: job.id });
      const otherThread = await newThread(otherOrgId, "T-other");
      const otherJob = await newJob(otherOrgId);
      const otherRun = await newRalphRun(otherOrgId);

      // Another organization sees none of it.
      expect(await listThreadRuns(db, otherOrgId, thread.id)).toEqual([]);
      expect(await latestThreadRun(db, otherOrgId, thread.id)).toBeNull();
      expect(await threadOfRun(db, otherOrgId, { jobId: job.id })).toBeNull();
      // Nor can it map runs to another organization's thread, or another organization's runs.
      expect(
        await mapThreadRun(db, {
          organizationId: otherOrgId,
          chatThreadId: thread.id,
          jobId: otherJob.id,
        }),
      ).toBeNull();
      expect(
        await mapThreadRun(db, {
          organizationId: orgId,
          chatThreadId: thread.id,
          jobId: otherJob.id,
        }),
      ).toBeNull();
      expect(
        await mapThreadRun(db, {
          organizationId: orgId,
          chatThreadId: thread.id,
          ralphRunId: otherRun.id,
        }),
      ).toBeNull();
      // An already mapped run keeps its thread.
      expect(
        await mapThreadRun(db, {
          organizationId: otherOrgId,
          chatThreadId: otherThread.id,
          jobId: job.id,
        }),
      ).toBeNull();
      expect(await listThreadRuns(db, otherOrgId, otherThread.id)).toEqual([]);
      expect((await listThreadRuns(db, orgId, thread.id)).map((r) => r.jobId)).toEqual([job.id]);
    });

    it("checks a row's kind against its run and keeps one row per run", async () => {
      const thread = await newThread();
      const job = await newJob();
      const run = await newRalphRun();
      const row = { organizationId: orgId, chatThreadId: thread.id };
      const violated = (values: typeof chatThreadRuns.$inferInsert) =>
        db
          .insert(chatThreadRuns)
          .values(values)
          .then(
            () => null,
            (error: { cause?: { constraint?: string } }) => error.cause?.constraint ?? "unknown",
          );
      expect(await violated({ ...row, kind: "query", ralphRunId: run.id })).toBe(
        "chat_thread_runs_kind_check",
      );
      expect(await violated({ ...row, kind: "coding", jobId: job.id })).toBe(
        "chat_thread_runs_kind_check",
      );
      expect(await violated({ ...row, kind: "coding", jobId: job.id, ralphRunId: run.id })).toBe(
        "chat_thread_runs_kind_check",
      );
      expect(await violated({ ...row, kind: "query", jobId: job.id })).toBeNull();
      expect(await violated({ ...row, kind: "query", jobId: job.id })).toBe(
        "chat_thread_runs_job_id_uq",
      );
      expect(await violated({ ...row, kind: "coding", ralphRunId: run.id })).toBeNull();
      expect(await violated({ ...row, kind: "coding", ralphRunId: run.id })).toBe(
        "chat_thread_runs_ralph_run_id_uq",
      );

      // Rows go with their thread.
      await db.delete(chatThreads).where(eq(chatThreads.id, thread.id));
      expect(await db.select().from(chatThreadRuns)).toEqual([]);
    });

    it("records a run's events once per idempotency key", async () => {
      const thread = await newThread();
      const job = await newJob();
      await mapThreadRun(db, { organizationId: orgId, chatThreadId: thread.id, jobId: job.id });
      const threadRun = (await threadRunOf(db, orgId, { jobId: job.id }))!;
      expect(threadRun.chatThreadId).toBe(thread.id);
      expect(await threadRunOf(db, otherOrgId, { jobId: job.id })).toBeNull();
      const event = {
        organizationId: orgId,
        threadRun,
        kind: "response" as const,
        body: { text: "The answer." },
        idempotencyKey: `chat-run-event:job:${job.id}:response`,
      };

      const first = await recordRunEvent(db, event);
      expect(first.created).toBe(true);
      expect(first.event).toMatchObject({
        organizationId: orgId,
        chatThreadId: thread.id,
        threadRunId: threadRun.id,
        kind: "response",
        body: { text: "The answer." },
        processedAt: null,
        attempts: 0,
      });
      // The same key again (a replay) records nothing.
      expect(await recordRunEvent(db, { ...event, body: { text: "Again." } })).toEqual({
        created: false,
        event: null,
      });
      // Another organization can't record on this mapping.
      expect(
        await recordRunEvent(db, { ...event, organizationId: otherOrgId, idempotencyKey: "other" }),
      ).toEqual({ created: false, event: null });
      await recordRunEvent(db, {
        ...event,
        kind: "failure",
        body: { error: "boom" },
        idempotencyKey: `chat-run-event:job:${job.id}:failure`,
      });

      const events = await listRunEvents(db, orgId, thread.id);
      expect(events.map((e) => [e.kind, e.body])).toEqual([
        ["response", { text: "The answer." }],
        ["failure", { error: "boom" }],
      ]);
      expect(await listRunEvents(db, otherOrgId, thread.id)).toEqual([]);
      await db
        .update(chatRunEvents)
        .set({ processedAt: new Date() })
        .where(eq(chatRunEvents.id, first.event!.id));
      expect(
        (await listRunEvents(db, orgId, thread.id, { pending: true })).map((e) => e.kind),
      ).toEqual(["failure"]);

      // Events go with their thread.
      await db.delete(chatThreads).where(eq(chatThreads.id, thread.id));
      expect(await db.select().from(chatRunEvents)).toEqual([]);
    });

    it("tracks relaying run events: attempts, processed, and the threads still waiting", async () => {
      const thread = await newThread();
      const job = await newJob();
      await appendChatMessage(db, {
        threadId: thread.id,
        role: "user",
        externalUserId: "U-ASKER",
        authorName: "Asker",
        content: "how does it work?",
      });
      const threadRun = (await mapThreadRun(db, {
        organizationId: orgId,
        chatThreadId: thread.id,
        jobId: job.id,
      }))!;
      await appendChatMessage(db, {
        threadId: thread.id,
        role: "user",
        externalUserId: "U-LATER",
        content: "and later?",
      });
      // The author of the message the run was started for, not a later one.
      expect(await runRequester(db, orgId, threadRun)).toEqual({
        externalUserId: "U-ASKER",
        authorName: "Asker",
      });
      expect(await runRequester(db, otherOrgId, threadRun)).toBeNull();

      const { event } = await recordRunEvent(db, {
        organizationId: orgId,
        threadRun,
        kind: "response",
        body: { text: "The answer." },
        idempotencyKey: `chat-run-event:job:${job.id}:relay`,
      });
      const id = event!.id;
      const later = new Date(Date.now() + 60_000);
      const waiting = (maxAttempts = 3) =>
        listThreadsWithPendingRunEvents(db, { createdBefore: later, maxAttempts });

      expect(await waiting()).toContain(thread.id);
      expect(
        await listThreadsWithPendingRunEvents(db, { createdBefore: new Date(0), maxAttempts: 3 }),
      ).not.toContain(thread.id);

      // Another organization can neither count attempts nor mark it processed.
      await recordRunEventAttempt(db, otherOrgId, [id]);
      expect(await markRunEventsProcessed(db, otherOrgId, [id])).toBe(0);
      await recordRunEventAttempt(db, orgId, [id]);
      await recordRunEventAttempt(db, orgId, [id]);
      expect((await listRunEvents(db, orgId, thread.id))[0]).toMatchObject({ attempts: 2 });
      expect(await waiting(2)).not.toContain(thread.id);
      expect(await waiting(3)).toContain(thread.id);

      expect(await markRunEventsProcessed(db, orgId, [id])).toBe(1);
      expect(await markRunEventsProcessed(db, orgId, [id])).toBe(0);
      expect(await listRunEvents(db, orgId, thread.id, { pending: true })).toEqual([]);
      expect(await waiting()).not.toContain(thread.id);
    });
  });

  it("removes everything chat when the organization is deleted", async () => {
    const slack = await connect("slack", "T1", { botToken: "t" });
    await saveChatUserProfile(db, {
      connectionId: slack.id,
      externalUserId: "U1",
      email: null,
      displayName: "A",
    });
    await linkChatIdentity(db, {
      organizationId: orgId,
      platform: "slack",
      externalUserId: "U1",
      userId: "admin-1",
      source: "manual",
    });
    const thread = (await ensureChatThread(db, {
      connectionId: slack.id,
      externalThreadId: "slack:C1:1.0",
      channelId: "C1",
      startedByExternalUserId: "U1",
    }))!;
    await appendChatMessage(db, { threadId: thread.id, role: "user", content: "hi" });

    await db.delete(organizations).where(eq(organizations.id, orgId));
    expect(await db.select().from(chatConnections)).toEqual([]);
    expect(await db.select().from(chatIdentities)).toEqual([]);
    expect(await db.select().from(chatUserProfiles)).toEqual([]);
    expect(await db.select().from(chatThreads)).toEqual([]);
    expect(await db.select().from(chatMessages)).toEqual([]);
  });

  it("removes a user's chat identities when the user is deleted", async () => {
    await db.insert(users).values({ id: "gone-1", email: "gone@example.com" });
    await linkChatIdentity(db, {
      organizationId: orgId,
      platform: "discord",
      externalUserId: "D1",
      userId: "gone-1",
      source: "manual",
    });
    await db.delete(users).where(eq(users.id, "gone-1"));
    expect(await db.select().from(chatIdentities)).toEqual([]);
  });

  it("lets the Chat SDK state adapter run on the migrated tables", async () => {
    const pool = new pg.Pool({ connectionString: testDb.uri });
    const state = createPostgresState({ client: pool, autoCreateSchema: false });
    try {
      await state.connect();
      await state.subscribe("slack:C1:1.0");
      expect(await state.isSubscribed("slack:C1:1.0")).toBe(true);
      await state.set("dedupe:1", "seen", 60_000);
      expect(await state.get("dedupe:1")).toBe("seen");
    } finally {
      await state.disconnect();
      await pool.end();
    }
  });
});
