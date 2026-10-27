/**
 * Run analytics (the 2.0 Analytics screen): stories built, review runs, attempts and
 * their success rate, and tokens by run kind, per UTC day or week over the last 7, 30 or
 * 90 days, with totals per repository and per organization. Covers one or more
 * organizations, optionally one repository.
 *
 * The window is `analyticsWindow` (UTC days ending with the day of `now`). Weeks start on
 * Monday (UTC), so the first and last week buckets can cover fewer days than seven: each
 * bucket only counts what falls inside the window.
 *
 * Definitions (stories and epic, request and review tokens are the 1.x Analytics page's,
 * pinned by this module's tests):
 * - Stories built: completed stories of the epic and request runs started in the bucket,
 *   attributed to the run's start.
 * - Review runs: review runs created in the bucket.
 * - Attempts: jobs of a run (epic, request, review, triage or ask) that finished in the
 *   bucket. Success rate = completed / (completed + failed + expired); canceled and
 *   skipped attempts count as finished but not in the rate.
 * - Tokens: review tokens are the reviews' `tokens_in/out`, by the review's creation; epic
 *   and request tokens the `usage` of `ralph.*` jobs, by the job's creation (a job with no
 *   run counts as epic); triage and ask tokens the `usage` of their runs' jobs, by the job's
 *   creation.
 */
