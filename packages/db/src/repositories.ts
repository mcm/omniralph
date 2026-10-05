/**
 * Code-host connections and connected repositories, as managed from the
 * control panel's Repositories page. Connection credentials are JSON encrypted
 * with `encrypt()` (AES-256-GCM under `ENCRYPTION_KEY`).
 */
import { and, asc, eq, inArray, isNull, max } from "drizzle-orm";
import type { Database } from "./client.js";
import { decrypt, encrypt } from "./crypto.js";
import {
  agentRepoPins,
  agents,
  repositories,
  reviewProfiles,
  reviews,
  scmConnections,
} from "./schema.js";

type EncryptionKey = string | Buffer | undefined;
export type ScmProvider = (typeof scmConnections.$inferSelect)["provider"];
export type ScmConnection = typeof scmConnections.$inferSelect;
export type Repository = typeof repositories.$inferSelect;

export interface ScmConnectionInput {
  provider: ScmProvider;
  name: string;
  baseUrl: string;
  /** GitHub App installation ID, or the GitLab token user's ID. */
  externalId: string;
  credentials: Record<string, unknown>;
  createdBy?: string | null;
}

/** Creates the connection, or updates name and credentials of the one with the same provider, base URL and external ID. */
export async function upsertScmConnection(
  db: Database,
  input: ScmConnectionInput,
  key?: EncryptionKey,
): Promise<ScmConnection> {
  const encryptedCredentials = encrypt(JSON.stringify(input.credentials), key);
  const [row] = await db
    .insert(scmConnections)
    .values({
      provider: input.provider,
      name: input.name,
      baseUrl: input.baseUrl,
      externalId: input.externalId,
      encryptedCredentials,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoUpdate({
      target: [scmConnections.provider, scmConnections.baseUrl, scmConnections.externalId],
      set: { name: input.name, encryptedCredentials },
    })
    .returning();
  if (!row) throw new Error("Failed to save SCM connection");
  return row;
}

export async function getScmConnection(db: Database, id: string): Promise<ScmConnection | null> {
  const [row] = await db.select().from(scmConnections).where(eq(scmConnections.id, id)).limit(1);
  return row ?? null;
}

export async function findScmConnection(
  db: Database,
  provider: ScmProvider,
  baseUrl: string,
  externalId: string,
): Promise<ScmConnection | null> {
  const [row] = await db
    .select()
    .from(scmConnections)
    .where(
      and(
        eq(scmConnections.provider, provider),
        eq(scmConnections.baseUrl, baseUrl),
        eq(scmConnections.externalId, externalId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listScmConnections(
  db: Database,
  provider?: ScmProvider,
): Promise<ScmConnection[]> {
  return db
    .select()
    .from(scmConnections)
    .where(provider ? eq(scmConnections.provider, provider) : undefined)
    .orderBy(asc(scmConnections.name));
}

/** Decrypts a connection's credentials JSON. */
export function connectionCredentials<T extends Record<string, unknown>>(
  connection: Pick<ScmConnection, "encryptedCredentials">,
  key?: EncryptionKey,
): T {
  return JSON.parse(decrypt(connection.encryptedCredentials, key)) as T;
}

export interface ConnectRepositoryInput {
  connectionId: string;
  provider: ScmProvider;
  externalId: string;
  fullPath: string;
  webhookId?: string | null;
}

/**
 * Connects (or reconnects) a repository: creates it, or re-enables an existing row for the
 * same connection and external ID (clearing `disconnectedAt`) so its history carries over.
 */
export async function connectRepository(
  db: Database,
  input: ConnectRepositoryInput,
): Promise<Repository> {
  const set = {
    fullPath: input.fullPath,
    enabled: true,
    disconnectedAt: null,
    ...(input.webhookId !== undefined ? { webhookId: input.webhookId } : {}),
  };
  const [row] = await db
    .insert(repositories)
    .values({
      connectionId: input.connectionId,
      provider: input.provider,
      externalId: input.externalId,
      ...set,
    })
    .onConflictDoUpdate({ target: [repositories.connectionId, repositories.externalId], set })
    .returning();
  if (!row) throw new Error("Failed to save repository");
  return row;
}

export async function getRepository(db: Database, id: string): Promise<Repository | null> {
  const [row] = await db.select().from(repositories).where(eq(repositories.id, id)).limit(1);
  return row ?? null;
}

/** Repositories of a connection, including disconnected ones. */
export async function listConnectionRepositories(
  db: Database,
  connectionId: string,
): Promise<Repository[]> {
  return db
    .select()
    .from(repositories)
    .where(eq(repositories.connectionId, connectionId))
    .orderBy(asc(repositories.fullPath));
}

/** Enables or disables reviews for a connected repository. Returns false if it's unknown or disconnected. */
export async function setRepositoryEnabled(
  db: Database,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const rows = await db
    .update(repositories)
    .set({ enabled })
    .where(and(eq(repositories.id, id), isNull(repositories.disconnectedAt)))
    .returning({ id: repositories.id });
  return rows.length > 0;
}

/**
 * Disconnects a repository: disables it, removes its agent pins and forgets its webhook.
 * The row (and so its reviews, findings and rules) is kept.
 */
export async function disconnectRepository(
  db: Database,
  id: string,
  now = new Date(),
): Promise<Repository | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(repositories)
      .set({ enabled: false, disconnectedAt: now, webhookId: null })
      .where(eq(repositories.id, id))
      .returning();
    if (!row) return null;
    await tx.delete(agentRepoPins).where(eq(agentRepoPins.repositoryId, id));
    return row;
  });
}

export interface RepositoryOverview {
  id: string;
  provider: ScmProvider;
  fullPath: string;
  enabled: boolean;
  connectionId: string;
  connectionName: string;
  /** Instance URL (GitLab) or API URL (GitHub). */
  baseUrl: string;
  profileId: string;
  profileName: string;
  pinnedAgents: { id: string; name: string }[];
  lastReviewAt: Date | null;
}

/** Connected (not disconnected) repositories with their profile, pins and latest review. */
export async function listRepositoryOverview(db: Database): Promise<RepositoryOverview[]> {
  const rows = await db
    .select({
      id: repositories.id,
      provider: repositories.provider,
      fullPath: repositories.fullPath,
      enabled: repositories.enabled,
      connectionId: repositories.connectionId,
      connectionName: scmConnections.name,
      baseUrl: scmConnections.baseUrl,
      profileId: repositories.profileId,
      profileName: reviewProfiles.name,
    })
    .from(repositories)
    .innerJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
    .innerJoin(reviewProfiles, eq(reviewProfiles.id, repositories.profileId))
    .where(isNull(repositories.disconnectedAt))
    .orderBy(asc(repositories.fullPath));
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const [pins, lastReviews] = await Promise.all([
    db
      .select({ repositoryId: agentRepoPins.repositoryId, id: agents.id, name: agents.name })
      .from(agentRepoPins)
      .innerJoin(agents, eq(agents.id, agentRepoPins.agentId))
      .where(inArray(agentRepoPins.repositoryId, ids))
      .orderBy(asc(agents.name)),
    db
      .select({ repositoryId: reviews.repositoryId, at: max(reviews.createdAt) })
      .from(reviews)
      .where(inArray(reviews.repositoryId, ids))
      .groupBy(reviews.repositoryId),
  ]);

  const pinsByRepo = new Map<string, { id: string; name: string }[]>();
  for (const pin of pins) {
    const list = pinsByRepo.get(pin.repositoryId) ?? [];
    list.push({ id: pin.id, name: pin.name });
    pinsByRepo.set(pin.repositoryId, list);
  }
  const lastReviewByRepo = new Map(lastReviews.map((r) => [r.repositoryId, r.at]));
  return rows.map((row) => ({
    ...row,
    pinnedAgents: pinsByRepo.get(row.id) ?? [],
    lastReviewAt: lastReviewByRepo.get(row.id) ?? null,
  }));
}

export type PinRepositoryResult =
  "pinned" | "already_pinned" | "unknown_agent" | "unknown_repository";

/**
 * Pins a connected repository to an agent: its jobs then go to that agent's
 * topic (see `pinnedAgentFor`). Revoked agents and disconnected repositories
 * can't be pinned.
 */
export async function pinRepositoryToAgent(
  db: Database,
  input: { agentId: string; repositoryId: string },
): Promise<PinRepositoryResult> {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), isNull(agents.revokedAt)))
      .limit(1);
    if (!agent) return "unknown_agent";
    const [repo] = await tx
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.id, input.repositoryId), isNull(repositories.disconnectedAt)))
      .limit(1);
    if (!repo) return "unknown_repository";
    const inserted = await tx
      .insert(agentRepoPins)
      .values({ agentId: input.agentId, repositoryId: input.repositoryId })
      .onConflictDoNothing()
      .returning({ id: agentRepoPins.id });
    return inserted.length > 0 ? "pinned" : "already_pinned";
  });
}

