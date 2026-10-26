/**
 * The Repos rail's reads: an organization scope's connected repositories, and the facts
 * their status is computed from (active runs, latest checkout syncs, pinned and online
 * agents). Each read is one query whatever the number of repositories.
 */
import { REPO_SYNC_JOB_TYPE } from "@omniralph/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { runIndexSql } from "./run-index.js";
import {
  agentRepoPins,
  agents,
  jobs,
  organizations,
  repositories,
  scmConnections,
  type ScmConnectionHealth,
} from "./schema.js";
import type { JobStatus } from "./jobs.js";

/** A connected repository of the rail, with its connection's health. */
export interface ConnectedRepository {
  id: string;
  organizationId: string;
  provider: (typeof scmConnections.$inferSelect)["provider"];
  fullPath: string;
  reviewsEnabled: boolean;
  codingEnabled: boolean;
  askEnabled: boolean;
  connection: {
    id: string;
    provider: (typeof scmConnections.$inferSelect)["provider"];
    /** Instance URL (GitLab) or API URL (GitHub). */
    baseUrl: string;
    health: ScmConnectionHealth | null;
  };
}

/**
 * The organizations' connected (not disconnected) repositories, by organization name, then
 * path, at most `limit` (`truncated` when there were more); only `repositoryIds` when given.
 */
export async function listConnectedRepositories(
  db: Database,
  organizationIds: readonly string[],
  limit: number,
  { repositoryIds }: { repositoryIds?: readonly string[] } = {},
): Promise<{ repositories: ConnectedRepository[]; truncated: boolean }> {
  if (organizationIds.length === 0 || repositoryIds?.length === 0) {
    return { repositories: [], truncated: false };
  }
  const rows = await db
    .select({
      id: repositories.id,
      organizationId: repositories.organizationId,
      provider: repositories.provider,
      fullPath: repositories.fullPath,
      reviewsEnabled: repositories.reviewsEnabled,
      codingEnabled: repositories.codingEnabled,
      askEnabled: repositories.askEnabled,
      connectionId: scmConnections.id,
      connectionProvider: scmConnections.provider,
      baseUrl: scmConnections.baseUrl,
      health: scmConnections.health,
    })
    .from(repositories)
    .innerJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
    .innerJoin(organizations, eq(organizations.id, repositories.organizationId))
    .where(
      and(
        inArray(repositories.organizationId, [...organizationIds]),
        isNull(repositories.disconnectedAt),
        repositoryIds ? inArray(repositories.id, [...repositoryIds]) : undefined,
      ),
    )
    .orderBy(
      asc(organizations.name),
      asc(organizations.id),
      asc(repositories.fullPath),
      asc(repositories.id),
    )
    .limit(limit + 1);
  return {
    repositories: rows.slice(0, limit).map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      provider: row.provider,
      fullPath: row.fullPath,
      reviewsEnabled: row.reviewsEnabled,
      codingEnabled: row.codingEnabled,
      askEnabled: row.askEnabled,
      connection: {
        id: row.connectionId,
        provider: row.connectionProvider,
        baseUrl: row.baseUrl,
        health: row.health,
      },
    })),
    truncated: rows.length > limit,
  };
}

/** A repository's latest `repo.sync` job. */
export interface RepositorySyncJob {
  repositoryId: string;
  jobId: string;
  status: JobStatus;
  /** The agent that ran it, else the one it was targeted at; null when neither is known. */
  agent: { id: string; name: string } | null;
}

/** An agent of the organizations, with what liveness needs. */
export interface StatusAgent {
  id: string;
  organizationId: string;
  name: string;
  lastHeartbeatAt: Date | null;
  revoked: boolean;
}

/** What the status of a set of repositories is computed from. */
export interface RepositoryStatusFacts {
  /** Runs with unified status `queued` or `running`, by repository (absent: none). */
  running: Map<string, number>;
  /** The latest `repo.sync` job, by repository (absent: never synced). */
  latestSync: Map<string, RepositorySyncJob>;
  /** Each repository's pinned agent IDs (absent: none pinned). */
  pins: Map<string, string[]>;
  /** Every agent of the organizations, revoked ones included, by name. */
  agents: StatusAgent[];
}

/**
 * The status facts of `repositoryIds` (of `organizationIds`): four queries, however many
 * repositories there are.
 */
export async function loadRepositoryStatusFacts(
  db: Database,
  input: { organizationIds: readonly string[]; repositoryIds: readonly string[] },
): Promise<RepositoryStatusFacts> {
  const { organizationIds, repositoryIds } = input;
  if (repositoryIds.length === 0 || organizationIds.length === 0) {
    return { running: new Map(), latestSync: new Map(), pins: new Map(), agents: [] };
  }
  const ids = [...repositoryIds];
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const syncAgent = sql`coalesce(${jobs.agentId}, ${jobs.targetAgentId})`;
  const [running, syncs, pins, agentRows] = await Promise.all([
    db.execute<{ repository_id: string; running: number }>(sql`
      select runs.repository_id, count(*)::int as running from (${runIndexSql()}) runs
      where runs.repository_id in (${idList}) and runs.status in ('queued', 'running')
      group by runs.repository_id`),
    db
      .selectDistinctOn([jobs.repositoryId], {
        repositoryId: jobs.repositoryId,
        jobId: jobs.id,
        status: jobs.status,
        agentId: agents.id,
        agentName: agents.name,
      })
      .from(jobs)
      .leftJoin(agents, eq(agents.id, syncAgent))
      .where(
        and(
          inArray(jobs.repositoryId, ids),
          eq(jobs.type, REPO_SYNC_JOB_TYPE),
          isNotNull(jobs.repositoryId),
        ),
      )
      .orderBy(jobs.repositoryId, desc(jobs.createdAt), desc(jobs.id)),
    db
      .select({ repositoryId: agentRepoPins.repositoryId, agentId: agentRepoPins.agentId })
      .from(agentRepoPins)
      .where(inArray(agentRepoPins.repositoryId, ids)),
    db
      .select({
        id: agents.id,
        organizationId: agents.organizationId,
        name: agents.name,
        lastHeartbeatAt: agents.lastHeartbeatAt,
        revokedAt: agents.revokedAt,
      })
      .from(agents)
      .where(inArray(agents.organizationId, [...organizationIds]))
      .orderBy(asc(agents.name), asc(agents.id)),
  ]);

  const pinsByRepo = new Map<string, string[]>();
  for (const pin of pins) {
    pinsByRepo.set(pin.repositoryId, [...(pinsByRepo.get(pin.repositoryId) ?? []), pin.agentId]);
  }
  return {
    running: new Map(running.rows.map((row) => [row.repository_id, Number(row.running)])),
    latestSync: new Map(
      syncs.map((row) => [
        row.repositoryId!,
        {
          repositoryId: row.repositoryId!,
          jobId: row.jobId,
          status: row.status,
          agent: row.agentId && row.agentName ? { id: row.agentId, name: row.agentName } : null,
        },
      ]),
    ),
    pins: pinsByRepo,
    agents: agentRows.map(({ revokedAt, ...agent }) => ({ ...agent, revoked: revokedAt !== null })),
  };
}
