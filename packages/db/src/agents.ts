/**
 * Agents and Jobs pages: the fleet overview, central agent configuration
 * (returned to the agent in its next heartbeat), the audit log and the job list.
 */
import { and, asc, desc, eq, inArray, isNull, like, sql, type SQL } from "drizzle-orm";
import type { Database } from "./client.js";
import type { AgentAuditEntry } from "./agent-auth.js";
import type { Job, JobStatus } from "./jobs.js";
import { agentAudit, agentRepoPins, agents, jobs, repositories, scmConnections } from "./schema.js";

type AgentRow = typeof agents.$inferSelect;

/** The repository a job or pin refers to, with what's needed to link to it. */
export interface RepositoryLink {
  id: string;
  provider: "github" | "gitlab";
  fullPath: string;
  /** The connection's base URL (GitLab instance or GitHub API URL). */
  baseUrl: string;
}

export interface AgentJobSummary {
  id: string;
  capability: string;
  type: string;
  status: JobStatus;
  payload: Record<string, unknown>;
  repository: RepositoryLink | null;
}

export interface AgentOverview extends AgentRow {
  runningJobs: AgentJobSummary[];
  pinnedRepositories: RepositoryLink[];
}

const repositoryLinkColumns = {
  repoId: repositories.id,
  provider: repositories.provider,
  fullPath: repositories.fullPath,
  baseUrl: scmConnections.baseUrl,
};

function repositoryLink(row: {
  repoId: string | null;
  provider: "github" | "gitlab" | null;
  fullPath: string | null;
  baseUrl: string | null;
}): RepositoryLink | null {
  if (!row.repoId || !row.provider || row.fullPath === null || row.baseUrl === null) return null;
  return { id: row.repoId, provider: row.provider, fullPath: row.fullPath, baseUrl: row.baseUrl };
}

async function withJobsAndPins(db: Database, rows: AgentRow[]): Promise<AgentOverview[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [running, pins] = await Promise.all([
    db
      .select({
        id: jobs.id,
        agentId: jobs.agentId,
        capability: jobs.capability,
        type: jobs.type,
        status: jobs.status,
        payload: jobs.payload,
        ...repositoryLinkColumns,
      })
      .from(jobs)
      .leftJoin(repositories, eq(repositories.id, jobs.repositoryId))
      .leftJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
      .where(and(inArray(jobs.agentId, ids), eq(jobs.status, "running")))
      .orderBy(asc(jobs.startedAt)),
    db
      .select({ agentId: agentRepoPins.agentId, ...repositoryLinkColumns })
      .from(agentRepoPins)
      .innerJoin(repositories, eq(repositories.id, agentRepoPins.repositoryId))
      .innerJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
      .where(inArray(agentRepoPins.agentId, ids))
      .orderBy(asc(repositories.fullPath)),
  ]);
  return rows.map((agent) => ({
    ...agent,
    runningJobs: running
      .filter((job) => job.agentId === agent.id)
      .map((job) => ({
        id: job.id,
        capability: job.capability,
        type: job.type,
        status: job.status,
        payload: job.payload,
        repository: repositoryLink(job),
      })),
    pinnedRepositories: pins
      .filter((pin) => pin.agentId === agent.id)
      .map((pin) => repositoryLink(pin)!),
  }));
}

/** Every agent (active first, then revoked; by name) with its running jobs and pins. */
export async function listAgentOverview(db: Database): Promise<AgentOverview[]> {
  const rows = await db
    .select()
    .from(agents)
    .orderBy(asc(sql`${agents.revokedAt} is not null`), asc(agents.name), asc(agents.createdAt));
  return withJobsAndPins(db, rows);
}

export async function getAgentOverview(
  db: Database,
  agentId: string,
): Promise<AgentOverview | null> {
  const rows = await db.select().from(agents).where(eq(agents.id, agentId));
  const [agent] = await withJobsAndPins(db, rows);
  return agent ?? null;
}

export interface AgentConfigInput {
  maxConcurrency: number;
  pollIntervalSeconds: number;
  enabledCapabilities: string[];
  /** Per-capability concurrency limits; capabilities left out use the default. */
  capabilityLimits?: Partial<Record<string, number>>;
}

/**
 * Updates an agent's central configuration. The agent picks it up from its
 * next heartbeat response. Returns null for unknown or revoked agents.
 */
export async function updateAgentConfig(
  db: Database,
  agentId: string,
  input: AgentConfigInput,
): Promise<AgentRow | null> {
  const [row] = await db
    .update(agents)
    .set({
      maxConcurrency: input.maxConcurrency,
      pollIntervalSeconds: input.pollIntervalSeconds,
      enabledCapabilities: [...new Set(input.enabledCapabilities)],
      ...(input.capabilityLimits && { capabilityLimits: input.capabilityLimits }),
    })
    .where(and(eq(agents.id, agentId), isNull(agents.revokedAt)))
    .returning();
  return row ?? null;
}

/** An agent's most recent audit events, newest first. */
export async function listRecentAgentAudit(
  db: Database,
  agentId: string,
  limit = 50,
): Promise<AgentAuditEntry[]> {
  return db
    .select()
    .from(agentAudit)
    .where(eq(agentAudit.agentId, agentId))
    .orderBy(desc(agentAudit.createdAt), desc(agentAudit.id))
    .limit(limit);
}

export interface JobListEntry {
  id: string;
  capability: string;
  type: string;
  status: JobStatus;
  deliveryCount: number;
  cancelRequested: boolean;
  error: string | null;
  payload: Record<string, unknown>;
  agent: { id: string; name: string } | null;
  repository: RepositoryLink | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** Recent jobs across capabilities, newest first, optionally of some statuses only. */
export async function listRecentJobs(
  db: Database,
  filter: { statuses?: JobStatus[]; limit?: number } = {},
): Promise<JobListEntry[]> {
  const where: SQL | undefined =
    filter.statuses && filter.statuses.length > 0
      ? inArray(jobs.status, filter.statuses)
      : undefined;
  const rows = await db
    .select({
      id: jobs.id,
      capability: jobs.capability,
      type: jobs.type,
      status: jobs.status,
      deliveryCount: jobs.deliveryCount,
      cancelRequested: jobs.cancelRequested,
      error: jobs.error,
      payload: jobs.payload,
      agentId: agents.id,
      agentName: agents.name,
      createdAt: jobs.createdAt,
      startedAt: jobs.startedAt,
      finishedAt: jobs.finishedAt,
      ...repositoryLinkColumns,
    })
    .from(jobs)
    .leftJoin(agents, eq(agents.id, jobs.agentId))
    .leftJoin(repositories, eq(repositories.id, jobs.repositoryId))
    .leftJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
    .where(where)
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(filter.limit ?? 100);
  return rows.map((row) => ({
    id: row.id,
    capability: row.capability,
    type: row.type,
    status: row.status,
    deliveryCount: row.deliveryCount,
    cancelRequested: row.cancelRequested,
    error: row.error,
    payload: row.payload,
    agent: row.agentId && row.agentName !== null ? { id: row.agentId, name: row.agentName } : null,
    repository: repositoryLink(row),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }));
}

/**
 * Queued jobs published to one of the agent's own topics
 * (`<capability>-jobs-agent-<agentId>`), which no other agent reads.
 */
export async function listQueuedJobsOnAgentTopics(db: Database, agentId: string): Promise<Job[]> {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), like(jobs.topic, `%-jobs-agent-${agentId}`)))
    .orderBy(asc(jobs.createdAt));
}
