import { z } from "zod";
import {
  ANALYTICS_RANGES,
  RALPH_RUN_OUTCOMES,
  RALPH_STORY_OUTCOMES,
  RUN_ANALYTICS_BUCKETS,
  type AnalyticsData,
  type AnalyticsParams,
  type RalphAnalyticsData,
  type RunAnalyticsData,
} from "@/lib/analytics/display";
import { FINDING_SEVERITIES, REVIEW_STATUSES } from "@/lib/reviews/display";
import { RUN_KINDS } from "./runs";
import { isoDate } from "./schemas";

/** Wire format of the Analytics endpoint under `/api/ui`. */

/** A record of counts with exactly `names` as its keys. */
function counts<const K extends string>(names: readonly K[]) {
  return z.object(
    Object.fromEntries(names.map((name) => [name, z.number()])) as Record<K, z.ZodNumber>,
  );
}

const repository = z.object({
  id: z.string(),
  provider: z.enum(["github", "gitlab"]),
  fullPath: z.string(),
});
/** A repository the figures name (a chart's link, the filter's choices). */
export type AnalyticsRepository = z.infer<typeof repository>;

/** `AnalyticsData` on the wire: reviews, findings and jobs over the window. */
export const analyticsDataSchema = z.object({
  from: isoDate,
  to: isoDate,
  totals: z.object({ reviews: z.number(), tokensIn: z.number(), tokensOut: z.number() }),
  daily: z.array(
    z.object({
      date: z.string(),
      reviews: z.number(),
      tokensIn: z.number(),
      tokensOut: z.number(),
    }),
  ),
  byProfile: z.array(
    z.object({
      profileId: z.string().nullable(),
      profileName: z.string().nullable(),
      reviews: z.number(),
      averageTokens: z.number(),
    }),
  ),
  reviewsByStatus: counts(REVIEW_STATUSES),
  findingsBySeverity: counts(FINDING_SEVERITIES),
  dismissalsByRepository: z.array(
    z.object({
      repository,
      findings: z.number(),
      dismissed: z.number(),
      falsePositives: z.number(),
      dismissalRate: z.number(),
    }),
  ),
  jobsByHarness: z.array(
    z.object({
      agent: z.object({ id: z.string(), name: z.string() }),
      total: z.number(),
      completed: z.number(),
      failed: z.number(),
    }),
  ),
}) satisfies z.ZodType<AnalyticsData>;

/** `RalphAnalyticsData` on the wire: coding jobs, runs and stories over the window. */
export const ralphAnalyticsDataSchema = z.object({
  from: isoDate,
  to: isoDate,
  totals: z.object({
    runs: z.number(),
    jobs: z.number(),
    tokensIn: z.number(),
    tokensOut: z.number(),
  }),
  daily: z.array(
    z.object({
      date: z.string(),
      tokensIn: z.number(),
      tokensOut: z.number(),
      runs: counts(RALPH_RUN_OUTCOMES),
      stories: counts(RALPH_STORY_OUTCOMES),
    }),
  ),
  runsByOutcome: counts(RALPH_RUN_OUTCOMES),
  storyOutcomes: counts(RALPH_STORY_OUTCOMES),
  averageAttempts: z.number(),
}) satisfies z.ZodType<RalphAnalyticsData>;

/**
 * `GET /api/ui/analytics?days=&repo=`: the Analytics page for the window and repository,
 * with every repository for the filter and the filter as the server applied it (another
 * organization's or an unknown repository is ignored).
 */
export const analyticsResponseSchema = z.object({
  analytics: analyticsDataSchema,
  ralph: ralphAnalyticsDataSchema,
  repositories: z.array(repository),
  params: z.object({
    days: z.literal(ANALYTICS_RANGES),
    repositoryId: z.string().nullable(),
  }) satisfies z.ZodType<AnalyticsParams>,
});
export type AnalyticsResponse = z.infer<typeof analyticsResponseSchema>;

/**
 * `GET /api/ui/analytics/runs` query: the window (7, 30 or 90 days; default 30), the bucket
 * (`day` or `week`; default `day`), an optional repository and the organization scope (the
 * active organization, one of the user's, or `all`).
 */
export const runAnalyticsQuerySchema = z.object({
  days: z
    .enum(["7", "30", "90"], { error: "days must be 7, 30 or 90." })
    .default("30")
    .transform((days) => Number(days) as (typeof ANALYTICS_RANGES)[number]),
  bucket: z.enum(RUN_ANALYTICS_BUCKETS, { error: "bucket must be day or week." }).default("day"),
  repository: z.uuid({ error: "repository must be a repository ID." }).optional(),
  organization: z.string().optional(),
});

const runTokens = z.object({ tokensIn: z.number(), tokensOut: z.number() });

/** Stories, review runs, attempts and tokens by run kind over a period. */
const runAnalyticsFigures = {
  stories: z.number(),
  reviewRuns: z.number(),
  attempts: z.object({
    finished: z.number(),
    completed: z.number(),
    failed: z.number(),
    expired: z.number(),
    /** completed / (completed + failed + expired); null when none of those finished. */
    successRate: z.number().nullable(),
  }),
  tokens: z.object(
    Object.fromEntries(RUN_KINDS.map((kind) => [kind, runTokens])) as Record<
      (typeof RUN_KINDS)[number],
      typeof runTokens
    >,
  ),
};

/**
 * `GET /api/ui/analytics/runs?days=&bucket=&repository=&organization=`: per UTC day or
 * (Monday-started) week, every bucket of the window zero-filled, with totals, per
 * repository and per organization.
 */
export const runAnalyticsSchema = z.object({
  from: isoDate,
  to: isoDate,
  bucket: z.enum(RUN_ANALYTICS_BUCKETS),
  buckets: z.array(z.object({ start: z.string(), ...runAnalyticsFigures })),
  totals: z.object(runAnalyticsFigures),
  byRepository: z.array(z.object({ repository, ...runAnalyticsFigures })),
  byOrganization: z.array(
    z.object({
      organization: z.object({ id: z.string(), name: z.string() }),
      ...runAnalyticsFigures,
    }),
  ),
}) satisfies z.ZodType<RunAnalyticsData>;
export type RunAnalyticsResponse = z.infer<typeof runAnalyticsSchema>;
