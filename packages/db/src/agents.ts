/**
 * Agents and Jobs pages: the fleet overview, central agent configuration
 * (returned to the agent in its next heartbeat), the audit log and the job list.
 */
import { INSTALL_JOB_TYPE, REPO_SYNC_JOB_TYPE } from "@omniralph/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { TASK_TYPES, type TaskType } from "@omniralph/tasks";
import { getDefaultMaxConcurrency } from "./app-settings.js";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import type { AgentAuditEntry } from "./agent-auth.js";
import { jobRunId, type Job, type JobStatus } from "./jobs.js";
import {
  agentAudit,
  agentRepoPins,
  agents,
  jobs,
  ralphStories,
  repositories,
  scmConnections,
} from "./schema.js";

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
  type: string;
  taskType: Job["taskType"];
  status: JobStatus;
  payload: Record<string, unknown>;
  repository: RepositoryLink | null;
  /** The run the job is an attempt of; null for system work. */
  runId: string | null;
}

export interface AgentOverview extends AgentRow {
  /** Its configuration with the organization's defaults filled in (`effectiveAgentConfig`). */
  effective: EffectiveAgentConfig;
  /** The organization's defaults it inherits where its own values are null. */
  defaults: AgentDefaults;
  runningJobs: AgentJobSummary[];
  pinnedRepositories: RepositoryLink[];
}

/** The organization's agent defaults, for agents without their own values. */
export interface AgentDefaults {
  maxConcurrency: number;
}

/** What an agent runs: its own value where it has one, else the organization's default. */
export interface EffectiveAgentConfig {
  /**
   * Task types it may claim jobs of (`system` is always accepted): the ones it reports
   * (`agentAcceptedTaskTypes`).
   */
  acceptedTaskTypes: TaskType[];
  maxConcurrency: number;
}

/**
 * The task types an agent runs, as it reported them (its local `acceptedTaskTypes`), in
 * `TASK_TYPES` order; every type until it reports any.
 */
export function agentAcceptedTaskTypes(
  agent: Pick<AgentRow, "reportedAcceptedTaskTypes">,
): TaskType[] {
  const reported = agent.reportedAcceptedTaskTypes;
  return reported ? TASK_TYPES.filter((type) => reported.includes(type)) : [...TASK_TYPES];
}

/** The organization's agent defaults (`app_settings`, else the built-in ones). */
export async function getAgentDefaults(
  db: Database,
  organizationId: string,
): Promise<AgentDefaults> {
  return { maxConcurrency: await getDefaultMaxConcurrency(db, organizationId) };
}

/** An agent's effective configuration: each of its values when not null, else the default. */
export function effectiveAgentConfig(
  agent: Pick<AgentRow, "reportedAcceptedTaskTypes" | "maxConcurrency">,
  defaults: AgentDefaults,
): EffectiveAgentConfig {
  return {
    acceptedTaskTypes: agentAcceptedTaskTypes(agent),
    maxConcurrency: agent.maxConcurrency ?? defaults.maxConcurrency,
  };
}

/**
 * An agent's effective configuration, reading its organization's defaults only when it
 * inherits something.
 */
export async function resolveAgentConfig(
  db: Database,
  agent: Pick<AgentRow, "organizationId" | "reportedAcceptedTaskTypes" | "maxConcurrency">,
): Promise<EffectiveAgentConfig> {
  return {
    acceptedTaskTypes: agentAcceptedTaskTypes(agent),
    maxConcurrency:
      agent.maxConcurrency ?? (await getDefaultMaxConcurrency(db, agent.organizationId)),
  };
}

export const repositoryLinkColumns = {
  repoId: repositories.id,
  provider: repositories.provider,
  fullPath: repositories.fullPath,
  baseUrl: scmConnections.baseUrl,
};

export function repositoryLink(row: {
  repoId: string | null;
  provider: "github" | "gitlab" | null;
  fullPath: string | null;
  baseUrl: string | null;
}): RepositoryLink | null {
  if (!row.repoId || !row.provider || row.fullPath === null || row.baseUrl === null) return null;
  return { id: row.repoId, provider: row.provider, fullPath: row.fullPath, baseUrl: row.baseUrl };
}

