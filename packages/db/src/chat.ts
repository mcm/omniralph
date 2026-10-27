/**
 * Chat front door state: connected Slack workspaces and Discord servers, chat
 * users linked to members, cached chat user profiles, and the control-panel
 * agent's threads and their messages. Connection credentials are JSON
 * encrypted at rest with `encrypt()` (AES-256-GCM under `ENCRYPTION_KEY`).
 */
import { and, asc, desc, eq, gt, inArray, isNull, lte, lt, sql } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import { decrypt, encrypt } from "./crypto.js";
import { recordConnectionChange } from "./repositories.js";
import {
  chatChannelTaskSettings,
  chatConnections,
  chatIdentities,
  chatIdentityOptOuts,
  chatLinearDelegations,
  chatLinearIssueDrafts,
  chatLinkStateUses,
  chatMessages,
  chatRunEvents,
  chatThreadRuns,
  chatThreads,
  chatUserProfiles,
  jobs,
  organizations,
  ralphRuns,
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
export type ChatThreadRun = typeof chatThreadRuns.$inferSelect;
export type ChatThreadRunKind = ChatThreadRun["kind"];
/** A thread's run: a query run's job, or a coding run. */
export type ThreadRunRef = { jobId: string } | { ralphRunId: string };
export type ChatRunEvent = typeof chatRunEvents.$inferSelect;
export type ChatRunEventKind = ChatRunEvent["kind"];

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
  /**
   * The Slack workspace or Discord server the chat user belongs to: the organization's
   * connection of that platform where the user was seen, else its only one; null when
   * that can't be told.
   */
  workspaceName: string | null;
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
    if (row) recordConnectionChange(tx, row);
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
  if (row) recordConnectionChange(db, row);
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
  if (row) recordConnectionChange(db, row);
  return row ? toChatConnection(row) : null;
}

// ── Channel playbook settings ────────────────────────────────────────────────

/**
 * Records a saved or removed channel override (the `chat_playbooks` settings section, the
 * connection its subject): Advanced › Chat channel overrides and the playbooks it names.
 */
function recordChatPlaybooksChange(db: unknown, organizationId: string, connectionId: string) {
  recordChange(db, {
    resource: "settings",
    section: "chat_playbooks",
    ids: [connectionId],
    subjectId: connectionId,
    organizationId,
  });
}

export type ChatChannelPlaybookSetting = typeof chatChannelTaskSettings.$inferSelect;

export interface UpsertChatChannelPlaybookSettingInput {
  organizationId: string;
  connectionId: string;
  channelId: string;
  /** Null keeps the organization's "ask about code" playbook. */
  askPlaybookId: string | null;
  /** Null keeps the organization's "start work" playbook. */
  startWorkPlaybookId: string | null;
  updatedBy: string | null;
}

/**
 * An organization's channel playbook overrides, by connection then channel; only
 * `connectionId`'s when given.
 */
export async function listChatChannelPlaybookSettings(
  db: Database,
  organizationId: string,
  connectionId?: string,
): Promise<ChatChannelPlaybookSetting[]> {
  return db
    .select()
    .from(chatChannelTaskSettings)
    .where(
      and(
        eq(chatChannelTaskSettings.organizationId, organizationId),
        connectionId === undefined
          ? undefined
          : eq(chatChannelTaskSettings.connectionId, connectionId),
      ),
    )
    .orderBy(asc(chatChannelTaskSettings.connectionId), asc(chatChannelTaskSettings.channelId));
}

