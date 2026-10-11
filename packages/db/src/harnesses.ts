/**
 * Harnesses and Jobs pages: the fleet overview, central harness configuration
 * (returned to the harness in its next heartbeat), the audit log and the job list.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { legacyHarnessRouting } from "@omniralph/shared";
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
  capability: string;
  type: string;
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
        capability: jobs.capability,
        type: jobs.type,
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
        capability: job.capability,
        type: job.type,
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
  enabledCapabilities: string[];
  /** Per-capability concurrency limits; capabilities left out use the default. */
  capabilityLimits?: Partial<Record<string, number>>;
}

/**
 * Updates a harness's central configuration. The harness picks it up from its
 * next heartbeat response. Its accepted task types (and, when limits are
 * given, its pool limits) follow from the capabilities (`legacyHarnessRouting`). Returns null for unknown or revoked harnesses and
 * harnesses of another organization.
 */
export async function updateHarnessConfig(
  db: Database,
  organizationId: string,
  harnessId: string,
  input: HarnessConfigInput,
): Promise<HarnessRow | null> {
  const routing = legacyHarnessRouting(input.enabledCapabilities, input.capabilityLimits ?? {});
  const [row] = await db
    .update(harnesses)
    .set({
      maxConcurrency: input.maxConcurrency,
      enabledCapabilities: [...new Set(input.enabledCapabilities)],
      acceptedTaskTypes: routing.acceptedTaskTypes,
      ...(input.capabilityLimits && {
        capabilityLimits: input.capabilityLimits,
        poolLimits: routing.poolLimits,
      }),
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

/** An organization's recent jobs across capabilities, newest first, optionally of some statuses and types only. */
export async function listRecentJobs(
  db: Database,
  organizationId: string,
  filter: { statuses?: JobStatus[]; types?: string[]; limit?: number } = {},
): Promise<JobListEntry[]> {
  const where = and(
    eq(jobs.organizationId, organizationId),
    filter.statuses && filter.statuses.length > 0
      ? inArray(jobs.status, filter.statuses)
      : undefined,
    filter.types && filter.types.length > 0 ? inArray(jobs.type, filter.types) : undefined,
  );
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