async function withJobsAndPins(
  db: Database,
  organizationId: string,
  rows: AgentRow[],
): Promise<AgentOverview[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [defaults, running, pins] = await Promise.all([
    getAgentDefaults(db, organizationId),
    db
      .select({
        id: jobs.id,
        agentId: jobs.agentId,
        type: jobs.type,
        taskType: jobs.taskType,
        status: jobs.status,
        payload: jobs.payload,
        ralphRunId: jobs.ralphRunId,
        reviewRunId: jobs.reviewRunId,
        triageRunId: jobs.triageRunId,
        chatThreadRunId: jobs.chatThreadRunId,
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
    effective: effectiveAgentConfig(agent, defaults),
    defaults,
    runningJobs: running
      .filter((job) => job.agentId === agent.id)
      .map((job) => ({
        id: job.id,
        type: job.type,
        taskType: job.taskType,
        status: job.status,
        payload: job.payload,
        repository: repositoryLink(job),
        runId: jobRunId(job),
      })),
    pinnedRepositories: pins
      .filter((pin) => pin.agentId === agent.id)
      .map((pin) => repositoryLink(pin)!),
  }));
}

/**
 * The organization's agents (active first, then revoked; by name) with their
 * running jobs and pins. Deleted agents are left out.
 */
export async function listAgentOverview(
  db: Database,
  organizationId: string,
): Promise<AgentOverview[]> {
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.organizationId, organizationId), isNull(agents.deletedAt)))
    .orderBy(asc(sql`${agents.revokedAt} is not null`), asc(agents.name), asc(agents.createdAt));
  return withJobsAndPins(db, organizationId, rows);
}

/** One of the organization's agents (null for unknown and deleted agents and other organizations'). */
export async function getAgentOverview(
  db: Database,
  organizationId: string,
  agentId: string,
): Promise<AgentOverview | null> {
  const rows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, organizationId),
        eq(agents.id, agentId),
        isNull(agents.deletedAt),
      ),
    );
  const [agent] = await withJobsAndPins(db, organizationId, rows);
  return agent ?? null;
}

/** A Claude model the organization's agents report, with the agents that can run it. */
export interface ReportedModelOption {
  value: string;
  displayName: string;
  agentIds: string[];
}

/**
 * The de-duplicated models the organization's non-revoked agents (or those of
 * `agentIds` among them) last reported, sorted by display name. A model's
 * display name is the first reported one, by agent name.
 */
export async function listReportedModels(
  db: Database,
  organizationId: string,
  options: { agentIds?: readonly string[] } = {},
): Promise<ReportedModelOption[]> {
  if (options.agentIds?.length === 0) return [];
  const rows = await db
    .select({ id: agents.id, models: agents.reportedModels })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, organizationId),
        isNull(agents.revokedAt),
        isNull(agents.deletedAt),
        options.agentIds && inArray(agents.id, [...options.agentIds]),
      ),
    )
    .orderBy(asc(agents.name), asc(agents.createdAt));
  const byValue = new Map<string, ReportedModelOption>();
  for (const row of rows) {
    for (const model of row.models) {
      const option = byValue.get(model.value);
      if (!option) {
        byValue.set(model.value, { ...model, agentIds: [row.id] });
      } else if (!option.agentIds.includes(row.id)) {
        option.agentIds.push(row.id);
      }
    }
  }
  return [...byValue.values()].sort(
    (a, b) => a.displayName.localeCompare(b.displayName) || a.value.localeCompare(b.value),
  );
}

/** IDs of the organization's agents that aren't revoked or deleted, by name. */
export async function listActiveAgentIds(db: Database, organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, organizationId),
        isNull(agents.revokedAt),
        isNull(agents.deletedAt),
      ),
    )
    .orderBy(asc(agents.name), asc(agents.createdAt));
  return rows.map((row) => row.id);
}

/** An installable the organization's agents report, with the agents that have it. */
export interface ReportedInstallableOption {
  name: string;
  agentIds: string[];
  /** Its MCP servers, from its latest completed install job (empty when none says). */
  mcpServers: string[];
}

