import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  appendWebMessage,
  createWebChatThread,
  deleteWebMessage,
  ensureChatThread,
  ensureWebChatConnection,
  getChatThreadWithConnection,
  getWebMessage,
  listChatConnections,
  listWebChats,
  listWebMessages,
  saveChatConnection,
  touchChatThread,
  updateWebMessage,
  webChatTitle,
  type WebChatCursor,
} from "./chat.js";
import { closeDb, createDb, type Database } from "./client.js";
import {
  chatConnections,
  chatThreads,
  chatWebMessages,
  organizations,
  repositories,
  scmConnections,
  users,
} from "./schema.js";

const databaseAvailable = testDatabaseAvailable();

describe("webChatTitle", () => {
  it("keeps a short message, with its whitespace collapsed", () => {
    expect(webChatTitle("  Why does   the\nlogin\tfail?  ")).toBe("Why does the login fail?");
  });

  it("keeps a message of exactly 60 characters", () => {
    const text = `${"abcd ".repeat(11)}abcde`;
    expect(text).toHaveLength(60);
    expect(webChatTitle(text)).toBe(text);
  });

  it("cuts a long message at a word boundary, with an ellipsis", () => {
    const text =
      "How does the customer portal refresh its session tokens when the identity provider is down?";
    const title = webChatTitle(text);
    expect(title).toBe("How does the customer portal refresh its session tokens…");
    expect(title.length).toBeLessThanOrEqual(60);
  });

  it("keeps a whole word that ends exactly at the cut", () => {
    // 59 characters of words, then a space: the cut needs no shortening.
    const text = `${"abcdefghi ".repeat(5)}abcdefghi and more`;
    expect(webChatTitle(text)).toBe(`${"abcdefghi ".repeat(5)}abcdefghi…`);
    expect(webChatTitle(text)).toHaveLength(60);
  });

  it("cuts one long word inside it", () => {
    const title = webChatTitle("x".repeat(100));
    expect(title).toBe(`${"x".repeat(59)}…`);
    expect(title).toHaveLength(60);
  });
});

