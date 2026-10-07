/**
 * Code-host connections and connected repositories, as managed from the
 * control panel's Repositories page. Connection credentials are JSON encrypted
 * with `encrypt()` (AES-256-GCM under `ENCRYPTION_KEY`).
 */
import { and, asc, count, eq, inArray, isNull, max, sql } from "drizzle-orm";
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
  organizationId: string;
  provider: ScmProvider;
  name: string;
  baseUrl: string;
  /** GitHub App installation ID, or the GitLab token user's ID. */
  externalId: string;
  credentials: Record<string, unknown>;
  createdBy?: string | null;
}

/**
 * Creates the connection, or updates name and credentials of the one with the same
 * provider, base URL and external ID. A connection belongs to one organization:
 * returns null (and changes nothing) when that one belongs to another organization.
 */
export async function upsertScmConnection(
  db: Database,
  input: ScmConnectionInput,
  key?: EncryptionKey,
): Promise<ScmConnection | null> {
  const encryptedCredentials = encrypt(JSON.stringify(input.credentials), key);
  const [row] = await db
    .insert(scmConnections)
    .values({
      organizationId: input.organizationId,
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
      setWhere: eq(scmConnections.organizationId, input.organizationId),
    })
    .returning();
  return row ?? null;
}

/** An organization's connection, or null. */
export async function getScmConnection(
  db: Database,
  organizationId: string,
  id: string,
): Promise<ScmConnection | null> {
  const [row] = await db
    .select()
    .from(scmConnections)
    .where(and(eq(scmConnections.id, id), eq(scmConnections.organizationId, organizationId)))
    .limit(1);
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

/** Connections of `provider` with this external ID on any instance, e.g. a GitHub App installation. */
export async function findScmConnectionsByExternalId(
  db: Database,
  provider: ScmProvider,
  externalId: string,
): Promise<ScmConnection[]> {
  return db
    .select()
    .from(scmConnections)
    .where(and(eq(scmConnections.provider, provider), eq(scmConnections.externalId, externalId)));
}

/**
 * Removes an organization's connection together with its repositories (and, through them,
 * their reviews, rules, agent pins and ralph runs), so the same installation or token user
 * can be connected again, from any organization. Returns the removed connection, or null
 * when the organization has no such connection.
 */
export async function deleteScmConnection(
  db: Database,
  organizationId: string,
  id: string,
): Promise<ScmConnection | null> {
  const [row] = await db
    .delete(scmConnections)
    .where(and(eq(scmConnections.id, id), eq(scmConnections.organizationId, organizationId)))
    .returning();
  return row ?? null;
}

/** An organization's connections (of `provider`), by name. */
export async function listScmConnections(
  db: Database,
  organizationId: string,
  provider?: ScmProvider,
): Promise<ScmConnection[]> {
  return db
    .select()
    .from(scmConnections)
    .where(
      and(
        eq(scmConnections.organizationId, organizationId),
        provider ? eq(scmConnections.provider, provider) : undefined,
      ),
    )
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
 * The repository belongs to its connection's organization.
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
      organizationId: sql`(select ${scmConnections.organizationId} from ${scmConnections} where ${scmConnections.id} = ${input.connectionId})`,
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

/**
 * A repository, or null. With `organizationId`, only one of that organization (pass it
 * whenever a user asks for the repository).
 */
export async function getRepository(
  db: Database,
  id: string,
  organizationId?: string,
): Promise<Repository | null> {
  const [row] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.id, id), inOrganization(organizationId)))
    .limit(1);
  return row ?? null;
}

