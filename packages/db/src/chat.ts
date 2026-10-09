/**
 * Chat front door state: connected Slack workspaces and Discord servers, chat
 * users linked to members, cached chat user profiles, and the control-panel
 * agent's threads and their messages. Connection credentials are JSON
 * encrypted at rest with `encrypt()` (AES-256-GCM under `ENCRYPTION_KEY`).
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { decrypt, encrypt } from "./crypto.js";
import {
  chatConnections,
  chatIdentities,
  chatMessages,
  chatThreads,
  chatUserProfiles,
} from "./schema.js";

export type ChatPlatform = (typeof chatConnections.$inferSelect)["platform"];
export type ChatIdentitySource = (typeof chatIdentities.$inferSelect)["source"];
export type ChatMessageRole = (typeof chatMessages.$inferSelect)["role"];

export interface ChatConnection {
  id: string;
  organizationId: string;
  platform: ChatPlatform;
  externalId: string;
  name: string;
  installedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatConnectionWithCredentials<C> extends ChatConnection {
  /** Null when the connection has none (Discord). */
  credentials: C | null;
}

export interface SaveChatConnectionInput<C> {
  organizationId: string;
  platform: ChatPlatform;
  externalId: string;
  name: string;
  /** Null for connections without their own credentials (Discord). */
  credentials: C | null;
  installedByUserId: string | null;
}

export type ChatIdentity = typeof chatIdentities.$inferSelect;
export type ChatUserProfile = typeof chatUserProfiles.$inferSelect;
export type ChatThread = typeof chatThreads.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;

export interface LinkChatIdentityInput {
  organizationId: string;
  platform: ChatPlatform;
  externalUserId: string;
  userId: string;
  source: ChatIdentitySource;
}

export interface SaveChatUserProfileInput {
  connectionId: string;
  externalUserId: string;
  email: string | null;
  displayName: string;
}

export interface EnsureChatThreadInput {
  connectionId: string;
  externalThreadId: string;
  channelId: string;
  startedByExternalUserId: string;
}

export interface AppendChatMessageInput {
  threadId: string;
  role: ChatMessageRole;
  externalUserId?: string | null;
  authorName?: string | null;
  content: unknown;
}

type EncryptionKey = string | Buffer | undefined;
type ChatConnectionRow = typeof chatConnections.$inferSelect;

function toChatConnection(row: ChatConnectionRow): ChatConnection {
  const { encryptedCredentials: _, ...rest } = row;
  return rest;
}

function withCredentials<C>(
  row: ChatConnectionRow,
  key: EncryptionKey,
): ChatConnectionWithCredentials<C> {
  return {
    ...toChatConnection(row),
    credentials:
      row.encryptedCredentials === null
        ? null
        : (JSON.parse(decrypt(row.encryptedCredentials, key)) as C),
  };
}

// ── Connections ──────────────────────────────────────────────────────────────

/**
 * Connects (or reconnects) a workspace or server to an organization. A
 * workspace or server belongs to one organization
 * (`chat_connections_platform_external_id_uq`): when another organization has
 * it connected, nothing changes and the result is `"other_organization"`.
 */
export async function saveChatConnection<C>(
  db: Database,
  input: SaveChatConnectionInput<C>,
  key?: EncryptionKey,
): Promise<ChatConnection | "other_organization"> {
  const encryptedCredentials =
    input.credentials === null ? null : encrypt(JSON.stringify(input.credentials), key);
  const { credentials: _, ...values } = input;
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ organizationId: chatConnections.organizationId })
      .from(chatConnections)
      .where(
        and(
          eq(chatConnections.platform, input.platform),
          eq(chatConnections.externalId, input.externalId),
        ),
      )
      .for("update");
    if (owner && owner.organizationId !== input.organizationId) return "other_organization";
    // Two organizations connecting it at once: the conflict target keeps the
    // first, and the second's update is skipped by the `where` below.
    const [row] = await tx
      .insert(chatConnections)
      .values({ ...values, encryptedCredentials })
      .onConflictDoUpdate({
        target: [chatConnections.platform, chatConnections.externalId],
        set: {
          name: input.name,
          encryptedCredentials,
          installedByUserId: input.installedByUserId,
          updatedAt: new Date(),
        },
        setWhere: eq(chatConnections.organizationId, input.organizationId),
      })
      .returning();
    return row ? toChatConnection(row) : "other_organization";
  });
}