describe.skipIf(!databaseAvailable)("web chats", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let repoId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    await db.insert(users).values([
      { id: "user-1", email: "one@example.com" },
      { id: "user-2", email: "two@example.com" },
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
    const [connection] = await db
      .insert(scmConnections)
      .values({
        organizationId: orgId,
        provider: "github",
        name: "GitHub",
        baseUrl: "https://api.github.com",
        encryptedCredentials: "x",
      })
      .returning();
    const [repo] = await db
      .insert(repositories)
      .values({
        organizationId: orgId,
        provider: "github",
        externalId: "1",
        fullPath: "acme/customer-portal",
        connectionId: connection!.id,
      })
      .returning();
    repoId = repo!.id;
  });

  const newChat = (title: string, { userId = "user-1", organizationId = orgId } = {}) =>
    createWebChatThread(db, {
      organizationId,
      userId,
      repositoryId: organizationId === orgId ? repoId : null,
      branch: organizationId === orgId ? "main" : null,
      title,
    });

  describe("ensureWebChatConnection", () => {
    it("creates the organization's web connection once", async () => {
      const first = await ensureWebChatConnection(db, orgId);
      expect(first).toMatchObject({
        organizationId: orgId,
        platform: "web",
        externalId: orgId,
        name: "Omniralph",
        installedByUserId: null,
      });
      expect(await ensureWebChatConnection(db, orgId)).toEqual(first);
      const rows = await db
        .select()
        .from(chatConnections)
        .where(eq(chatConnections.organizationId, orgId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.encryptedCredentials).toBeNull();
      expect((await ensureWebChatConnection(db, otherOrgId)).id).not.toBe(first.id);
    });

    it("creates one row for concurrent calls", async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => ensureWebChatConnection(db, orgId)),
      );
      expect(new Set(results.map((c) => c.id)).size).toBe(1);
      const [{ count }] = (
        await db.execute<{ count: number }>(
          sql`select count(*)::int as count from chat_connections where platform = 'web'`,
        )
      ).rows as [{ count: number }];
      expect(count).toBe(1);
    });

    it("is never listed with the organization's connections", async () => {
      await ensureWebChatConnection(db, orgId);
      const slack = await saveChatConnection(db, {
        organizationId: orgId,
        platform: "slack",
        externalId: "T1",
        name: "Acme",
        credentials: null,
        installedByUserId: "user-1",
      });
      expect(await listChatConnections(db, orgId)).toEqual([slack]);
    });
  });

  describe("createWebChatThread", () => {
    it("starts a chat on the organization's web connection", async () => {
      const chat = await newChat("Why does login fail?");
      const connection = await ensureWebChatConnection(db, orgId);
      expect(chat).toMatchObject({
        organizationId: orgId,
        connectionId: connection.id,
        platform: "web",
        externalThreadId: `web:${orgId}:${chat.id}`,
        channelId: `web:${orgId}`,
        startedByExternalUserId: "user-1",
        startedByUserId: "user-1",
        title: "Why does login fail?",
        repositoryId: repoId,
        branch: "main",
      });
      // Resolves its organization through its connection, as a Slack thread does.
      const found = await getChatThreadWithConnection(db, chat.id);
      expect(found?.thread.id).toBe(chat.id);
      expect(found?.connection).toMatchObject({ platform: "web", credentials: null });
    });

    it("keeps a chat when its repo is removed, and drops it with its starter", async () => {
      const chat = await newChat("About the portal");
      await db.delete(repositories).where(eq(repositories.id, repoId));
      const [kept] = await db.select().from(chatThreads).where(eq(chatThreads.id, chat.id));
      expect(kept?.repositoryId).toBeNull();
      await db.insert(users).values({ id: "doomed", email: "doomed@example.com" });
      const doomed = await createWebChatThread(db, {
        organizationId: orgId,
        userId: "doomed",
        repositoryId: null,
        branch: null,
        title: "Mine",
      });
      await db.delete(users).where(eq(users.id, "doomed"));
      expect(await db.select().from(chatThreads).where(eq(chatThreads.id, doomed.id))).toEqual([]);
    });
  });

  describe("listWebChats", () => {
    it("lists only the user's web chats in the organizations, newest first, once across pages", async () => {
      const mine = [];
      for (let i = 0; i < 5; i++) mine.push(await newChat(`Chat ${i}`));
      const otherUser = await newChat("Not mine", { userId: "user-2" });
      const otherOrg = await newChat("Elsewhere", { organizationId: otherOrgId });
      const slack = await saveChatConnection(db, {
        organizationId: orgId,
        platform: "slack",
        externalId: "T1",
        name: "Acme",
        credentials: null,
        installedByUserId: "user-1",
      });
      if (slack === "other_organization") throw new Error("unexpected");
      const slackThread = await ensureChatThread(db, {
        connectionId: slack.id,
        externalThreadId: "slack:C1:1.0",
        channelId: "slack:C1",
        startedByExternalUserId: "user-1",
      });
      // A Slack thread with the same starter ID is never a web chat.
      await db
        .update(chatThreads)
        .set({ startedByUserId: "user-1" })
        .where(eq(chatThreads.id, slackThread!.id));
      // Two chats share an `updated_at`: the ID breaks the tie.
      const tie = new Date("2026-10-01T12:00:00.123456Z");
      await touchChatThread(db, mine[1]!.id, tie);
      await touchChatThread(db, mine[2]!.id, tie);
      await touchChatThread(db, mine[0]!.id, new Date(Date.now() + 60_000));

      const seen: string[] = [];
      let cursor: WebChatCursor | null = null;
      let pages = 0;
      do {
        const page = await listWebChats(db, {
          userId: "user-1",
          organizationIds: [orgId],
          cursor,
          limit: 2,
        });
        seen.push(...page.chats.map((c) => c.id));
        cursor = page.next;
        pages++;
      } while (cursor && pages < 10);

      expect(seen).toHaveLength(5);
      expect(new Set(seen)).toEqual(new Set(mine.map((c) => c.id)));
      expect(seen[0]).toBe(mine[0]!.id);
      const all = await listWebChats(db, { userId: "user-1", organizationIds: [orgId] });
      expect(all.chats.map((c) => c.id)).toEqual(seen);
      expect(all.next).toBeNull();
      const times = all.chats.map((c) => c.updatedAt.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      for (const id of [otherUser.id, otherOrg.id, slackThread!.id]) {
        expect(seen).not.toContain(id);
      }

      const both = await listWebChats(db, {
        userId: "user-1",
        organizationIds: [orgId, otherOrgId],
      });
      expect(both.chats.map((c) => c.id)).toContain(otherOrg.id);
      expect(await listWebChats(db, { userId: "user-1", organizationIds: [] })).toEqual({
        chats: [],
        next: null,
      });
    });
  });

  describe("web messages", () => {
    it("appends messages, touching the chat, and lists them oldest first", async () => {
      const chat = await newChat("Hello");
      const before = new Date("2026-01-01T00:00:00Z");
      await touchChatThread(db, chat.id, before);
      const question = await appendWebMessage(db, {
        threadId: chat.id,
        author: "user",
        userId: "user-1",
        markdown: "Hello?",
      });
      expect(question).toMatchObject({
        organizationId: orgId,
        threadId: chat.id,
        author: "user",
        userId: "user-1",
        markdown: "Hello?",
        status: "complete",
        card: null,
        cardRef: null,
        threadRunId: null,
      });
      const [touched] = await db.select().from(chatThreads).where(eq(chatThreads.id, chat.id));
      expect(touched!.updatedAt.getTime()).toBeGreaterThan(before.getTime());

      const answer = await appendWebMessage(db, {
        threadId: chat.id,
        author: "om",
        status: "streaming",
      });
      expect(answer).toMatchObject({ author: "om", markdown: "", status: "streaming" });
      const card = { type: "card", title: "Request" };
      const updated = await updateWebMessage(db, answer!.id, {
        markdown: "Hi there.",
        status: "complete",
        card,
        cardRef: { kind: "request_draft", draftId: "d1" },
      });
      expect(updated).toMatchObject({
        markdown: "Hi there.",
        status: "complete",
        card,
        cardRef: { kind: "request_draft", draftId: "d1" },
      });
      expect(await getWebMessage(db, answer!.id)).toEqual(updated);
      // Only what is given changes.
      expect(await updateWebMessage(db, answer!.id, { card: null })).toMatchObject({
        markdown: "Hi there.",
        card: null,
        cardRef: { kind: "request_draft", draftId: "d1" },
      });
      expect(await updateWebMessage(db, crypto.randomUUID(), { markdown: "x" })).toBeNull();

      const page = await listWebMessages(db, chat.id, { limit: 100 });
      expect(page.messages.map((m) => m.id)).toEqual([question!.id, answer!.id]);
      expect(page.nextBefore).toBeNull();
    });

    it("pages back through older messages with before", async () => {
      const chat = await newChat("Many");
      const other = await newChat("Other");
      await appendWebMessage(db, { threadId: other.id, author: "user", markdown: "elsewhere" });
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const message = await appendWebMessage(db, {
          threadId: chat.id,
          author: i % 2 ? "om" : "user",
          markdown: `m${i}`,
        });
        ids.push(message!.id);
      }
      const latest = await listWebMessages(db, chat.id, { limit: 2 });
      expect(latest.messages.map((m) => m.id)).toEqual(ids.slice(3));
      expect(latest.nextBefore).toBe(ids[3]);
      const older = await listWebMessages(db, chat.id, { before: latest.nextBefore, limit: 2 });
      expect(older.messages.map((m) => m.id)).toEqual(ids.slice(1, 3));
      const oldest = await listWebMessages(db, chat.id, { before: older.nextBefore, limit: 2 });
      expect(oldest).toEqual({
        messages: [expect.objectContaining({ id: ids[0] })],
        nextBefore: null,
      });
      // Another chat's message is no anchor.
      const [foreign] = await db
        .select()
        .from(chatWebMessages)
        .where(eq(chatWebMessages.threadId, other.id));
      expect(await listWebMessages(db, chat.id, { before: foreign!.id, limit: 2 })).toEqual({
        messages: [],
        nextBefore: null,
      });
    });

    it("deletes messages, and drops them with their chat", async () => {
      const chat = await newChat("Short-lived");
      const message = await appendWebMessage(db, { threadId: chat.id, author: "om" });
      expect(await deleteWebMessage(db, message!.id)).toBe(true);
      expect(await deleteWebMessage(db, message!.id)).toBe(false);
      await appendWebMessage(db, { threadId: chat.id, author: "om" });
      await db.delete(chatThreads).where(eq(chatThreads.id, chat.id));
      expect(
        await db.select().from(chatWebMessages).where(eq(chatWebMessages.threadId, chat.id)),
      ).toEqual([]);
    });

    it("appends nothing to a chat that is gone", async () => {
      expect(
        await appendWebMessage(db, { threadId: crypto.randomUUID(), author: "user" }),
      ).toBeNull();
      expect(await touchChatThread(db, crypto.randomUUID())).toBeNull();
    });
  });
});
