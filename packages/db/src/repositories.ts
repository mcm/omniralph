/**
 * Code-host connections and connected repositories, as managed from the
 * control panel's Repositories page. Connection credentials are JSON encrypted
 * with `encrypt()` (AES-256-GCM under `ENCRYPTION_KEY`).
 */
import { and, asc, count, eq, ilike, inArray, isNull, max, or, sql } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import { decrypt, encrypt } from "./crypto.js";
import {
  agentRepoPins,
  agents,
  repositories,
  reviews,
  scmConnections,
  workItemMatches,
  type ScmConnectionHealth,
} from "./schema.js";

type EncryptionKey = string | Buffer | undefined;
export type ScmProvider = (typeof scmConnections.$inferSelect)["provider"];
export type ScmConnection = typeof scmConnections.$inferSelect;
export type Repository = typeof repositories.$inferSelect;

/**
 * A repository's switches: which task types it runs. Reviews (`reviews_enabled`), Coding
 * (`coding_enabled`) and Ask (`ask_enabled`: externally triggered queries such as mentions,
 * chat and triage). None of them inherits from anything.
 */
export interface RepositorySwitches {
  reviews: boolean;
  coding: boolean;
  ask: boolean;
}

/** A repository's switches as `RepositorySwitches`. */
export function repositorySwitches(
  repository: Pick<Repository, "reviewsEnabled" | "codingEnabled" | "askEnabled">,
): RepositorySwitches {
  return {
    reviews: repository.reviewsEnabled,
    coding: repository.codingEnabled,
    ask: repository.askEnabled,
  };
}

/**
 * Thrown when a save would leave a repository with Coding on and no work item match: turning
 * Coding on for a repository without one (`turn_on_coding`), or removing the match of a
 * repository whose Coding is on (`remove_match`). Nothing is saved.
 */
export class WorkItemMatchRequiredError extends Error {
  constructor(
    readonly action: "turn_on_coding" | "remove_match",
    readonly repositoryId: string,
  ) {
    super(
      action === "turn_on_coding"
        ? `Repository ${repositoryId} has no work item match to turn Coding on with`
        : `Repository ${repositoryId} has Coding on, so its work item match can't be removed`,
    );
    this.name = "WorkItemMatchRequiredError";
  }
}

/**
 * A SQL condition that a repository may have Coding on: it already does (a repository that had
 * Coding on before work item matches keeps it until switched off), or it has a work item match.
 */
export function codingMayBeOn() {
  return or(
    eq(repositories.codingEnabled, true),
    sql`exists (select 1 from ${workItemMatches} where ${workItemMatches.repositoryId} = ${repositories.id})`,
  );
}

export interface ScmConnectionInput {
  organizationId: string;
  provider: ScmProvider;
  name: string;
  baseUrl: string;
  /** GitHub App installation ID, or the GitLab token user's ID. */
  externalId: string;
  credentials: Record<string, unknown>;
  /** GitLab: the token user's username (the bot's `@` handle). */
  botUsername?: string | null;
  createdBy?: string | null;
}

/**
 * Creates the connection, or updates name, credentials and bot username of the one with the same
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
      botUsername: input.botUsername ?? null,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoUpdate({
      target: [scmConnections.provider, scmConnections.baseUrl, scmConnections.externalId],
      set: { name: input.name, encryptedCredentials, botUsername: input.botUsername ?? null },
      setWhere: eq(scmConnections.organizationId, input.organizationId),
    })
    .returning();
  if (row) recordConnectionChange(db, row);
  return row ?? null;
}

/** Records a live `connection` change (a code host, tracker or chat connection). */
export function recordConnectionChange(
  db: unknown,
  connection: { id: string; organizationId: string },
): void {
  recordChange(db, {
    resource: "connection",
    ids: [connection.id],
    organizationId: connection.organizationId,
  });
}