/**
 * The installables the organization's non-revoked agents last reported, by name, with the
 * MCP servers the latest completed install of each said it provides.
 */
export async function listReportedInstallables(
  db: Database,
  organizationId: string,
): Promise<ReportedInstallableOption[]> {
  const rows = await db
    .select({ id: agents.id, installables: agents.reportedInstallables })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, organizationId),
        isNull(agents.revokedAt),
        isNull(agents.deletedAt),
      ),
    )
    .orderBy(asc(agents.name), asc(agents.createdAt));
  const byName = new Map<string, ReportedInstallableOption>();
  for (const row of rows) {
    for (const { name } of row.installables) {
      const option = byName.get(name);
      if (!option) byName.set(name, { name, agentIds: [row.id], mcpServers: [] });
      else if (!option.agentIds.includes(row.id)) option.agentIds.push(row.id);
    }
  }
  if (byName.size === 0) return [];
  const installedName = sql<string>`${jobs.result}->>'name'`;
  const installs = await db
    .selectDistinctOn([installedName], {
      name: installedName,
      mcpServers: sql<unknown>`${jobs.result}->'mcpServers'`,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, organizationId),
        eq(jobs.type, INSTALL_JOB_TYPE),
        eq(jobs.status, "completed"),
        inArray(installedName, [...byName.keys()]),
      ),
    )
    .orderBy(installedName, sql`${jobs.finishedAt} desc nulls last`, desc(jobs.createdAt));
  for (const install of installs) {
    const option = byName.get(install.name);
    if (option && Array.isArray(install.mcpServers)) {
      option.mcpServers = install.mcpServers.filter(
        (server): server is string => typeof server === "string",
      );
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The agents that may run a repository's coding jobs: its active pinned agents, else every
 * agent of the organization that accepts coding (the task types it reports).
 * Revoked and deleted agents are left out (pins only to those count as none). `pinned` says
 * which of the two the IDs are.
 */
export async function listRepositoryCodingAgentIds(
  db: Database,
  organizationId: string,
  repositoryId: string,
): Promise<{ pinned: boolean; agentIds: string[] }> {
  const active = and(
    eq(agents.organizationId, organizationId),
    isNull(agents.revokedAt),
    isNull(agents.deletedAt),
  );
  const pinned = await db
    .select({ id: agents.id })
    .from(agentRepoPins)
    .innerJoin(agents, eq(agents.id, agentRepoPins.agentId))
    .where(and(eq(agentRepoPins.repositoryId, repositoryId), active))
    .orderBy(asc(agents.name), asc(agents.createdAt));
  if (pinned.length > 0) return { pinned: true, agentIds: pinned.map((r) => r.id) };
  const rows = await db
    .select({ id: agents.id, reportedAcceptedTaskTypes: agents.reportedAcceptedTaskTypes })
    .from(agents)
    .where(active)
    .orderBy(asc(agents.name), asc(agents.createdAt));
  return {
    pinned: false,
    agentIds: rows.filter((r) => agentAcceptedTaskTypes(r).includes("coding")).map((r) => r.id),
  };
}

export interface AgentConfigInput {
  /** Null inherits the organization's default. */
  maxConcurrency: number | null;
  /** Per-pool concurrency limits; pools left out use the default. */
  poolLimits: Partial<Record<string, number>>;
}

/**
 * Updates an agent's central configuration. The agent picks it up from its
 * next heartbeat response. Returns null for unknown or revoked agents and
 * agents of another organization.
 */
export async function updateAgentConfig(
  db: Database,
  organizationId: string,
  agentId: string,
  input: AgentConfigInput,
): Promise<AgentRow | null> {
  const [row] = await db
    .update(agents)
    .set({
      maxConcurrency: input.maxConcurrency,
      poolLimits: input.poolLimits,
    })
    .where(
      and(
        eq(agents.organizationId, organizationId),
        eq(agents.id, agentId),
        isNull(agents.revokedAt),
      ),
    )
    .returning();
  if (row) recordAgentChange(db, row);
  return row ?? null;
}

/** Records a live `agent` change for the agent. */
function recordAgentChange(db: Database, agent: { id: string; organizationId: string }): void {
  recordChange(db, {
    resource: "agent",
    ids: [agent.id],
    organizationId: agent.organizationId,
  });
}

/**
 * Sets (or, with null, clears) an agent's desired-version override. Returns
 * null for unknown or revoked agents and agents of another organization.
 */
export async function setAgentDesiredVersion(
  db: Database,
  organizationId: string,
  agentId: string,
  version: string | null,
): Promise<AgentRow | null> {
  const [row] = await db
    .update(agents)
    .set({ desiredVersion: version })
    .where(
      and(
        eq(agents.organizationId, organizationId),
        eq(agents.id, agentId),
        isNull(agents.revokedAt),
      ),
    )
    .returning();
  if (row) recordAgentChange(db, row);
  return row ?? null;
}

/**
 * Asks an agent to update to `version` now (an admin's "Update now"), replacing
 * any request it hasn't acted on yet. The agent gets it with its next heartbeat
 * and reports it handled, which clears it. Returns null for unknown or revoked
 * agents and agents of another organization.
 */
export async function requestAgentUpdate(
  db: Database,
  organizationId: string,
  agentId: string,
  version: string,
  now: Date = new Date(),
): Promise<AgentRow | null> {
  const [row] = await db
    .update(agents)
    .set({
      updateRequestId: sql`gen_random_uuid()`,
      updateRequestVersion: version,
      updateRequestedAt: now,
    })
    .where(
      and(
        eq(agents.organizationId, organizationId),
        eq(agents.id, agentId),
        isNull(agents.revokedAt),
      ),
    )
    .returning();
  if (row) recordAgentChange(db, row);
  return row ?? null;
}

/**
 * Soft-deletes a revoked agent: it's hidden from the Agents pages from then on.
 * Returns false for unknown, active or already deleted agents and agents of
 * another organization.
 */
export async function markAgentDeleted(
  db: Database,
  organizationId: string,
  agentId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(agents)
    .set({ deletedAt: now })
    .where(
      and(
        eq(agents.organizationId, organizationId),
        eq(agents.id, agentId),
        isNotNull(agents.revokedAt),
        isNull(agents.deletedAt),
      ),
    )
    .returning({ id: agents.id, organizationId: agents.organizationId });
  for (const row of rows) recordAgentChange(db, row);
  return rows.length > 0;
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

/** An `install` job targeted at an agent, for its detail page. */
export interface AgentInstallJob {
  id: string;
  status: JobStatus;
  /** The payload's package name and version (null: `latest`). */
  name: string | null;
  version: string | null;
  /** The version the agent installed, from the job's result. */
  installedVersion: string | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** The `install` jobs targeted at an agent of the organization since `since`, newest first. */
export async function listAgentInstallJobs(
  db: Database,
  organizationId: string,
  agentId: string,
  since: Date,
  limit = 50,
): Promise<AgentInstallJob[]> {
  const rows = await db
    .select({
      id: jobs.id,
      status: jobs.status,
      payload: jobs.payload,
      result: jobs.result,
      error: jobs.error,
      createdAt: jobs.createdAt,
      finishedAt: jobs.finishedAt,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, organizationId),
        eq(jobs.targetAgentId, agentId),
        eq(jobs.type, INSTALL_JOB_TYPE),
        gte(jobs.createdAt, since),
      ),
    )
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(limit);
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    name: text(row.payload.name),
    version: text(row.payload.version),
    installedVersion: text(row.result?.version),
    error: row.error,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  }));
}