/** An organization's playbook overrides of one channel of a connection, or null. */
export async function getChatChannelPlaybookSetting(
  db: Database,
  organizationId: string,
  connectionId: string,
  channelId: string,
): Promise<ChatChannelPlaybookSetting | null> {
  const [row] = await db
    .select()
    .from(chatChannelTaskSettings)
    .where(
      and(
        eq(chatChannelTaskSettings.organizationId, organizationId),
        eq(chatChannelTaskSettings.connectionId, connectionId),
        eq(chatChannelTaskSettings.channelId, channelId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Creates or replaces a channel's playbook overrides. Null when the connection
 * isn't one of the organization's.
 */
export async function upsertChatChannelPlaybookSetting(
  db: Database,
  input: UpsertChatChannelPlaybookSettingInput,
): Promise<ChatChannelPlaybookSetting | null> {
  return db.transaction(async (tx) => {
    const [connection] = await tx
      .select({ id: chatConnections.id })
      .from(chatConnections)
      .where(
        and(
          eq(chatConnections.organizationId, input.organizationId),
          eq(chatConnections.id, input.connectionId),
        ),
      )
      .for("share");
    if (!connection) return null;
    const [row] = await tx
      .insert(chatChannelTaskSettings)
      .values(input)
      .onConflictDoUpdate({
        target: [chatChannelTaskSettings.connectionId, chatChannelTaskSettings.channelId],
        set: {
          askPlaybookId: input.askPlaybookId,
          startWorkPlaybookId: input.startWorkPlaybookId,
          updatedBy: input.updatedBy,
          updatedAt: new Date(),
        },
        setWhere: eq(chatChannelTaskSettings.organizationId, input.organizationId),
      })
      .returning();
    if (row) recordChatPlaybooksChange(tx, input.organizationId, input.connectionId);
    return row ?? null;
  });
}

/** Removes a channel's playbook overrides; false when the organization has none for it. */
export async function deleteChatChannelPlaybookSetting(
  db: Database,
  organizationId: string,
  connectionId: string,
  channelId: string,
): Promise<boolean> {
  const removed = await db
    .delete(chatChannelTaskSettings)
    .where(
      and(
        eq(chatChannelTaskSettings.organizationId, organizationId),
        eq(chatChannelTaskSettings.connectionId, connectionId),
        eq(chatChannelTaskSettings.channelId, channelId),
      ),
    )
    .returning({ id: chatChannelTaskSettings.id });
  if (removed.length > 0) recordChatPlaybooksChange(db, organizationId, connectionId);
  return removed.length > 0;
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
  const [previous] = await tx
    .select({ userId: chatIdentities.userId })
    .from(chatIdentities)
    .where(
      and(
        eq(chatIdentities.organizationId, input.organizationId),
        eq(chatIdentities.platform, input.platform),
        eq(chatIdentities.externalUserId, input.externalUserId),
      ),
    )
    .limit(1);
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
  recordLinkedAccountsChange(tx, input.userId, input.organizationId);
  // A link replacing another member's: their list loses it.
  if (previous && previous.userId !== input.userId) {
    recordLinkedAccountsChange(tx, previous.userId, input.organizationId);
  }
  return row!;
}

/**
 * Records that `userId`'s linked chat accounts changed (Settings › Linked chat accounts):
 * a `settings` change of section `linked_accounts` on the user's own channel.
 */
function recordLinkedAccountsChange(db: unknown, userId: string, organizationId: string): void {
  recordChange(db, {
    resource: "settings",
    section: "linked_accounts",
    ids: [userId],
    organizationId,
    userId,
  });
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
    recordLinkedAccountsChange(tx, userId, organizationId);
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
  if (rows.length === 0) return [];
  const connections = await db
    .select({
      id: chatConnections.id,
      organizationId: chatConnections.organizationId,
      platform: chatConnections.platform,
      name: chatConnections.name,
    })
    .from(chatConnections)
    .where(
      inArray(chatConnections.organizationId, [
        ...new Set(rows.map((r) => r.identity.organizationId)),
      ]),
    );
  const profiles =
    connections.length === 0
      ? []
      : await db
          .select({
            connectionId: chatUserProfiles.connectionId,
            externalUserId: chatUserProfiles.externalUserId,
          })
          .from(chatUserProfiles)
          .where(
            and(
              inArray(
                chatUserProfiles.connectionId,
                connections.map((c) => c.id),
              ),
              inArray(chatUserProfiles.externalUserId, [
                ...new Set(rows.map((r) => r.identity.externalUserId)),
              ]),
            ),
          );
  const seen = new Set(profiles.map((p) => `${p.connectionId}:${p.externalUserId}`));
  return rows.map(({ identity, organizationName }) => {
    const candidates = connections.filter(
      (c) => c.organizationId === identity.organizationId && c.platform === identity.platform,
    );
    const workspace =
      candidates.find((c) => seen.has(`${c.id}:${identity.externalUserId}`)) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    return { ...identity, organizationName, workspaceName: workspace?.name ?? null };
  });
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

/** A thread by ID (of any organization: callers scope by its connection), or null. */
export async function getChatThread(db: ChatExecutor, id: string): Promise<ChatThread | null> {
  const [row] = await db.select().from(chatThreads).where(eq(chatThreads.id, id)).limit(1);
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

// ── Thread runs ──────────────────────────────────────────────────────────────

const runCondition = (ref: ThreadRunRef) =>
  "jobId" in ref
    ? eq(chatThreadRuns.jobId, ref.jobId)
    : eq(chatThreadRuns.ralphRunId, ref.ralphRunId);

/**
 * Records that a run (a query run's job, or a coding run) belongs to a
 * thread, and links a query run's job to it (`jobs.chat_thread_run_id`).
 * Idempotent: a run already mapped keeps its thread, and that row is
 * returned. Null when the thread or the run isn't the organization's.
 */
export async function mapThreadRun(
  db: ChatExecutor,
  input: { organizationId: string; chatThreadId: string } & ThreadRunRef,
): Promise<ChatThreadRun | null> {
  const { organizationId, chatThreadId } = input;
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, chatThreadId), eq(chatThreads.organizationId, organizationId)))
    .limit(1);
  if (!thread) return null;
  const [run] =
    "jobId" in input
      ? await db
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.id, input.jobId), eq(jobs.organizationId, organizationId)))
          .limit(1)
      : await db
          .select({ id: ralphRuns.id })
          .from(ralphRuns)
          .where(
            and(eq(ralphRuns.id, input.ralphRunId), eq(ralphRuns.organizationId, organizationId)),
          )
          .limit(1);
  if (!run) return null;
  const ref: ThreadRunRef =
    "jobId" in input ? { jobId: input.jobId } : { ralphRunId: input.ralphRunId };
  const [row] = await db
    .insert(chatThreadRuns)
    .values({
      organizationId,
      chatThreadId,
      ...("jobId" in ref
        ? { kind: "query" as const, jobId: ref.jobId }
        : { kind: "coding" as const, ralphRunId: ref.ralphRunId }),
    })
    .onConflictDoNothing()
    .returning();
  const [mapped] = row
    ? [row]
    : await db
        .select()
        .from(chatThreadRuns)
        .where(and(runCondition(ref), eq(chatThreadRuns.organizationId, organizationId)))
        .limit(1);
  if (mapped?.jobId) {
    await db.update(jobs).set({ chatThreadRunId: mapped.id }).where(eq(jobs.id, mapped.jobId));
  }
  // A new ask run (a coding run's own change is its ralph run's).
  if (row?.kind === "query") {
    recordChange(db, { resource: "run", ids: [row.id], runId: row.id, organizationId });
  }
  return mapped ?? null;
}