/** Records a live `repository` change. */
function recordRepositoryChange(
  db: unknown,
  repository: { id: string; organizationId: string },
): void {
  recordChange(db, {
    resource: "repository",
    ids: [repository.id],
    organizationId: repository.organizationId,
  });
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
  if (row) recordConnectionChange(db, row);
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

/** Every connection of `provider`, across organizations (maintenance crons). */
export async function listProviderScmConnections(
  db: Database,
  provider: ScmProvider,
): Promise<ScmConnection[]> {
  return db
    .select()
    .from(scmConnections)
    .where(eq(scmConnections.provider, provider))
    .orderBy(asc(scmConnections.createdAt));
}

/** Replaces a connection's health with the result of its latest check. */
export async function setScmConnectionHealth(
  db: Database,
  id: string,
  health: ScmConnectionHealth,
): Promise<void> {
  const rows = await db
    .update(scmConnections)
    .set({ health })
    .where(eq(scmConnections.id, id))
    .returning({ id: scmConnections.id, organizationId: scmConnections.organizationId });
  for (const row of rows) recordConnectionChange(db, row);
}

/**
 * Removes the problems with one of `codes` about repository `repositoryId` from a
 * connection's `health` (e.g. once its webhook was recreated). Done in one statement, so a
 * concurrent health write isn't overwritten with stale problems.
 */
export async function removeScmConnectionProblems(
  db: Database,
  connectionId: string,
  repositoryId: string,
  codes: string[],
): Promise<void> {
  await db.execute(sql`
    update ${scmConnections}
    set health = jsonb_set(
      health,
      '{problems}',
      coalesce(
        (
          select jsonb_agg(problem)
          from jsonb_array_elements(health -> 'problems') as problem
          where not (
            problem ->> 'repositoryId' is not distinct from ${repositoryId}
            and problem ->> 'code' in (${sql.join(
              codes.map((code) => sql`${code}`),
              sql`, `,
            )})
          )
        ),
        '[]'::jsonb
      )
    )
    where ${scmConnections.id} = ${connectionId} and health is not null
  `);
}

/** Decrypts a connection's credentials JSON. */
export function connectionCredentials<T extends Record<string, unknown>>(
  connection: Pick<ScmConnection, "encryptedCredentials">,
  key?: EncryptionKey,
): T {
  return JSON.parse(decrypt(connection.encryptedCredentials, key)) as T;
}

/**
 * Updates a connection's credentials under a row lock (`SELECT … FOR UPDATE`):
 * `update` gets the credentials as they are once the lock is held and returns
 * the new ones (or null to leave them). The new credentials are written in the
 * same transaction, so concurrent callers see each other's writes. Returns
 * whether credentials were written; false also when the connection is gone.
 */
export async function updateScmConnectionCredentials<T extends Record<string, unknown>>(
  db: Database,
  id: string,
  update: (credentials: T) => Promise<T | null>,
  key?: EncryptionKey,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [connection] = await tx
      .select({ encryptedCredentials: scmConnections.encryptedCredentials })
      .from(scmConnections)
      .where(eq(scmConnections.id, id))
      .for("update");
    if (!connection) return false;
    const credentials = await update(connectionCredentials<T>(connection, key));
    if (!credentials) return false;
    await tx
      .update(scmConnections)
      .set({ encryptedCredentials: encrypt(JSON.stringify(credentials), key) })
      .where(eq(scmConnections.id, id));
    return true;
  });
}

export interface ConnectRepositoryInput {
  connectionId: string;
  provider: ScmProvider;
  externalId: string;
  fullPath: string;
  webhookId?: string | null;
  /** Whether reviews are on (default on). */
  reviewsEnabled?: boolean;
}

/**
 * Connects (or reconnects) a repository: creates it, or re-enables an existing row for the
 * same connection and external ID (clearing `disconnectedAt`) so its history carries over.
 * With `reviewsEnabled: false` it's connected with reviews off, else with reviews on. Its
 * Coding and Ask switches are kept on reconnect (Coding starts off, Ask on).
 * The repository belongs to its connection's organization.
 */