/** The latest `repo.sync` job of a repository pinned to an agent, for its detail page. */
export interface AgentPinSyncJob {
  repositoryId: string;
  id: string;
  status: JobStatus;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/**
 * The latest `repo.sync` job targeted at an agent of the organization since `since`, per
 * repository (the sync pinning enqueues): what the agent's pinned repositories show.
 */
export async function listAgentPinSyncJobs(
  db: Database,
  organizationId: string,
  agentId: string,
  since: Date,
): Promise<AgentPinSyncJob[]> {
  const rows = await db
    .selectDistinctOn([jobs.repositoryId], {
      repositoryId: jobs.repositoryId,
      id: jobs.id,
      status: jobs.status,
      error: jobs.error,
      createdAt: jobs.createdAt,
      finishedAt: jobs.finishedAt,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, organizationId),
        eq(jobs.targetAgentId, agentId),
        eq(jobs.type, REPO_SYNC_JOB_TYPE),
        isNotNull(jobs.repositoryId),
        gte(jobs.createdAt, since),
      ),
    )
    .orderBy(jobs.repositoryId, desc(jobs.createdAt), desc(jobs.id));
  return rows.map((row) => ({ ...row, repositoryId: row.repositoryId! }));
}

export interface JobListEntry {
  id: string;
  type: string;
  taskType: Job["taskType"];
  status: JobStatus;
  deliveryCount: number;
  cancelRequested: boolean;
  error: string | null;
  payload: Record<string, unknown>;
  agent: { id: string; name: string } | null;
  repository: RepositoryLink | null;
  /** The run the job is an attempt of; null for system work. */
  runId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** Jobs per page of the Jobs list. */
export const JOB_PAGE_SIZE = 50;

export interface JobListPage {
  jobs: JobListEntry[];
  /** Matching jobs across all pages. */
  total: number;
  page: number;
  pageSize: number;
}

function jobListWhere(
  organizationId: string,
  filter: { statuses?: JobStatus[]; types?: string[] },
): SQL | undefined {
  return and(
    eq(jobs.organizationId, organizationId),
    filter.statuses && filter.statuses.length > 0
      ? inArray(jobs.status, filter.statuses)
      : undefined,
    filter.types && filter.types.length > 0 ? inArray(jobs.type, filter.types) : undefined,
  );
}

async function selectJobs(
  db: Database,
  where: SQL | undefined,
  limit: number,
  offset = 0,
): Promise<JobListEntry[]> {
  const rows = await db
    .select({
      id: jobs.id,
      type: jobs.type,
      taskType: jobs.taskType,
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
      ralphRunId: jobs.ralphRunId,
      reviewRunId: jobs.reviewRunId,
      triageRunId: jobs.triageRunId,
      chatThreadRunId: jobs.chatThreadRunId,
      ...repositoryLinkColumns,
    })
    .from(jobs)
    .leftJoin(agents, eq(agents.id, jobs.agentId))
    .leftJoin(repositories, eq(repositories.id, jobs.repositoryId))
    .leftJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
    .where(where)
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    taskType: row.taskType,
    status: row.status,
    deliveryCount: row.deliveryCount,
    cancelRequested: row.cancelRequested,
    error: row.error,
    payload: row.payload,
    agent: row.agentId && row.agentName !== null ? { id: row.agentId, name: row.agentName } : null,
    repository: repositoryLink(row),
    runId: jobRunId(row),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }));
}