function inOrganization(organizationId: string | undefined) {
  return organizationId === undefined ? undefined : eq(repositories.organizationId, organizationId);
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

/**
 * Enables or disables reviews for a connected repository of the organization. Returns
 * false if it has no such repository or it's disconnected.
 */
export async function setRepositoryEnabled(
  db: Database,
  organizationId: string,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const rows = await db
    .update(repositories)
    .set({ enabled })
    .where(
      and(
        eq(repositories.id, id),
        eq(repositories.organizationId, organizationId),
        isNull(repositories.disconnectedAt),
      ),
    )
    .returning({ id: repositories.id });
  return rows.length > 0;
}

/**
 * Disconnects a repository of the organization: disables it, removes its agent pins and
 * forgets its webhook. The row (and so its reviews, findings and rules) is kept.
 */
export async function disconnectRepository(
  db: Database,
  organizationId: string,
  id: string,
  now = new Date(),
): Promise<Repository | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(repositories)
      .set({ enabled: false, disconnectedAt: now, webhookId: null })
      .where(and(eq(repositories.id, id), eq(repositories.organizationId, organizationId)))
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

/** Repositories per page of the Repositories list. */
export const REPOSITORY_PAGE_SIZE = 25;

export interface RepositoryOverviewPage {
  repositories: RepositoryOverview[];
  /** Connected repositories across all pages. */
  total: number;
  /** The page returned (1-based). */
  page: number;
  pageSize: number;
}

const overviewColumns = {
  id: repositories.id,
  provider: repositories.provider,
  fullPath: repositories.fullPath,
  enabled: repositories.enabled,
  connectionId: repositories.connectionId,
  connectionName: scmConnections.name,
  baseUrl: scmConnections.baseUrl,
  profileId: repositories.profileId,
  profileName: reviewProfiles.name,
};

function connectedIn(organizationId: string) {
  return and(eq(repositories.organizationId, organizationId), isNull(repositories.disconnectedAt));
}

function overviewQuery(db: Database, organizationId: string) {
  return db
    .select(overviewColumns)
    .from(repositories)
    .innerJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
    .innerJoin(
      reviewProfiles,
      and(
        eq(reviewProfiles.organizationId, repositories.organizationId),
        eq(reviewProfiles.id, repositories.profileId),
      ),
    )
    .where(connectedIn(organizationId))
    .orderBy(asc(repositories.fullPath), asc(repositories.id))
    .$dynamic();
}

type OverviewRow = Omit<RepositoryOverview, "pinnedAgents" | "lastReviewAt">;

async function withPinsAndLastReview(
  db: Database,
  rows: OverviewRow[],
): Promise<RepositoryOverview[]> {
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

/** The organization's connected (not disconnected) repositories with their profile, pins and latest review. */
export async function listRepositoryOverview(
  db: Database,
  organizationId: string,
): Promise<RepositoryOverview[]> {
  return withPinsAndLastReview(db, await overviewQuery(db, organizationId));
}

/**
 * One page of `listRepositoryOverview`, ordered by path. A page past the last
 * one comes back empty (with the real `total`).
 */
export async function listRepositoryOverviewPage(
  db: Database,
  organizationId: string,
  options: { page?: number; pageSize?: number } = {},
): Promise<RepositoryOverviewPage> {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? REPOSITORY_PAGE_SIZE));
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const [[totalRow], rows] = await Promise.all([
    db.select({ total: count() }).from(repositories).where(connectedIn(organizationId)),
    overviewQuery(db, organizationId)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  ]);
  return {
    repositories: await withPinsAndLastReview(db, rows),
    total: totalRow?.total ?? 0,
    page,
    pageSize,
  };
}

export type PinRepositoryResult =
  "pinned" | "already_pinned" | "unknown_agent" | "unknown_repository";

/**
 * Pins a connected repository to an agent: its jobs then go to that agent's
 * topic (see `pinnedAgentFor`). Revoked agents, disconnected repositories and
 * agents of another organization than the repository's can't be pinned.
 */
export async function pinRepositoryToAgent(
  db: Database,
  input: { agentId: string; repositoryId: string },
): Promise<PinRepositoryResult> {
  return db.transaction(async (tx) => {
    const [repo] = await tx
      .select({ organizationId: repositories.organizationId })
      .from(repositories)
      .where(and(eq(repositories.id, input.repositoryId), isNull(repositories.disconnectedAt)))
      .limit(1);
    if (!repo) return "unknown_repository";
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, input.agentId),
          eq(agents.organizationId, repo.organizationId),
          isNull(agents.revokedAt),
        ),
      )
      .limit(1);
    if (!agent) return "unknown_agent";
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

/**
 * A repository together with its connection (null if either is unknown). With
 * `organizationId`, only a repository of that organization.
 */
export async function getRepositoryWithConnection(
  db: Database,
  id: string,
  organizationId?: string,
): Promise<{ repository: Repository; connection: ScmConnection } | null> {
  const [row] = await db
    .select({ repository: repositories, connection: scmConnections })
    .from(repositories)
    .innerJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
    .where(and(eq(repositories.id, id), inOrganization(organizationId)))
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