export async function connectRepository(
  db: Database,
  input: ConnectRepositoryInput,
): Promise<Repository> {
  const set = {
    fullPath: input.fullPath,
    reviewsEnabled: input.reviewsEnabled ?? true,
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
  recordRepositoryChange(db, row);
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
 * Turns reviews for a connected repository of the organization on or off. Returns false if it
 * has no such repository or it's disconnected.
 */
export async function setRepositoryEnabled(
  db: Database,
  organizationId: string,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  return (await setRepositorySwitches(db, organizationId, id, { reviews: enabled })) !== null;
}

/**
 * Saves a connected repository's switches: each given one on or off; omitted ones are
 * unchanged. Answers its saved switches, or null if the organization has no such repository or
 * it's disconnected. Turning Coding on for a repository without a work item match throws
 * `WorkItemMatchRequiredError` (nothing is saved); one that already has Coding on keeps it.
 */
export async function setRepositorySwitches(
  db: Database,
  organizationId: string,
  id: string,
  switches: Partial<RepositorySwitches>,
): Promise<RepositorySwitches | null> {
  const connected = and(
    eq(repositories.id, id),
    eq(repositories.organizationId, organizationId),
    isNull(repositories.disconnectedAt),
  );
  const rows = await db
    .update(repositories)
    .set({
      ...(switches.reviews !== undefined && { reviewsEnabled: switches.reviews }),
      ...(switches.coding !== undefined && { codingEnabled: switches.coding }),
      ...(switches.ask !== undefined && { askEnabled: switches.ask }),
      // Always set, so a save that changes nothing still returns the row.
      updatedAt: new Date(),
    })
    .where(and(connected, switches.coding === true ? codingMayBeOn() : undefined))
    .returning();
  const [row] = rows;
  if (!row) {
    if (switches.coding === true) {
      const [found] = await db.select({ id: repositories.id }).from(repositories).where(connected);
      if (found) throw new WorkItemMatchRequiredError("turn_on_coding", id);
    }
    return null;
  }
  recordRepositoryChange(db, { id, organizationId });
  // The reviews switch is the Reviews section's, the coding and ask switches the Coding one's.
  const sections = [
    ...(switches.reviews !== undefined ? (["repository.reviews"] as const) : []),
    ...(switches.coding !== undefined || switches.ask !== undefined
      ? (["repository.coding"] as const)
      : []),
  ];
  for (const section of sections) {
    recordRepositorySettingsChange(db, { id, organizationId }, section);
  }
  return repositorySwitches(row);
}

/**
 * Sets the stored webhook ID of a connected repository of the organization (null when it
 * has none). Returns false if it has no such repository or it's disconnected.
 */
export async function setRepositoryWebhookId(
  db: Database,
  organizationId: string,
  id: string,
  webhookId: string | null,
): Promise<boolean> {
  const rows = await db
    .update(repositories)
    .set({ webhookId })
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
 * Stores a repository's default branch as read from its code host. Writes (and records a live
 * `repository` change) only when the value differs from the stored one. Returns whether it
 * changed; false for an unknown repository too.
 */
export async function setRepositoryDefaultBranch(
  db: Database,
  repositoryId: string,
  branch: string,
): Promise<boolean> {
  const [row] = await db
    .update(repositories)
    .set({ defaultBranch: branch })
    .where(
      and(
        eq(repositories.id, repositoryId),
        sql`${repositories.defaultBranch} is distinct from ${branch}`,
      ),
    )
    .returning({ id: repositories.id, organizationId: repositories.organizationId });
  if (!row) return false;
  recordRepositoryChange(db, row);
  return true;
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
      .set({ reviewsEnabled: false, disconnectedAt: now, webhookId: null })
      .where(and(eq(repositories.id, id), eq(repositories.organizationId, organizationId)))
      .returning();
    if (!row) return null;
    const unpinned = await tx
      .delete(agentRepoPins)
      .where(eq(agentRepoPins.repositoryId, id))
      .returning({ agentId: agentRepoPins.agentId });
    recordRepositoryChange(tx, row);
    for (const { agentId } of unpinned) {
      recordPinChange(tx, { agentId, repositoryId: id, organizationId });
    }
    return row;
  });
}