/** An organization's recent jobs of every type, newest first, optionally of some statuses and types only. */
export async function listRecentJobs(
  db: Database,
  organizationId: string,
  filter: { statuses?: JobStatus[]; types?: string[]; limit?: number } = {},
): Promise<JobListEntry[]> {
  return selectJobs(db, jobListWhere(organizationId, filter), filter.limit ?? 100);
}

/** One page of an organization's jobs, newest first, optionally of some statuses only. */
export async function listJobs(
  db: Database,
  organizationId: string,
  filter: { statuses?: JobStatus[]; page?: number; pageSize?: number } = {},
): Promise<JobListPage> {
  const pageSize = Math.max(1, Math.floor(filter.pageSize ?? JOB_PAGE_SIZE));
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const where = jobListWhere(organizationId, filter);
  const [[totalRow], rows] = await Promise.all([
    db.select({ total: count() }).from(jobs).where(where),
    selectJobs(db, where, pageSize, (page - 1) * pageSize),
  ]);
  return { jobs: rows, total: totalRow?.total ?? 0, page, pageSize };
}

/**
 * The page of the unfiltered Jobs list that shows the job, or null when the
 * job isn't one of the organization's (or the ID isn't a UUID).
 */
export async function findJobPage(
  db: Database,
  organizationId: string,
  jobId: string,
  pageSize = JOB_PAGE_SIZE,
): Promise<number | null> {
  if (!UUID.test(jobId)) return null;
  const [target] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.organizationId, organizationId)));
  if (!target) return null;
  // Jobs listed before it: newer, or as new with a greater ID (the list's order).
  const [row] = await db
    .select({ before: count() })
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, organizationId),
        sql`(${jobs.createdAt}, ${jobs.id}) > (select j.created_at, j.id from jobs j where j.id = ${jobId})`,
      ),
    );
  return Math.floor((row?.before ?? 0) / Math.max(1, Math.floor(pageSize))) + 1;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Queued jobs only this agent may claim (`target_agent_id`: pinned and `repo.sync` jobs). */