/**
 * Points an ask (a `query` thread run) at its newest attempt, `jobId` (a retry of its last
 * one), and links the job to it, so the attempt's answer is relayed to the same thread
 * (`threadRunOf`). Null when the run isn't one of the organization's asks.
 */
export async function setThreadRunJob(
  db: ChatExecutor,
  input: { organizationId: string; chatThreadRunId: string; jobId: string },
): Promise<ChatThreadRun | null> {
  const [row] = await db
    .update(chatThreadRuns)
    .set({ jobId: input.jobId })
    .where(
      and(
        eq(chatThreadRuns.id, input.chatThreadRunId),
        eq(chatThreadRuns.organizationId, input.organizationId),
        eq(chatThreadRuns.kind, "query"),
      ),
    )
    .returning();
  if (!row) return null;
  await db.update(jobs).set({ chatThreadRunId: row.id }).where(eq(jobs.id, input.jobId));
  recordChange(db, {
    resource: "run",
    ids: [row.id],
    runId: row.id,
    organizationId: row.organizationId,
  });
  return row;
}

/** The organization's thread's runs, oldest first. */
export async function listThreadRuns(
  db: ChatExecutor,
  organizationId: string,
  threadId: string,
): Promise<ChatThreadRun[]> {
  return db
    .select()
    .from(chatThreadRuns)
    .where(
      and(
        eq(chatThreadRuns.organizationId, organizationId),
        eq(chatThreadRuns.chatThreadId, threadId),
      ),
    )
    .orderBy(asc(chatThreadRuns.createdAt), asc(chatThreadRuns.id));
}

