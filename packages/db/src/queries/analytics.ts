/**
 * Usage analytics (the control panel's Analytics page): token usage, review
 * counts, finding severities, dismissal rates and jobs per agent over the last
 * 7, 30 or 90 days for one organization, optionally for one repository.
 *
 * Days are UTC calendar days. A window of `days` days ends with the day of
 * `now` (inclusive), so a 7-day window is today plus the six days before it.
 * Reviews and their findings are attributed to the day the review was created,
 * jobs to the day the job was created.
 */
import { and, asc, eq, gte, inArray, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import type { Database } from "../client.js";
import type { Review } from "../reviews.js";
import {
  agents,
  feedback,
  findings,
  findingSeverity,
  jobs,
  repositories,
  reviewProfiles,
  reviews,
  reviewStatus,
} from "../schema.js";

/** The windows the Analytics page offers, in days. */
export const ANALYTICS_RANGES = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

type FindingSeverity = (typeof findingSeverity.enumValues)[number];

const DAY_MS = 86_400_000;

export interface AnalyticsFilter {
  /** Only this organization's reviews, findings, jobs and runs. */
  organizationId: string;
  days: AnalyticsRange;
  /** Only this repository's reviews, findings and jobs; all repositories when omitted. */
  repositoryId?: string;
  /** End of the window (its UTC day is the last day). Defaults to the current time. */
  now?: Date;
}

export interface AnalyticsRepositoryRef {
  id: string;
  provider: "github" | "gitlab";
  fullPath: string;
}

export interface DailyUsage {
  /** UTC day, `YYYY-MM-DD`. */
  date: string;
  reviews: number;
  tokensIn: number;
  tokensOut: number;
}

export interface ProfileUsage {
  /** Null for reviews whose profile was deleted. */
  profileId: string | null;
  profileName: string | null;
  /** Reviews that ran to the end (`completed` or `budget_exhausted`). */
  reviews: number;
  /** Mean tokens in + out of those reviews (0 when there are none). */
  averageTokens: number;
}

export interface RepositoryDismissals {
  repository: AnalyticsRepositoryRef;
  /** Findings raised, not counting ones superseded by a fresh review. */
  findings: number;
  /** Of those, currently dismissed. */
  dismissed: number;
  /** Dismissed findings with an active (not restored) false-positive dismissal. */
  falsePositives: number;
  /** `dismissed / findings`, 0–1. */
  dismissalRate: number;
}

export interface AgentJobs {
  agent: { id: string; name: string };
  total: number;
  completed: number;
  failed: number;
}

export interface Analytics {
  /** First instant of the window (UTC midnight). */
  from: Date;
  /** End of the window, exclusive (UTC midnight after the last day). */
  to: Date;
  totals: { reviews: number; tokensIn: number; tokensOut: number };
  /** One entry per UTC day in the window, oldest first, zero-filled. */
  daily: DailyUsage[];
  /** Profiles that ran at least one review in the window, by name. */
  byProfile: ProfileUsage[];
  reviewsByStatus: Record<Review["status"], number>;
  findingsBySeverity: Record<FindingSeverity, number>;
  /** Repositories with findings in the window, highest dismissal rate first. */
  dismissalsByRepository: RepositoryDismissals[];
  /** Agents that were assigned jobs in the window, most jobs first. */
  jobsByAgent: AgentJobs[];
}

/** UTC midnight that starts the day of `date`. */
function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** `[from, to)` for a window of `days` UTC days ending with the day of `now`. */
export function analyticsWindow(days: number, now: Date = new Date()): { from: Date; to: Date } {
  const to = startOfUtcDay(now) + DAY_MS;
  return { from: new Date(to - days * DAY_MS), to: new Date(to) };
}

/** Postgres aggregates come back as strings (bigint/numeric) or null. */
const num = (value: unknown): number => (value == null ? 0 : Number(value));

export async function getAnalytics(db: Database, filter: AnalyticsFilter): Promise<Analytics> {
  const { from, to } = analyticsWindow(filter.days, filter.now);
  const reviewWhere: SQL = and(
    inArray(
      reviews.repositoryId,
      db
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.organizationId, filter.organizationId)),
    ),
    gte(reviews.createdAt, from),
    lt(reviews.createdAt, to),
    filter.repositoryId ? eq(reviews.repositoryId, filter.repositoryId) : undefined,
  )!;
  const jobWhere: SQL = and(
    eq(jobs.organizationId, filter.organizationId),
    gte(jobs.createdAt, from),
    lt(jobs.createdAt, to),
    isNotNull(jobs.agentId),
    filter.repositoryId ? eq(jobs.repositoryId, filter.repositoryId) : undefined,
  )!;

  const day = sql<string>`to_char(${reviews.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const ran = sql`${reviews.status} in ('completed', 'budget_exhausted')`;
  const activeFalsePositive = sql`exists (
    select 1 from ${feedback}
    where ${feedback.findingId} = ${findings.id}
      and ${feedback.reason} = 'false_positive'
      and ${feedback.restoredAt} is null
  )`;

  const [dailyRows, profileRows, statusRows, severityRows, dismissalRows, agentRows] =
    await Promise.all([
      db
        .select({
          day,
          reviews: sql<string>`count(*)`,
          tokensIn: sql<string>`sum(${reviews.tokensIn})`,
          tokensOut: sql<string>`sum(${reviews.tokensOut})`,
        })
        .from(reviews)
        .where(reviewWhere)
        .groupBy(day),
      db
        .select({
          profileId: reviews.profileId,
          profileName: reviewProfiles.name,
          reviews: sql<string>`count(*) filter (where ${ran})`,
          averageTokens: sql<string>`avg(${reviews.tokensIn} + ${reviews.tokensOut}) filter (where ${ran})`,
        })
        .from(reviews)
        .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
        .leftJoin(
          reviewProfiles,
          and(
            eq(reviewProfiles.organizationId, repositories.organizationId),
            eq(reviewProfiles.id, reviews.profileId),
          ),
        )
        .where(reviewWhere)
        .groupBy(reviews.profileId, reviewProfiles.name)
        .orderBy(asc(reviewProfiles.name)),
      db
        .select({ status: reviews.status, count: sql<string>`count(*)` })
        .from(reviews)
        .where(reviewWhere)
        .groupBy(reviews.status),
      db
        .select({ severity: findings.severity, count: sql<string>`count(*)` })
        .from(findings)
        .innerJoin(reviews, eq(reviews.id, findings.reviewId))
        .where(reviewWhere)
        .groupBy(findings.severity),
      db
        .select({
          id: repositories.id,
          provider: repositories.provider,
          fullPath: repositories.fullPath,
          findings: sql<string>`count(*) filter (where ${findings.status} <> 'superseded')`,
          dismissed: sql<string>`count(*) filter (where ${findings.status} = 'dismissed')`,
          falsePositives: sql<string>`count(*) filter (where ${findings.status} = 'dismissed' and ${activeFalsePositive})`,
        })
        .from(findings)
        .innerJoin(reviews, eq(reviews.id, findings.reviewId))
        .innerJoin(repositories, eq(repositories.id, reviews.repositoryId))
        .where(reviewWhere)
        .groupBy(repositories.id, repositories.provider, repositories.fullPath),
      db
        .select({
          id: agents.id,
          name: agents.name,
          total: sql<string>`count(*)`,
          completed: sql<string>`count(*) filter (where ${jobs.status} = 'completed')`,
          failed: sql<string>`count(*) filter (where ${jobs.status} = 'failed')`,
        })
        .from(jobs)
        .innerJoin(agents, eq(agents.id, jobs.agentId))
        .where(jobWhere)
        .groupBy(agents.id, agents.name),
    ]);

  const byDay = new Map(dailyRows.map((row) => [row.day, row]));
  const daily: DailyUsage[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    const row = byDay.get(date);
    daily.push({
      date,
      reviews: num(row?.reviews),
      tokensIn: num(row?.tokensIn),
      tokensOut: num(row?.tokensOut),
    });
  }

  const reviewsByStatus = Object.fromEntries(reviewStatus.enumValues.map((s) => [s, 0])) as Record<
    Review["status"],
    number
  >;
  for (const row of statusRows) reviewsByStatus[row.status] = num(row.count);

  const findingsBySeverity = Object.fromEntries(
    findingSeverity.enumValues.map((s) => [s, 0]),
  ) as Record<FindingSeverity, number>;
  for (const row of severityRows) findingsBySeverity[row.severity] = num(row.count);

  return {
    from,
    to,
    totals: {
      reviews: daily.reduce((sum, d) => sum + d.reviews, 0),
      tokensIn: daily.reduce((sum, d) => sum + d.tokensIn, 0),
      tokensOut: daily.reduce((sum, d) => sum + d.tokensOut, 0),
    },
    daily,
    byProfile: profileRows.map((row) => ({
      profileId: row.profileId,
      profileName: row.profileName,
      reviews: num(row.reviews),
      averageTokens: Math.round(num(row.averageTokens)),
    })),
    reviewsByStatus,
    findingsBySeverity,
    dismissalsByRepository: dismissalRows
      .map((row) => {
        const total = num(row.findings);
        const dismissed = num(row.dismissed);
        return {
          repository: { id: row.id, provider: row.provider, fullPath: row.fullPath },
          findings: total,
          dismissed,
          falsePositives: num(row.falsePositives),
          dismissalRate: total === 0 ? 0 : dismissed / total,
        };
      })
      .filter((row) => row.findings > 0)
      .sort(
        (a, b) =>
          b.dismissalRate - a.dismissalRate ||
          b.findings - a.findings ||
          a.repository.fullPath.localeCompare(b.repository.fullPath),
      ),
    jobsByAgent: agentRows
      .map((row) => ({
        agent: { id: row.id, name: row.name },
        total: num(row.total),
        completed: num(row.completed),
        failed: num(row.failed),
      }))
      .sort((a, b) => b.total - a.total || a.agent.name.localeCompare(b.agent.name)),
  };
}

/**
 * An organization's repositories for the Analytics filter (including
 * disconnected ones, whose history is kept).
 */
export async function listAnalyticsRepositories(
  db: Database,
  organizationId: string,
): Promise<AnalyticsRepositoryRef[]> {
  return db
    .select({
      id: repositories.id,
      provider: repositories.provider,
      fullPath: repositories.fullPath,
    })
    .from(repositories)
    .where(eq(repositories.organizationId, organizationId))
    .orderBy(asc(repositories.fullPath));
}