export async function listQueuedJobsTargetingAgent(db: Database, agentId: string): Promise<Job[]> {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), eq(jobs.targetAgentId, agentId)))
    .orderBy(asc(jobs.createdAt));
}

/**
 * Announces an agent online (`live_online`) when the live events last had it offline,
 * recording a live `agent` change. False when it was already online, or is revoked,
 * deleted or unknown: a steady heartbeat records nothing.
 */
export async function markAgentLiveOnline(db: Database, agentId: string): Promise<boolean> {
  const rows = await db
    .update(agents)
    .set({ liveOnline: true })
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.liveOnline, false),
        isNull(agents.revokedAt),
        isNull(agents.deletedAt),
      ),
    )
    .returning({ id: agents.id, organizationId: agents.organizationId });
  for (const row of rows) recordAgentChange(db, row);
  return rows.length > 0;
}

/** The agents the live events last announced online, with their row's last heartbeat. */
export async function listLiveOnlineAgents(
  db: Database,
): Promise<{ id: string; organizationId: string; lastHeartbeatAt: Date | null }[]> {
  return db
    .select({
      id: agents.id,
      organizationId: agents.organizationId,
      lastHeartbeatAt: agents.lastHeartbeatAt,
    })
    .from(agents)
    .where(eq(agents.liveOnline, true));
}

/**
 * Announces agents offline (clears `live_online`), recording a live `agent` change for
 * each that was still online. Returns their IDs.
 */
export async function markAgentsLiveOffline(
  db: Database,
  agentIds: readonly string[],
): Promise<string[]> {
  if (agentIds.length === 0) return [];
  const rows = await db
    .update(agents)
    .set({ liveOnline: false })
    .where(and(inArray(agents.id, [...agentIds]), eq(agents.liveOnline, true)))
    .returning({ id: agents.id, organizationId: agents.organizationId });
  for (const row of rows) recordAgentChange(db, row);
  return rows.map((row) => row.id);
}