export interface RepositoryOverview {
  id: string;
  provider: ScmProvider;
  fullPath: string;
  /** Reviews run on its pull and merge requests. */
  reviewsEnabled: boolean;
  /** Work items routed to it are built. */
  codingEnabled: boolean;
  /** Externally triggered queries (mentions, chat, triage) run on it. */
  askEnabled: boolean;
  connectionId: string;
  connectionName: string;
  /** Instance URL (GitLab) or API URL (GitHub). */
  baseUrl: string;
  /** The depth its reviews run at. */
  reviewDepth: Repository["reviewDepth"];
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
  reviewsEnabled: repositories.reviewsEnabled,
  codingEnabled: repositories.codingEnabled,
  askEnabled: repositories.askEnabled,
  connectionId: repositories.connectionId,
  connectionName: scmConnections.name,
  baseUrl: scmConnections.baseUrl,
  reviewDepth: repositories.reviewDepth,
};

function connectedIn(organizationId: string, search?: string) {
  const pattern = search?.trim() ? `%${search.trim().replace(/[\\%_]/g, "\\$&")}%` : null;
  return and(
    eq(repositories.organizationId, organizationId),
    isNull(repositories.disconnectedAt),
    pattern === null ? undefined : ilike(repositories.fullPath, pattern),
  );
}

function overviewQuery(db: Database, organizationId: string, search?: string) {
  return db
    .select(overviewColumns)
    .from(repositories)
    .innerJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
    .where(connectedIn(organizationId, search))
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
      .select({
        repositoryId: agentRepoPins.repositoryId,
        id: agents.id,
        name: agents.name,
      })
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

/** The organization's connected (not disconnected) repositories with their depth, pins and latest review. */
export async function listRepositoryOverview(
  db: Database,
  organizationId: string,
): Promise<RepositoryOverview[]> {
  return withPinsAndLastReview(db, await overviewQuery(db, organizationId));
}

/**
 * One page of `listRepositoryOverview`, ordered by path. A page past the last
 * one comes back empty (with the real `total`). `search` keeps the repositories
 * whose path contains it, ignoring case.
 */
export async function listRepositoryOverviewPage(
  db: Database,
  organizationId: string,
  options: { page?: number; pageSize?: number; search?: string } = {},
): Promise<RepositoryOverviewPage> {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? REPOSITORY_PAGE_SIZE));
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const [[totalRow], rows] = await Promise.all([
    db
      .select({ total: count() })
      .from(repositories)
      .where(connectedIn(organizationId, options.search)),
    overviewQuery(db, organizationId, options.search)
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
 * Pins a connected repository to an agent: its jobs are then targeted at that
 * agent (see `pinnedAgentFor`). Revoked agents, disconnected repositories and
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
    if (inserted.length > 0) recordPinChange(tx, { ...input, ...repo });
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
  if (rows.length === 0) return false;
  const [agent] = await db
    .select({ organizationId: agents.organizationId })
    .from(agents)
    .where(eq(agents.id, input.agentId));
  if (agent) recordPinChange(db, { ...input, organizationId: agent.organizationId });
  return true;
}

/** Records a live `settings` change of a repository's settings section. */
export function recordRepositorySettingsChange(
  db: unknown,
  repository: { id: string; organizationId: string },
  section: "repository.reviews" | "repository.coding" | "repository.agents",
): void {
  recordChange(db, {
    resource: "settings",
    section,
    ids: [repository.id],
    subjectId: repository.id,
    organizationId: repository.organizationId,
  });
}

/** Records a pin's live changes: the agent's and the repository's agents section. */
function recordPinChange(
  db: unknown,
  pin: { agentId: string; repositoryId: string; organizationId: string },
): void {
  recordChange(db, { resource: "agent", ids: [pin.agentId], organizationId: pin.organizationId });
  recordRepositorySettingsChange(
    db,
    { id: pin.repositoryId, organizationId: pin.organizationId },
    "repository.agents",
  );
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
