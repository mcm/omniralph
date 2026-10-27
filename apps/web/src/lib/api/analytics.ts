import { z } from "zod";
import {
  ANALYTICS_RANGES,
  RUN_ANALYTICS_BUCKETS,
  type RunAnalyticsPayload,
} from "@/lib/analytics/display";
import { RUN_KINDS } from "./runs";
import { isoDate } from "./schemas";

/** Wire format of the Analytics endpoint under `/api/ui`. */

/**
 * `GET /api/ui/analytics/runs` query: the window (7, 30 or 90 days; default 30), the bucket
 * (`day` or `week`; default `day`), an optional repository and the organization scope (the
 * active organization, one of the user's, or `all`). A repository outside the scope (or not
 * a repository ID) is ignored, not rejected.
 */
export const runAnalyticsQuerySchema = z.object({
  days: z
    .enum(["7", "30", "90"], { error: "days must be 7, 30 or 90." })
    .default("30")
    .transform((days) => Number(days) as (typeof ANALYTICS_RANGES)[number]),
  bucket: z.enum(RUN_ANALYTICS_BUCKETS, { error: "bucket must be day or week." }).default("day"),
  repository: z.string().optional(),
  organization: z.string().optional(),
});

/**
 * The dollar cost of a sum of tokens, at Anthropic's API list prices (not what was billed),
 * with the attempts it leaves out. Epic 12 sets both server-side; until then the route sends
 * neither, and the screen shows nothing about cost.
 */
const cost = {
  /**
   * Epic 12: what the priced tokens of the sum would cost at Anthropic's API list prices, in
   * US dollars. It covers priced tokens only: attempts whose model has no list price are left
   * out (`unpricedAttempts`).
   */
  costUsd: z.number().nonnegative().optional(),
  /** Epic 12: token-bearing attempts of the sum left out of `costUsd` (no list price). */
  unpricedAttempts: z.number().int().positive().optional(),
};

const runTokens = z.object({ tokensIn: z.number(), tokensOut: z.number(), ...cost });

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
  /** Tokens (and, with Epic 12, their cost) by run kind: the "By kind" rows. */
  tokens: z.object(
    Object.fromEntries(RUN_KINDS.map((kind) => [kind, runTokens])) as Record<
      (typeof RUN_KINDS)[number],
      typeof runTokens
    >,
  ),
  ...cost,
};

const repository = z.object({
  id: z.string(),
  provider: z.enum(["github", "gitlab"]),
  fullPath: z.string(),
});
const organization = z.object({ id: z.string(), name: z.string() });

/**
 * `GET /api/ui/analytics/runs?days=&bucket=&repository=&organization=`: per UTC day or
 * (Monday-started) week, every bucket of the window zero-filled, with totals, per
 * repository (with its organization) and per organization; every repository of the scope
 * for the filter, and the filters as applied.
 */
export const runAnalyticsResponseSchema = z.object({
  from: isoDate,
  to: isoDate,
  bucket: z.enum(RUN_ANALYTICS_BUCKETS),
  buckets: z.array(z.object({ start: z.string(), ...runAnalyticsFigures })),
  totals: z.object(runAnalyticsFigures),
  byRepository: z.array(z.object({ repository, organization, ...runAnalyticsFigures })),
  byOrganization: z.array(z.object({ organization, ...runAnalyticsFigures })),
  repositories: z.array(repository.extend({ organization })),
  params: z.object({
    days: z.literal(ANALYTICS_RANGES),
    bucket: z.enum(RUN_ANALYTICS_BUCKETS),
    repositoryId: z.string().nullable(),
  }),
}) satisfies z.ZodType<RunAnalyticsPayload>;
export type RunAnalyticsResponse = z.infer<typeof runAnalyticsResponseSchema>;
export type RunAnalyticsFiguresResponse = RunAnalyticsResponse["totals"];
export type RunAnalyticsRepositoryRow = RunAnalyticsResponse["byRepository"][number];
export type RunAnalyticsOrganizationRow = RunAnalyticsResponse["byOrganization"][number];
export type RunAnalyticsRepositoryOption = RunAnalyticsResponse["repositories"][number];