/** Removes a pin. Returns false if there was none. */
export async function unpinRepositoryFromAgent(
  db: Database,
  input: { agentId: string; repositoryId: string },
): Promise<boolean> {
  const rows = await db
    .delete(agentRepoPins)
    .where(
      and(
        eq(agentRepoPins.agentId, input.agentId),
        eq(agentRepoPins.repositoryId, input.repositoryId),
      ),
    )
    .returning({ id: agentRepoPins.id });
  return rows.length > 0;
}

/** A repository together with its connection (null if either is unknown). */
export async function getRepositoryWithConnection(
  db: Database,
  id: string,
): Promise<{ repository: Repository; connection: ScmConnection } | null> {
  const [row] = await db
    .select({ repository: repositories, connection: scmConnections })
    .from(repositories)
    .innerJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
    .where(eq(repositories.id, id))
    .limit(1);
  return row ?? null;
}

/** Repositories (with their connection) of a provider-side repository/project ID, across connections. */
export async function findRepositoriesByExternalId(
  db: Database,
  provider: ScmProvider,
  externalId: string,
): Promise<{ repository: Repository; connection: ScmConnection }[]> {
  return db
    .select({ repository: repositories, connection: scmConnections })
    .from(repositories)
    .innerJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
    .where(and(eq(repositories.provider, provider), eq(repositories.externalId, externalId)))
    .orderBy(asc(repositories.createdAt));
}