/**
 * The connection of a Slack workspace or Discord server (without
 * credentials), or null: incoming events resolve their organization from it.
 */
export async function getChatConnectionByExternalId(
  db: Database,
  platform: ChatPlatform,
  externalId: string,
): Promise<ChatConnection | null> {
  const [row] = await db
    .select()
    .from(chatConnections)
    .where(and(eq(chatConnections.platform, platform), eq(chatConnections.externalId, externalId)))
    .limit(1);
  return row ? toChatConnection(row) : null;
}

/** The connection of a workspace or server with its decrypted credentials, or null. */
export async function getChatConnectionWithCredentials<C>(
  db: Database,
  platform: ChatPlatform,
  externalId: string,
  key?: EncryptionKey,
): Promise<ChatConnectionWithCredentials<C> | null> {
  const [row] = await db
    .select()
    .from(chatConnections)
    .where(and(eq(chatConnections.platform, platform), eq(chatConnections.externalId, externalId)))
    .limit(1);
  return row ? withCredentials<C>(row, key) : null;
}

/** The organization's connections (without credentials), oldest first. */
export async function listChatConnections(
  db: Database,
  organizationId: string,
): Promise<ChatConnection[]> {
  const rows = await db
    .select()
    .from(chatConnections)
    .where(eq(chatConnections.organizationId, organizationId))
    .orderBy(asc(chatConnections.createdAt), asc(chatConnections.id));
  return rows.map(toChatConnection);
}

/**
 * Removes an organization's connection (with its threads, messages and
 * cached profiles); returns the removed row (with credentials, to revoke
 * them), or null when the organization has no such connection.
 */
export async function deleteChatConnection<C>(
  db: Database,
  organizationId: string,
  id: string,
  key?: EncryptionKey,
): Promise<ChatConnectionWithCredentials<C> | null> {
  const [row] = await db
    .delete(chatConnections)
    .where(and(eq(chatConnections.organizationId, organizationId), eq(chatConnections.id, id)))
    .returning();
  return row ? withCredentials<C>(row, key) : null;
}

/**
 * Removes the connection of a workspace or server, whichever organization has
 * it (the platform told us the app was uninstalled or the bot removed);
 * returns the removed connection, or null when none was connected.
 */
export async function deleteChatConnectionByExternalId(
  db: Database,
  platform: ChatPlatform,
  externalId: string,
): Promise<ChatConnection | null> {
  const [row] = await db
    .delete(chatConnections)
    .where(and(eq(chatConnections.platform, platform), eq(chatConnections.externalId, externalId)))
    .returning();
  return row ? toChatConnection(row) : null;
}

// ── Identities ───────────────────────────────────────────────────────────────

/** Links a chat user to a member of the organization, replacing any previous link. */
export async function linkChatIdentity(
  db: Database,
  input: LinkChatIdentityInput,
): Promise<ChatIdentity> {
  const [row] = await db
    .insert(chatIdentities)
    .values(input)
    .onConflictDoUpdate({
      target: [
        chatIdentities.organizationId,
        chatIdentities.platform,
        chatIdentities.externalUserId,
      ],
      set: { userId: input.userId, source: input.source, linkedAt: sql`now()` },
    })
    .returning();
  return row!;
}