/** The organization's thread's latest run (of `kind`, if given), or null. */
export async function latestThreadRun(
  db: ChatExecutor,
  organizationId: string,
  threadId: string,
  kind?: ChatThreadRunKind,
): Promise<ChatThreadRun | null> {
  const [row] = await db
    .select()
    .from(chatThreadRuns)
    .where(
      and(
        eq(chatThreadRuns.organizationId, organizationId),
        eq(chatThreadRuns.chatThreadId, threadId),
        kind ? eq(chatThreadRuns.kind, kind) : undefined,
      ),
    )
    .orderBy(desc(chatThreadRuns.createdAt), desc(chatThreadRuns.id))
    .limit(1);
  return row ?? null;
}

/** The organization's thread a run belongs to, or null. */
export async function threadOfRun(
  db: ChatExecutor,
  organizationId: string,
  ref: ThreadRunRef,
): Promise<ChatThread | null> {
  const [row] = await db
    .select({ thread: chatThreads })
    .from(chatThreadRuns)
    .innerJoin(chatThreads, eq(chatThreads.id, chatThreadRuns.chatThreadId))
    .where(and(runCondition(ref), eq(chatThreadRuns.organizationId, organizationId)))
    .limit(1);
  return row?.thread ?? null;
}

/** The organization's mapping of a run to its thread, or null. */
export async function threadRunOf(
  db: ChatExecutor,
  organizationId: string,
  ref: ThreadRunRef,
): Promise<ChatThreadRun | null> {
  const [row] = await db
    .select()
    .from(chatThreadRuns)
    .where(and(runCondition(ref), eq(chatThreadRuns.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

// ── Run events ───────────────────────────────────────────────────────────────

export interface RecordRunEventInput {
  organizationId: string;
  /** The run's mapping to its thread (`threadRunOf`). */
  threadRun: Pick<ChatThreadRun, "id" | "chatThreadId" | "organizationId">;
  kind: ChatRunEventKind;
  body: Record<string, unknown>;
  /** Identifies the event: recording the same key again does nothing. */
  idempotencyKey: string;
}

/**
 * Stores an event a mapped run has for its thread (for the chat responder to
 * relay). Idempotent per `idempotencyKey`: `created` is false when the event
 * was already recorded, or the mapping isn't the organization's.
 */
export async function recordRunEvent(
  db: ChatExecutor,
  input: RecordRunEventInput,
): Promise<{ created: boolean; event: ChatRunEvent | null }> {
  if (input.threadRun.organizationId !== input.organizationId) {
    return { created: false, event: null };
  }
  const [row] = await db
    .insert(chatRunEvents)
    .values({
      organizationId: input.organizationId,
      chatThreadId: input.threadRun.chatThreadId,
      threadRunId: input.threadRun.id,
      kind: input.kind,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({ target: chatRunEvents.idempotencyKey })
    .returning();
  return { created: row !== undefined, event: row ?? null };
}

/** The organization's thread's run events, oldest first (only unprocessed ones with `pending`). */
export async function listRunEvents(
  db: ChatExecutor,
  organizationId: string,
  threadId: string,
  options: { pending?: boolean } = {},
): Promise<ChatRunEvent[]> {
  return db
    .select()
    .from(chatRunEvents)
    .where(
      and(
        eq(chatRunEvents.organizationId, organizationId),
        eq(chatRunEvents.chatThreadId, threadId),
        options.pending ? isNull(chatRunEvents.processedAt) : undefined,
      ),
    )
    .orderBy(asc(chatRunEvents.createdAt), asc(chatRunEvents.id));
}

/**
 * Marks the organization's run events processed (relayed by the chat
 * responder, or deliberately left unsaid). Events processed already keep
 * their time; returns the number marked.
 */
export async function markRunEventsProcessed(
  db: ChatExecutor,
  organizationId: string,
  ids: readonly string[],
  at: Date = new Date(),
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(chatRunEvents)
    .set({ processedAt: at })
    .where(
      and(
        eq(chatRunEvents.organizationId, organizationId),
        inArray(chatRunEvents.id, [...ids]),
        isNull(chatRunEvents.processedAt),
      ),
    )
    .returning({ id: chatRunEvents.id });
  return rows.length;
}

/** Counts a failed attempt at relaying the organization's (still pending) run events. */
export async function recordRunEventAttempt(
  db: ChatExecutor,
  organizationId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(chatRunEvents)
    .set({ attempts: sql`${chatRunEvents.attempts} + 1` })
    .where(
      and(
        eq(chatRunEvents.organizationId, organizationId),
        inArray(chatRunEvents.id, [...ids]),
        isNull(chatRunEvents.processedAt),
      ),
    );
}

/**
 * The threads (of every organization) with a pending run event recorded
 * before `createdBefore` that was tried fewer than `maxAttempts` times: the
 * wake-ups the cron catches up on.
 */
export async function listThreadsWithPendingRunEvents(
  db: ChatExecutor,
  options: { createdBefore: Date; maxAttempts: number },
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ chatThreadId: chatRunEvents.chatThreadId })
    .from(chatRunEvents)
    .where(
      and(
        isNull(chatRunEvents.processedAt),
        lt(chatRunEvents.createdAt, options.createdBefore),
        lt(chatRunEvents.attempts, options.maxAttempts),
      ),
    );
  return rows.map((r) => r.chatThreadId);
}

/**
 * Whether any run event (of any organization, however recent) is still
 * pending and was tried fewer than `maxAttempts` times: the cron's check
 * before it lets its Redis marker go.
 */
export async function hasPendingRunEvents(
  db: ChatExecutor,
  options: { maxAttempts: number },
): Promise<boolean> {
  const [row] = await db
    .select({ id: chatRunEvents.id })
    .from(chatRunEvents)
    .where(and(isNull(chatRunEvents.processedAt), lt(chatRunEvents.attempts, options.maxAttempts)))
    .limit(1);
  return row !== undefined;
}

/**
 * Who asked for a mapped run: the author of the thread's last user message
 * before the run was mapped (the message the responder answered by starting
 * it), or else whoever started the thread. Null when the mapping isn't the
 * organization's.
 */
export async function runRequester(
  db: ChatExecutor,
  organizationId: string,
  threadRun: Pick<ChatThreadRun, "chatThreadId" | "createdAt">,
): Promise<{ externalUserId: string; authorName: string | null } | null> {
  const [thread] = await db
    .select({ startedBy: chatThreads.startedByExternalUserId })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, threadRun.chatThreadId),
        eq(chatThreads.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!thread) return null;
  const [message] = await db
    .select({ externalUserId: chatMessages.externalUserId, authorName: chatMessages.authorName })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadRun.chatThreadId),
        eq(chatMessages.role, "user"),
        lte(chatMessages.createdAt, threadRun.createdAt),
        sql`${chatMessages.externalUserId} is not null`,
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);
  if (message?.externalUserId) {
    return { externalUserId: message.externalUserId, authorName: message.authorName };
  }
  return thread.startedBy ? { externalUserId: thread.startedBy, authorName: null } : null;
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
