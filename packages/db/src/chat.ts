/**
 * Chat front door state: connected Slack workspaces and Discord servers, chat
 * users linked to members, cached chat user profiles, and the control-panel
 * agent's threads and their messages. Connection credentials are JSON
 * encrypted at rest with `encrypt()` (AES-256-GCM under `ENCRYPTION_KEY`).
 */
import { and, asc, desc, eq, gt, lte, lt, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { decrypt, encrypt } from "./crypto.js";
import {
  chatConnections,
  chatIdentities,
  chatIdentityOptOuts,
  chatLinearDelegations,
  chatLinearIssueDrafts,
  chatLinkStateUses,
  chatMessages,
  chatThreads,
  chatUserProfiles,
  organizations,
  type ChatMessageAttachment,
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
  /** The chat user's display name, for display. */
  displayName?: string | null;
}

export interface ChatIdentityWithOrganization extends ChatIdentity {
  organizationName: string;
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
  /** Files attached to a `user` message (metadata only). */
  attachments?: ChatMessageAttachment[];
  /** The ralph run posting it (a session update in the run's thread). */
  ralphRunId?: string | null;
}

export interface ChatThreadWithConnection<C> {
  thread: ChatThread;
  connection: ChatConnectionWithCredentials<C>;
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

/** An organization's connection by ID (without credentials), or null. */
export async function getChatConnection(
  db: Database,
  organizationId: string,
  id: string,
): Promise<ChatConnection | null> {
  const [row] = await db
    .select()
    .from(chatConnections)
    .where(and(eq(chatConnections.organizationId, organizationId), eq(chatConnections.id, id)))
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

/**
 * Links a chat user to a member of the organization, replacing any previous
 * link. A manual link also withdraws the chat user's opt-out of automatic
 * linking.
 */
export async function linkChatIdentity(
  db: Database,
  input: LinkChatIdentityInput,
): Promise<ChatIdentity> {
  return db.transaction((tx) => linkInTransaction(tx, input));
}

/** A single-use account-link state (`/chat/link`): its `jti` and expiry. */
export interface ChatLinkStateUse {
  id: string;
  expiresAt: Date;
}

/**
 * Links a chat identity as {@link linkChatIdentity} does, recording that the
 * link state was used in the same transaction. Null (and nothing linked)
 * when the state was used already. Uses of states expired by `now` are
 * purged.
 */
export async function linkChatIdentityWithState(
  db: Database,
  input: LinkChatIdentityInput,
  linkState: ChatLinkStateUse,
  now: Date = new Date(),
): Promise<ChatIdentity | null> {
  return db.transaction(async (tx) => {
    const used = await tx
      .insert(chatLinkStateUses)
      .values({ id: linkState.id, expiresAt: linkState.expiresAt })
      .onConflictDoNothing()
      .returning({ id: chatLinkStateUses.id });
    if (used.length === 0) return null;
    await tx.delete(chatLinkStateUses).where(lt(chatLinkStateUses.expiresAt, now));
    return linkInTransaction(tx, input);
  });
}

/** Whether the account-link state `id` was used. */
export async function isChatLinkStateUsed(db: Database, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: chatLinkStateUses.id })
    .from(chatLinkStateUses)
    .where(eq(chatLinkStateUses.id, id))
    .limit(1);
  return row !== undefined;
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function linkInTransaction(
  tx: Transaction,
  input: LinkChatIdentityInput,
): Promise<ChatIdentity> {
  const displayName = input.displayName ?? null;
  const [row] = await tx
    .insert(chatIdentities)
    .values({ ...input, displayName })
    .onConflictDoUpdate({
      target: [
        chatIdentities.organizationId,
        chatIdentities.platform,
        chatIdentities.externalUserId,
      ],
      set: {
        userId: input.userId,
        source: input.source,
        displayName: sql`coalesce(excluded.display_name, ${chatIdentities.displayName})`,
        linkedAt: sql`now()`,
      },
    })
    .returning();
  if (input.source === "manual") {
    await tx
      .delete(chatIdentityOptOuts)
      .where(
        and(
          eq(chatIdentityOptOuts.organizationId, input.organizationId),
          eq(chatIdentityOptOuts.platform, input.platform),
          eq(chatIdentityOptOuts.externalUserId, input.externalUserId),
        ),
      );
  }
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

/**
 * Removes a user's link of a chat identity and records the chat user's
 * opt-out of automatic linking by email; false when there was no such link.
 */
export async function unlinkChatIdentity(
  db: Database,
  userId: string,
  organizationId: string,
  platform: ChatPlatform,
  externalUserId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
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
    if (rows.length === 0) return false;
    await tx
      .insert(chatIdentityOptOuts)
      .values({ organizationId, platform, externalUserId })
      .onConflictDoNothing();
    return true;
  });
}

/** Whether the chat user unlinked their identity (and so is never linked automatically). */
export async function hasChatIdentityOptOut(
  db: Database,
  organizationId: string,
  platform: ChatPlatform,
  externalUserId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ createdAt: chatIdentityOptOuts.createdAt })
    .from(chatIdentityOptOuts)
    .where(
      and(
        eq(chatIdentityOptOuts.organizationId, organizationId),
        eq(chatIdentityOptOuts.platform, platform),
        eq(chatIdentityOptOuts.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The chat identities linked to a user, in every organization, oldest first. */
export async function listChatIdentities(
  db: Database,
  userId: string,
): Promise<ChatIdentityWithOrganization[]> {
  const rows = await db
    .select({ identity: chatIdentities, organizationName: organizations.name })
    .from(chatIdentities)
    .innerJoin(organizations, eq(organizations.id, chatIdentities.organizationId))
    .where(eq(chatIdentities.userId, userId))
    .orderBy(asc(chatIdentities.linkedAt), asc(chatIdentities.externalUserId));
  return rows.map((r) => ({ ...r.identity, organizationName: r.organizationName }));
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

/** A thread with its connection and the connection's decrypted credentials, or null. */
export async function getChatThreadWithConnection<C>(
  db: Database,
  id: string,
  key?: EncryptionKey,
): Promise<ChatThreadWithConnection<C> | null> {
  const [row] = await db
    .select({ thread: chatThreads, connection: chatConnections })
    .from(chatThreads)
    .innerJoin(chatConnections, eq(chatConnections.id, chatThreads.connectionId))
    .where(eq(chatThreads.id, id))
    .limit(1);
  return row ? { thread: row.thread, connection: withCredentials<C>(row.connection, key) } : null;
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
      attachments: input.attachments ?? [],
      ralphRunId: input.ralphRunId ?? null,
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

// ── Linear issue drafts ──────────────────────────────────────────────────────

export type ChatLinearIssueDraft = typeof chatLinearIssueDrafts.$inferSelect;
export type ChatLinearIssueDraftStatus = ChatLinearIssueDraft["status"];

export interface CreateChatLinearIssueDraftInput {
  threadId: string;
  requestedByUserId: string;
  requestedByExternalUserId: string;
  teamId: string;
  teamKey: string;
  title: string;
  description: string;
  projectName?: string | null;
  labels?: string[];
  priority?: number | null;
  /** Screenshots to embed in the issue. */
  attachments?: Array<ChatMessageAttachment & { ref: string }>;
  expiresAt: Date;
}

/** Stores a `pending` draft (its card isn't posted yet). */
export async function createChatLinearIssueDraft(
  db: Database,
  input: CreateChatLinearIssueDraftInput,
): Promise<ChatLinearIssueDraft> {
  const [row] = await db
    .insert(chatLinearIssueDrafts)
    .values({
      ...input,
      projectName: input.projectName ?? null,
      labels: input.labels ?? [],
      priority: input.priority ?? null,
      attachments: input.attachments ?? [],
    })
    .returning();
  return row!;
}

/** A draft by ID, or null. */
export async function getChatLinearIssueDraft(
  db: Database,
  id: string,
): Promise<ChatLinearIssueDraft | null> {
  const [row] = await db
    .select()
    .from(chatLinearIssueDrafts)
    .where(eq(chatLinearIssueDrafts.id, id))
    .limit(1);
  return row ?? null;
}

/** Records the chat message of the draft's card. */
export async function setChatLinearIssueDraftMessage(
  db: Database,
  id: string,
  externalMessageId: string,
): Promise<void> {
  await db
    .update(chatLinearIssueDrafts)
    .set({ externalMessageId, updatedAt: new Date() })
    .where(eq(chatLinearIssueDrafts.id, id));
}

/**
 * Moves a `pending` draft that hasn't expired at `now` to `creating`, so one
 * click creates it once. Null when it isn't pending or has expired.
 */
export async function claimChatLinearIssueDraft(
  db: Database,
  id: string,
  now: Date,
): Promise<ChatLinearIssueDraft | null> {
  const [row] = await db
    .update(chatLinearIssueDrafts)
    .set({ status: "creating", updatedAt: now })
    .where(
      and(
        eq(chatLinearIssueDrafts.id, id),
        eq(chatLinearIssueDrafts.status, "pending"),
        gt(chatLinearIssueDrafts.expiresAt, now),
      ),
    )
    .returning();
  return row ?? null;
}

/** A `creating` draft whose issue couldn't be created goes back to `pending`. */
export async function releaseChatLinearIssueDraft(db: Database, id: string): Promise<void> {
  await db
    .update(chatLinearIssueDrafts)
    .set({ status: "pending", updatedAt: new Date() })
    .where(and(eq(chatLinearIssueDrafts.id, id), eq(chatLinearIssueDrafts.status, "creating")));
}

/** Marks a `creating` draft `created` with its Linear issue. */
export async function completeChatLinearIssueDraft(
  db: Database,
  id: string,
  issue: { id: string; identifier: string; url: string },
): Promise<ChatLinearIssueDraft | null> {
  const [row] = await db
    .update(chatLinearIssueDrafts)
    .set({
      status: "created",
      linearIssueId: issue.id,
      linearIssueIdentifier: issue.identifier,
      linearIssueUrl: issue.url,
      updatedAt: new Date(),
    })
    .where(and(eq(chatLinearIssueDrafts.id, id), eq(chatLinearIssueDrafts.status, "creating")))
    .returning();
  return row ?? null;
}

/** Cancels a `pending` draft; null when it isn't pending. */
export async function cancelChatLinearIssueDraft(
  db: Database,
  id: string,
): Promise<ChatLinearIssueDraft | null> {
  const [row] = await db
    .update(chatLinearIssueDrafts)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(chatLinearIssueDrafts.id, id), eq(chatLinearIssueDrafts.status, "pending")))
    .returning();
  return row ?? null;
}

/** Marks a `pending` draft that expired by `now` `expired`; null otherwise. */
export async function expireChatLinearIssueDraft(
  db: Database,
  id: string,
  now: Date,
): Promise<ChatLinearIssueDraft | null> {
  const [row] = await db
    .update(chatLinearIssueDrafts)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(chatLinearIssueDrafts.id, id),
        eq(chatLinearIssueDrafts.status, "pending"),
        lte(chatLinearIssueDrafts.expiresAt, now),
      ),
    )
    .returning();
  return row ?? null;
}

// ── Linear delegations ───────────────────────────────────────────────────────

export type ChatLinearDelegation = typeof chatLinearDelegations.$inferSelect;

/** How long a delegation waits for Linear's agent session before it's ignored. */
export const CHAT_LINEAR_DELEGATION_TTL_MS = 60 * 60 * 1000;

/** A database or a transaction. */
type ChatExecutor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Records that a chat thread is delegating a Linear issue (before the delegation itself). */
export async function createChatLinearDelegation(
  db: ChatExecutor,
  input: { organizationId: string; threadId: string; linearIssueId: string },
): Promise<ChatLinearDelegation> {
  const [row] = await db.insert(chatLinearDelegations).values(input).returning();
  return row!;
}

/**
 * Takes (deletes and returns) the latest delegation of the issue made within
 * {@link CHAT_LINEAR_DELEGATION_TTL_MS} of `now`, so one session ties one run
 * to the thread. Delegations older than that (no session ever took them) are
 * pruned on the way. Null when there is none.
 */
export async function takeChatLinearDelegation(
  db: ChatExecutor,
  input: { organizationId: string; linearIssueId: string; now?: Date },
): Promise<ChatLinearDelegation | null> {
  const since = new Date((input.now ?? new Date()).getTime() - CHAT_LINEAR_DELEGATION_TTL_MS);
  await db.delete(chatLinearDelegations).where(lt(chatLinearDelegations.createdAt, since));
  const [latest] = await db
    .select({ id: chatLinearDelegations.id })
    .from(chatLinearDelegations)
    .where(
      and(
        eq(chatLinearDelegations.organizationId, input.organizationId),
        eq(chatLinearDelegations.linearIssueId, input.linearIssueId),
      ),
    )
    .orderBy(desc(chatLinearDelegations.createdAt))
    .limit(1);
  if (!latest) return null;
  // Delete every delegation of the issue: a repeated delegation shouldn't tie a later run.
  const taken = await db
    .delete(chatLinearDelegations)
    .where(
      and(
        eq(chatLinearDelegations.organizationId, input.organizationId),
        eq(chatLinearDelegations.linearIssueId, input.linearIssueId),
      ),
    )
    .returning();
  return taken.find((row) => row.id === latest.id) ?? null;
}