/** The member a chat user is linked to in the organization, or null. */
export async function getChatIdentity(
  db: Database,
  organizationId: string,
  platform: ChatPlatform,
  externalUserId: string,
): Promise<ChatIdentity | null> {
  const [row] = await db
    .select()
    .from(chatIdentities)
    .where(
      and(
        eq(chatIdentities.organizationId, organizationId),
        eq(chatIdentities.platform, platform),
        eq(chatIdentities.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Removes a user's link of a chat identity; false when there was none. */
export async function unlinkChatIdentity(
  db: Database,
  userId: string,
  organizationId: string,
  platform: ChatPlatform,
  externalUserId: string,
): Promise<boolean> {
  const rows = await db
    .delete(chatIdentities)
    .where(
      and(
        eq(chatIdentities.userId, userId),
        eq(chatIdentities.organizationId, organizationId),
        eq(chatIdentities.platform, platform),
        eq(chatIdentities.externalUserId, externalUserId),
      ),
    )
    .returning({ userId: chatIdentities.userId });
  return rows.length > 0;
}

/** The chat identities linked to a user, in every organization, oldest first. */
export async function listChatIdentities(db: Database, userId: string): Promise<ChatIdentity[]> {
  return db
    .select()
    .from(chatIdentities)
    .where(eq(chatIdentities.userId, userId))
    .orderBy(asc(chatIdentities.linkedAt), asc(chatIdentities.externalUserId));
}

// ── User profiles ────────────────────────────────────────────────────────────

/** The cached profile of a chat user (check `fetchedAt` for freshness), or null. */
export async function getChatUserProfile(
  db: Database,
  connectionId: string,
  externalUserId: string,
): Promise<ChatUserProfile | null> {
  const [row] = await db
    .select()
    .from(chatUserProfiles)
    .where(
      and(
        eq(chatUserProfiles.connectionId, connectionId),
        eq(chatUserProfiles.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Caches a chat user's profile as fetched now. */
export async function saveChatUserProfile(
  db: Database,
  input: SaveChatUserProfileInput,
  now: Date = new Date(),
): Promise<ChatUserProfile> {
  const [row] = await db
    .insert(chatUserProfiles)
    .values({ ...input, fetchedAt: now })
    .onConflictDoUpdate({
      target: [chatUserProfiles.connectionId, chatUserProfiles.externalUserId],
      set: { email: input.email, displayName: input.displayName, fetchedAt: now },
    })
    .returning();
  return row!;
}

// ── Threads and messages ─────────────────────────────────────────────────────

/**
 * The connection's thread for a Chat SDK thread ID, created on first use (its
 * organization and platform are the connection's); touches `updatedAt`.
 * Null when the connection is gone.
 */
export async function ensureChatThread(
  db: Database,
  input: EnsureChatThreadInput,
): Promise<ChatThread | null> {
  const [connection] = await db
    .select({ organizationId: chatConnections.organizationId, platform: chatConnections.platform })
    .from(chatConnections)
    .where(eq(chatConnections.id, input.connectionId))
    .limit(1);
  if (!connection) return null;
  const [row] = await db
    .insert(chatThreads)
    .values({ ...input, ...connection })
    .onConflictDoUpdate({
      target: [chatThreads.connectionId, chatThreads.externalThreadId],
      set: { updatedAt: new Date() },
    })
    .returning();
  return row ?? null;
}

/** Appends a message to a thread's conversation. */
export async function appendChatMessage(
  db: Database,
  input: AppendChatMessageInput,
): Promise<ChatMessage> {
  const [row] = await db
    .insert(chatMessages)
    .values({
      threadId: input.threadId,
      role: input.role,
      externalUserId: input.externalUserId ?? null,
      authorName: input.authorName ?? null,
      content: input.content,
    })
    .returning();
  return row!;
}

/** The thread's latest `limit` messages, oldest first. */
export async function listChatMessages(
  db: Database,
  threadId: string,
  limit: number,
): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(limit);
  return rows.reverse();
}