/** An attempt (job) an agent claimed, for Fleet's Running now and Recent work. */
export interface AgentAttempt {
  id: string;
  type: string;
  status: JobStatus;
  payload: Record<string, unknown>;
  repository: RepositoryLink | null;
  /** The run the attempt belongs to; null for system work. */
  runId: string | null;
  /** The story a `ralph.story` attempt builds: its identifier, 1-based place and the run's count. */
  story: { identifier: string; number: number; total: number } | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** Statuses of attempts that are over. */
const FINISHED_STATUSES: JobStatus[] = ["completed", "failed", "canceled", "expired", "skipped"];

/**
 * The attempts running on an agent (oldest first) and the last `recentLimit` it finished
 * (newest first), system attempts included. An attempt retried elsewhere counts for the agent
 * that last claimed it.
 */
export async function listAgentAttempts(
  db: Database,
  agentId: string,
  recentLimit = 10,
): Promise<{ running: AgentAttempt[]; recent: AgentAttempt[] }> {
  const columns = {
    id: jobs.id,
    type: jobs.type,
    status: jobs.status,
    payload: jobs.payload,
    ralphRunId: jobs.ralphRunId,
    ralphStoryId: jobs.ralphStoryId,
    reviewRunId: jobs.reviewRunId,
    triageRunId: jobs.triageRunId,
    chatThreadRunId: jobs.chatThreadRunId,
    startedAt: jobs.startedAt,
    finishedAt: jobs.finishedAt,
    ...repositoryLinkColumns,
  };
  const select = () =>
    db
      .select(columns)
      .from(jobs)
      .leftJoin(repositories, eq(repositories.id, jobs.repositoryId))
      .leftJoin(scmConnections, eq(scmConnections.id, repositories.connectionId));
  const [running, recent] = await Promise.all([
    select()
      .where(and(eq(jobs.agentId, agentId), eq(jobs.status, "running")))
      .orderBy(asc(jobs.startedAt), asc(jobs.id)),
    select()
      .where(
        and(
          eq(jobs.agentId, agentId),
          inArray(jobs.status, FINISHED_STATUSES),
          isNotNull(jobs.finishedAt),
        ),
      )
      .orderBy(desc(jobs.finishedAt), desc(jobs.id))
      .limit(recentLimit),
  ]);
  const storyIds = [...new Set([...running, ...recent].flatMap((row) => row.ralphStoryId ?? []))];
  const stories = new Map<string, NonNullable<AgentAttempt["story"]>>();
  if (storyIds.length > 0) {
    // Each story's place among its run's stories, in the epic's order.
    const placed = db.$with("placed").as(
      db
        .select({
          id: ralphStories.id,
          identifier: ralphStories.identifier,
          number:
            sql<number>`row_number() over (partition by ${ralphStories.runId} order by ${ralphStories.position}, ${ralphStories.createdAt}, ${ralphStories.id})`
              .mapWith(Number)
              .as("number"),
          total: sql<number>`count(*) over (partition by ${ralphStories.runId})`
            .mapWith(Number)
            .as("total"),
        })
        .from(ralphStories)
        .where(
          inArray(
            ralphStories.runId,
            db
              .select({ runId: ralphStories.runId })
              .from(ralphStories)
              .where(inArray(ralphStories.id, storyIds)),
          ),
        ),
    );
    const rows = await db.with(placed).select().from(placed).where(inArray(placed.id, storyIds));
    for (const row of rows) {
      stories.set(row.id, { identifier: row.identifier, number: row.number, total: row.total });
    }
  }
  const attempt = (row: (typeof running)[number]): AgentAttempt => ({
    id: row.id,
    type: row.type,
    status: row.status,
    payload: row.payload,
    repository: repositoryLink(row),
    runId: jobRunId(row),
    story: (row.ralphStoryId && stories.get(row.ralphStoryId)) || null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  });
  return { running: running.map(attempt), recent: recent.map(attempt) };
}

/** An agent's token health: its last refresh, and refresh-token reuse and auth failures since `since`. */
export interface AgentSecuritySummary {
  lastTokenRefreshAt: Date | null;
  reuseAlerts: number;
  authFailures: number;
}

export async function getAgentSecuritySummary(
  db: Database,
  agentId: string,
  since: Date,
): Promise<AgentSecuritySummary> {
  const [row] = await db
    .select({
      lastTokenRefreshAt:
        sql<Date | null>`max(${agentAudit.createdAt}) filter (where ${agentAudit.event} = 'token_refresh')`.mapWith(
          (value: string | Date | null) => (value === null ? null : new Date(value)),
        ),
      reuseAlerts:
        sql<number>`count(*) filter (where ${agentAudit.event} = 'refresh_reuse' and ${agentAudit.createdAt} >= ${since})`.mapWith(
          Number,
        ),
      authFailures:
        sql<number>`count(*) filter (where ${agentAudit.event} = 'auth_failed' and ${agentAudit.createdAt} >= ${since})`.mapWith(
          Number,
        ),
    })
    .from(agentAudit)
    .where(eq(agentAudit.agentId, agentId));
  return {
    lastTokenRefreshAt: row?.lastTokenRefreshAt ?? null,
    reuseAlerts: row?.reuseAlerts ?? 0,
    authFailures: row?.authFailures ?? 0,
  };
}
