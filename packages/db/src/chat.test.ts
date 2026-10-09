import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPostgresState, postgresSchemaStatements } from "@chat-adapter/state-pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import pg from "pg";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  appendChatMessage,
  deleteChatConnection,
  ensureChatThread,
  getChatConnectionByExternalId,
  getChatConnectionWithCredentials,
  getChatIdentity,
  getChatUserProfile,
  linkChatIdentity,
  listChatConnections,
  listChatIdentities,
  listChatMessages,
  saveChatConnection,
  saveChatUserProfile,
  unlinkChatIdentity,
  type ChatConnection,
  type ChatPlatform,
} from "./chat.js";
import { closeDb, createDb, type Database } from "./client.js";
import { decrypt } from "./crypto.js";
import { migrationsFolder, runMigrations } from "./migrate.js";
import {
  chatConnections,
  chatIdentities,
  chatMessages,
  chatThreads,
  chatUserProfiles,
  organizations,
  users,
} from "./schema.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

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

describe.skipIf(!dockerAvailable)("chat queries", () => {
  const key = randomBytes(32);
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    await db.insert(users).values([
      { id: "admin-1", email: "admin@example.com" },
      { id: "member-1", email: "member@example.com" },
    ]);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
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
    });
    expect(relinked).toMatchObject({ userId: "member-1", source: "manual" });
    expect(await db.select().from(chatIdentities)).toHaveLength(1);

    await linkChatIdentity(db, {
      organizationId: otherOrgId,
      platform: "discord",
      externalUserId: "D1",
      userId: "member-1",
      source: "manual",
    });
    expect(
      (await listChatIdentities(db, "member-1")).map((i) => [i.organizationId, i.externalUserId]),
    ).toEqual([
      [orgId, "U1"],
      [otherOrgId, "D1"],
    ]);
    expect(await listChatIdentities(db, "admin-1")).toEqual([]);

    // Only the linked user can unlink.
    expect(await unlinkChatIdentity(db, "admin-1", orgId, "slack", "U1")).toBe(false);
    expect(await unlinkChatIdentity(db, "member-1", orgId, "slack", "U1")).toBe(true);
    expect(await getChatIdentity(db, orgId, "slack", "U1")).toBeNull();
    expect(await unlinkChatIdentity(db, "member-1", orgId, "slack", "U1")).toBe(false);
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
    const pool = new pg.Pool({ connectionString: container.getConnectionUri() });
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
