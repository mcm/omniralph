/**
 * Harnesses and Jobs pages: the fleet overview, central harness configuration
 * (returned to the harness in its next heartbeat), the audit log and the job list.
 */
import { INSTALL_JOB_TYPE } from "@omniralph/shared";
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
import type { Database } from "./client.js";
import type { HarnessAuditEntry } from "./harness-auth.js";
import type { Job, JobStatus } from "./jobs.js";
import {
  harnessAudit,
  harnessRepoPins,
  harnesses,
  jobs,
  repositories,
  scmConnections,
} from "./schema.js";

type HarnessRow = typeof harnesses.$inferSelect;

/** The repository a job or pin refers to, with what's needed to link to it. */
export interface RepositoryLink {
  id: string;
  provider: "github" | "gitlab";
  fullPath: string;
  /** The connection's base URL (GitLab instance or GitHub API URL). */
  baseUrl: string;
}

export interface HarnessJobSummary {
  id: string;
  type: string;
  taskType: Job["taskType"];
  status: JobStatus;
  payload: Record<string, unknown>;
  repository: RepositoryLink | null;
}

export interface HarnessOverview extends HarnessRow {
  runningJobs: HarnessJobSummary[];
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

async function withJobsAndPins(db: Database, rows: HarnessRow[]): Promise<HarnessOverview[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [running, pins] = await Promise.all([
    db
      .select({
        id: jobs.id,
        harnessId: jobs.harnessId,
        type: jobs.type,
        taskType: jobs.taskType,
        status: jobs.status,
        payload: jobs.payload,
        ...repositoryLinkColumns,
      })
      .from(jobs)
      .leftJoin(repositories, eq(repositories.id, jobs.repositoryId))
      .leftJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
      .where(and(inArray(jobs.harnessId, ids), eq(jobs.status, "running")))
      .orderBy(asc(jobs.startedAt)),
    db
      .select({ harnessId: harnessRepoPins.harnessId, ...repositoryLinkColumns })
      .from(harnessRepoPins)
      .innerJoin(repositories, eq(repositories.id, harnessRepoPins.repositoryId))
      .innerJoin(scmConnections, eq(scmConnections.id, repositories.connectionId))
      .where(inArray(harnessRepoPins.harnessId, ids))
      .orderBy(asc(repositories.fullPath)),
  ]);
  return rows.map((agent) => ({
    ...agent,
    runningJobs: running
      .filter((job) => job.harnessId === agent.id)
      .map((job) => ({
        id: job.id,
        type: job.type,
        taskType: job.taskType,
        status: job.status,
        payload: job.payload,
        repository: repositoryLink(job),
      })),
    pinnedRepositories: pins
      .filter((pin) => pin.harnessId === agent.id)
      .map((pin) => repositoryLink(pin)!),
  }));
}

/**
 * The organization's harnesses (active first, then revoked; by name) with their
 * running jobs and pins. Deleted harnesses are left out.
 */
export async function listHarnessOverview(
  db: Database,
  organizationId: string,
): Promise<HarnessOverview[]> {
  const rows = await db
    .select()
    .from(harnesses)
    .where(and(eq(harnesses.organizationId, organizationId), isNull(harnesses.deletedAt)))
    .orderBy(
      asc(sql`${harnesses.revokedAt} is not null`),
      asc(harnesses.name),
      asc(harnesses.createdAt),
    );
  return withJobsAndPins(db, rows);
}

/** One of the organization's harnesses (null for unknown and deleted harnesses and other organizations'). */
export async function getHarnessOverview(
  db: Database,
  organizationId: string,
  harnessId: string,
): Promise<HarnessOverview | null> {
  const rows = await db
    .select()
    .from(harnesses)
    .where(
      and(
        eq(harnesses.organizationId, organizationId),
        eq(harnesses.id, harnessId),
        isNull(harnesses.deletedAt),
      ),
    );
  const [agent] = await withJobsAndPins(db, rows);
  return agent ?? null;
}

export interface HarnessConfigInput {
  maxConcurrency: number;
  /** Task types the harness may claim jobs of (`system` is always accepted). */
  acceptedTaskTypes: Job["taskType"][];
  /** Per-pool concurrency limits; pools left out use the default. */
  poolLimits: Partial<Record<string, number>>;
}

/**
 * Updates a harness's central configuration. The harness picks it up from its
 * next heartbeat response. Returns null for unknown or revoked harnesses and
 * harnesses of another organization.
 */
export async function updateHarnessConfig(
  db: Database,
  organizationId: string,
  harnessId: string,
  input: HarnessConfigInput,
): Promise<HarnessRow | null> {
  const [row] = await db
    .update(harnesses)
    .set({
      maxConcurrency: input.maxConcurrency,
      acceptedTaskTypes: [...new Set(input.acceptedTaskTypes)],
      poolLimits: input.poolLimits,
    })
    .where(
      and(
        eq(harnesses.organizationId, organizationId),
        eq(harnesses.id, harnessId),
        isNull(harnesses.revokedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Sets (or, with null, clears) a harness's desired-version override. Returns
 * null for unknown or revoked harnesses and harnesses of another organization.
 */
export async function setHarnessDesiredVersion(
  db: Database,
  organizationId: string,
  harnessId: string,
  version: string | null,
): Promise<HarnessRow | null> {
  const [row] = await db
    .update(harnesses)
    .set({ desiredVersion: version })
    .where(
      and(
        eq(harnesses.organizationId, organizationId),
        eq(harnesses.id, harnessId),
        isNull(harnesses.revokedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Asks a harness to update to `version` now (an admin's "Update now"), replacing
 * any request it hasn't acted on yet. The harness gets it with its next heartbeat
 * and reports it handled, which clears it. Returns null for unknown or revoked
 * harnesses and harnesses of another organization.
 */
export async function requestHarnessUpdate(
  db: Database,
  organizationId: string,
  harnessId: string,
  version: string,
  now: Date = new Date(),
): Promise<HarnessRow | null> {
  const [row] = await db
    .update(harnesses)
    .set({
      updateRequestId: sql`gen_random_uuid()`,
      updateRequestVersion: version,
      updateRequestedAt: now,
    })
    .where(
      and(
        eq(harnesses.organizationId, organizationId),
        eq(harnesses.id, harnessId),
        isNull(harnesses.revokedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Soft-deletes a revoked harness: it's hidden from the Harnesses pages from then on.
 * Returns false for unknown, active or already deleted harnesses and harnesses of
 * another organization.
 */
export async function markHarnessDeleted(
  db: Database,
  organizationId: string,
  harnessId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(harnesses)
    .set({ deletedAt: now })
    .where(
      and(
        eq(harnesses.organizationId, organizationId),
        eq(harnesses.id, harnessId),
        isNotNull(harnesses.revokedAt),
        isNull(harnesses.deletedAt),
      ),
    )
    .returning({ id: harnesses.id });
  return rows.length > 0;
}

/** A harness's most recent audit events, newest first. */
export async function listRecentHarnessAudit(
  db: Database,
  harnessId: string,
  limit = 50,
): Promise<HarnessAuditEntry[]> {
  return db
    .select()
    .from(harnessAudit)
    .where(eq(harnessAudit.harnessId, harnessId))
    .orderBy(desc(harnessAudit.createdAt), desc(harnessAudit.id))
    .limit(limit);
}

/** An `install` job targeted at a harness, for its detail page. */
export interface HarnessInstallJob {
  id: string;
  status: JobStatus;
  /** The payload's package name and version (null: `latest`). */
  name: string | null;
  version: string | null;
  /** The version the harness installed, from the job's result. */
  installedVersion: string | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/** The `install` jobs targeted at a harness of the organization since `since`, newest first. */
export async function listHarnessInstallJobs(
  db: Database,
  organizationId: string,
  harnessId: string,
  since: Date,
  limit = 50,
): Promise<HarnessInstallJob[]> {
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
        eq(jobs.targetHarnessId, harnessId),
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
      harnessId: harnesses.id,
      harnessName: harnesses.name,
      createdAt: jobs.createdAt,
      startedAt: jobs.startedAt,
      finishedAt: jobs.finishedAt,
      ...repositoryLinkColumns,
    })
    .from(jobs)
    .leftJoin(harnesses, eq(harnesses.id, jobs.harnessId))
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
    agent:
      row.harnessId && row.harnessName !== null
        ? { id: row.harnessId, name: row.harnessName }
        : null,
    repository: repositoryLink(row),
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

/** Queued jobs only this harness may claim (`target_harness_id`: pinned and `repo.sync` jobs). */
export async function listQueuedJobsTargetingHarness(
  db: Database,
  harnessId: string,
): Promise<Job[]> {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), eq(jobs.targetHarnessId, harnessId)))
    .orderBy(asc(jobs.createdAt));
}