import { and, asc, eq, gte, inArray, isNotNull, like, lt, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../client.js";
import { RUN_KINDS, type RunKind } from "../run-index.js";
import {
  jobs,
  organizations,
  ralphRuns,
  ralphStories,
  repositories,
  reviewRuns,
  reviews,
} from "../schema.js";

/** The windows the Analytics screen offers, in days. */
export const ANALYTICS_RANGES = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

/** The bucket sizes the run analytics offer. */
export const RUN_ANALYTICS_BUCKETS = ["day", "week"] as const;
export type RunAnalyticsBucket = (typeof RUN_ANALYTICS_BUCKETS)[number];

export interface AnalyticsRepositoryRef {
  id: string;
  provider: "github" | "gitlab";
  fullPath: string;
}

export interface AnalyticsOrganizationRef {
  id: string;
  name: string;
}

/** A repository of the scope, with its organization (the Analytics screen's filter). */
export interface AnalyticsRepository extends AnalyticsRepositoryRef {
  organization: AnalyticsOrganizationRef;
}

export interface RunAnalyticsFilter {
  /** Only these organizations' runs (at least one). */
  organizationIds: string[];
  days: AnalyticsRange;
  bucket: RunAnalyticsBucket;
  /** Only this repository's runs, attempts and tokens; all repositories when omitted. */
  repositoryId?: string;
  /** End of the window (its UTC day is the last day). Defaults to the current time. */
  now?: Date;
}

export interface RunTokens {
  tokensIn: number;
  tokensOut: number;
}

export interface RunAttempts {
  /** Attempts that ended: completed, failed, expired, canceled or skipped. */
  finished: number;
  completed: number;
  failed: number;
  expired: number;
  /** `completed / (completed + failed + expired)`, 0–1; null when none of those finished. */
  successRate: number | null;
}

export interface RunAnalyticsFigures {
  /** Stories built (completed) by the epic and request runs started in the period. */
  stories: number;
  reviewRuns: number;
  attempts: RunAttempts;
  /** Tokens by run kind. */
  tokens: Record<RunKind, RunTokens>;
}

export interface RunAnalyticsBucketFigures extends RunAnalyticsFigures {
  /** First UTC day of the bucket, `YYYY-MM-DD` (a Monday for weeks). */
  start: string;
}

export interface RunAnalytics {
  /** First instant of the window (UTC midnight). */
  from: Date;
  /** End of the window, exclusive (UTC midnight after the last day). */
  to: Date;
  bucket: RunAnalyticsBucket;
  /** Every bucket that overlaps the window, oldest first, zero-filled. */
  buckets: RunAnalyticsBucketFigures[];
  totals: RunAnalyticsFigures;
  /** Repositories with any activity in the window, with their organization, by full path. */
  byRepository: (RunAnalyticsFigures & {
    repository: AnalyticsRepositoryRef;
    organization: AnalyticsOrganizationRef;
  })[];
  /** Every organization of the filter, by name, zero-filled. */
  byOrganization: (RunAnalyticsFigures & { organization: AnalyticsOrganizationRef })[];
}

const DAY_MS = 86_400_000;

/** UTC midnight that starts the day of `date`. */
function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** `[from, to)` for a window of `days` UTC days ending with the day of `now` (inclusive). */
export function analyticsWindow(days: number, now: Date = new Date()): { from: Date; to: Date } {
  const to = startOfUtcDay(now) + DAY_MS;
  return { from: new Date(to - days * DAY_MS), to: new Date(to) };
}

/**
 * Every repository of `organizationIds` with its organization, by full path, including
 * ones with no activity and disconnected ones (whose history is kept): the Analytics
 * screen's repository filter, and the repositories its `repository` may name.
 */
export async function listAnalyticsRepositories(
  db: Database,
  organizationIds: string[],
): Promise<AnalyticsRepository[]> {
  if (organizationIds.length === 0) return [];
  const rows = await db
    .select({
      id: repositories.id,
      provider: repositories.provider,
      fullPath: repositories.fullPath,
      organizationId: organizations.id,
      organizationName: organizations.name,
    })
    .from(repositories)
    .innerJoin(organizations, eq(organizations.id, repositories.organizationId))
    .where(inArray(repositories.organizationId, organizationIds))
    .orderBy(asc(repositories.fullPath), asc(repositories.id));
  return rows.map(({ organizationId, organizationName, ...repository }) => ({
    ...repository,
    organization: { id: organizationId, name: organizationName },
  }));
}

/** Postgres aggregates come back as strings (bigint/numeric) or null. */
const num = (value: unknown): number => (value == null ? 0 : Number(value));

/** Counts that add up; `successRate` is derived when the figures are read. */
interface Tally {
  stories: number;
  reviewRuns: number;
  finished: number;
  completed: number;
  failed: number;
  expired: number;
  tokens: Record<RunKind, RunTokens>;
}

const emptyTally = (): Tally => ({
  stories: 0,
  reviewRuns: 0,
  finished: 0,
  completed: 0,
  failed: 0,
  expired: 0,
  tokens: Object.fromEntries(RUN_KINDS.map((k) => [k, { tokensIn: 0, tokensOut: 0 }])) as Record<
    RunKind,
    RunTokens
  >,
});

function figures(tally: Tally): RunAnalyticsFigures {
  const rated = tally.completed + tally.failed + tally.expired;
  return {
    stories: tally.stories,
    reviewRuns: tally.reviewRuns,
    attempts: {
      finished: tally.finished,
      completed: tally.completed,
      failed: tally.failed,
      expired: tally.expired,
      successRate: rated === 0 ? null : tally.completed / rated,
    },
    tokens: tally.tokens,
  };
}

/** The bucket (its first UTC day, `YYYY-MM-DD`) of a timestamp column. */
function bucketOf(column: SQL, bucket: RunAnalyticsBucket): SQL<string> {
  return bucket === "day"
    ? sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD')`
    : sql<string>`to_char(date_trunc('week', ${column} at time zone 'UTC'), 'YYYY-MM-DD')`;
}

/** First UTC day of every bucket overlapping `[from, to)`, oldest first. */
export function runAnalyticsBucketStarts(
  from: Date,
  to: Date,
  bucket: RunAnalyticsBucket,
): string[] {
  let start = from.getTime();
  if (bucket === "week") start -= ((from.getUTCDay() + 6) % 7) * DAY_MS;
  const step = bucket === "week" ? 7 * DAY_MS : DAY_MS;
  const starts: string[] = [];
  for (let t = start; t < to.getTime(); t += step) {
    starts.push(new Date(t).toISOString().slice(0, 10));
  }
  return starts;
}

export async function getRunAnalytics(
  db: Database,
  filter: RunAnalyticsFilter,
): Promise<RunAnalytics> {
  const { from, to } = analyticsWindow(filter.days, filter.now);
  const { organizationIds, repositoryId, bucket } = filter;

  const runWhere = and(
    inArray(ralphRuns.organizationId, organizationIds),
    gte(ralphRuns.createdAt, from),
    lt(ralphRuns.createdAt, to),
    repositoryId ? eq(ralphRuns.repositoryId, repositoryId) : undefined,
  );
  const reviewRunWhere = and(
    inArray(reviewRuns.organizationId, organizationIds),
    gte(reviewRuns.createdAt, from),
    lt(reviewRuns.createdAt, to),
    repositoryId ? eq(reviewRuns.repositoryId, repositoryId) : undefined,
  );
  const reviewWhere = and(
    inArray(repositories.organizationId, organizationIds),
    gte(reviews.createdAt, from),
    lt(reviews.createdAt, to),
    repositoryId ? eq(reviews.repositoryId, repositoryId) : undefined,
  );
  const ralphJob = like(jobs.type, "ralph.%");
  const tokenJobWhere = and(
    inArray(jobs.organizationId, organizationIds),
    gte(jobs.createdAt, from),
    lt(jobs.createdAt, to),
    or(ralphJob, isNotNull(jobs.triageRunId), isNotNull(jobs.chatThreadRunId)),
    repositoryId ? eq(jobs.repositoryId, repositoryId) : undefined,
  );
  const finishedAt = sql`coalesce(${jobs.finishedAt}, ${jobs.createdAt})`;
  const attemptWhere = and(
    inArray(jobs.organizationId, organizationIds),
    inArray(jobs.status, ["completed", "failed", "expired", "canceled", "skipped"]),
    sql`${finishedAt} >= ${from.toISOString()}::timestamptz`,
    sql`${finishedAt} < ${to.toISOString()}::timestamptz`,
    or(
      isNotNull(jobs.ralphRunId),
      isNotNull(jobs.reviewRunId),
      isNotNull(jobs.triageRunId),
      isNotNull(jobs.chatThreadRunId),
    ),
    repositoryId ? eq(jobs.repositoryId, repositoryId) : undefined,
  );

  const runBucket = bucketOf(sql`${ralphRuns.createdAt}`, bucket);
  const reviewRunBucket = bucketOf(sql`${reviewRuns.createdAt}`, bucket);
  const reviewBucket = bucketOf(sql`${reviews.createdAt}`, bucket);
  const jobBucket = bucketOf(sql`${jobs.createdAt}`, bucket);
  const attemptBucket = bucketOf(finishedAt, bucket);
  // No bound parameters: the same expression is selected and grouped by.
  const jobKind = sql<"epic" | "request" | "triage" | "ask">`case
    when ${jobs.type} like 'ralph.%' then case when ${ralphRuns.mode} = 'request' then 'request' else 'epic' end
    when ${jobs.triageRunId} is not null then 'triage'
    else 'ask' end`;
  const usage = (field: "inputTokens" | "outputTokens") =>
    sql<string>`sum(coalesce((${jobs.result} -> 'usage' ->> ${sql.raw(`'${field}'`)})::bigint, 0))`;
  const count = (status: string) => sql<string>`count(*) filter (where ${jobs.status} = ${status})`;

  const [storyRows, reviewRunRows, reviewTokenRows, jobTokenRows, attemptRows, organizationRows] =
    await Promise.all([
      db
        .select({
          bucket: runBucket,
          organizationId: ralphRuns.organizationId,
          repositoryId: ralphRuns.repositoryId,
          count: sql<string>`count(*)`,
        })
        .from(ralphStories)
        .innerJoin(ralphRuns, eq(ralphRuns.id, ralphStories.runId))
        .where(and(runWhere, eq(ralphStories.status, "completed")))
        .groupBy(runBucket, ralphRuns.organizationId, ralphRuns.repositoryId),
      db
        .select({
          bucket: reviewRunBucket,
          organizationId: reviewRuns.organizationId,
          repositoryId: reviewRuns.repositoryId,
          count: sql<string>`count(*)`,
        })
        .from(reviewRuns)
        .where(reviewRunWhere)
        .groupBy(reviewRunBucket, reviewRuns.organizationId, reviewRuns.repositoryId),
      db
        .select({
          bucket: reviewBucket,
          organizationId: repositories.organizationId,
          repositoryId: reviews.repositoryId,
          tokensIn: sql<string>`sum(${reviews.tokensIn})`,
          tokensOut: sql<string>`sum(${reviews.tokensOut})`,
        })
        .from(reviews)
        .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
        .where(reviewWhere)
        .groupBy(reviewBucket, repositories.organizationId, reviews.repositoryId),
      db
        .select({
          bucket: jobBucket,
          organizationId: jobs.organizationId,
          repositoryId: jobs.repositoryId,
          kind: jobKind,
          tokensIn: usage("inputTokens"),
          tokensOut: usage("outputTokens"),
        })
        .from(jobs)
        .leftJoin(ralphRuns, eq(ralphRuns.id, jobs.ralphRunId))
        .where(tokenJobWhere)
        .groupBy(jobBucket, jobs.organizationId, jobs.repositoryId, jobKind),
      db
        .select({
          bucket: attemptBucket,
          organizationId: jobs.organizationId,
          repositoryId: jobs.repositoryId,
          finished: sql<string>`count(*)`,
          completed: count("completed"),
          failed: count("failed"),
          expired: count("expired"),
        })
        .from(jobs)
        .where(attemptWhere)
        .groupBy(attemptBucket, jobs.organizationId, jobs.repositoryId),
      db
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(inArray(organizations.id, organizationIds)),
    ]);

  const starts = runAnalyticsBucketStarts(from, to, bucket);
  const byBucket = new Map(starts.map((start) => [start, emptyTally()]));
  const byRepository = new Map<string, Tally>();
  const byOrganization = new Map(organizationRows.map((o) => [o.id, emptyTally()]));
  const totals = emptyTally();

  /** Adds a row's figures to its bucket, repository, organization and the totals. */
  const add = (
    row: { bucket: string; organizationId: string; repositoryId: string | null },
    apply: (tally: Tally) => void,
  ) => {
    let repository: Tally | undefined;
    if (row.repositoryId) {
      repository = byRepository.get(row.repositoryId) ?? emptyTally();
      byRepository.set(row.repositoryId, repository);
    }
    for (const tally of [
      byBucket.get(row.bucket),
      repository,
      byOrganization.get(row.organizationId),
      totals,
    ]) {
      if (tally) apply(tally);
    }
  };
  const addTokens = (tally: Tally, kind: RunKind, row: { tokensIn: string; tokensOut: string }) => {
    tally.tokens[kind].tokensIn += num(row.tokensIn);
    tally.tokens[kind].tokensOut += num(row.tokensOut);
  };

  for (const row of storyRows) add(row, (t) => (t.stories += num(row.count)));
  for (const row of reviewRunRows) add(row, (t) => (t.reviewRuns += num(row.count)));
  for (const row of reviewTokenRows) add(row, (t) => addTokens(t, "review", row));
  for (const row of jobTokenRows) add(row, (t) => addTokens(t, row.kind, row));
  for (const row of attemptRows) {
    add(row, (t) => {
      t.finished += num(row.finished);
      t.completed += num(row.completed);
      t.failed += num(row.failed);
      t.expired += num(row.expired);
    });
  }

  const repositoryRefs =
    byRepository.size === 0
      ? []
      : await db
          .select({
            id: repositories.id,
            provider: repositories.provider,
            fullPath: repositories.fullPath,
            organizationId: repositories.organizationId,
          })
          .from(repositories)
          .where(inArray(repositories.id, [...byRepository.keys()]));
  const organizationNames = new Map(organizationRows.map((o) => [o.id, o.name]));

  return {
    from,
    to,
    bucket,
    buckets: starts.map((start) => ({ start, ...figures(byBucket.get(start)!) })),
    totals: figures(totals),
    byRepository: repositoryRefs
      .sort((a, b) => a.fullPath.localeCompare(b.fullPath))
      .map(({ organizationId, ...repository }) => ({
        repository,
        organization: { id: organizationId, name: organizationNames.get(organizationId) ?? "" },
        ...figures(byRepository.get(repository.id)!),
      })),
    byOrganization: organizationRows
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((organization) => ({ organization, ...figures(byOrganization.get(organization.id)!) })),
  };
}
