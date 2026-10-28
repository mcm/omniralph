/**
 * Attempts' list prices (the `attempt_costs` view, migration 0112): each attempt's
 * `attempt_model_usage` × the `model_prices` in effect at its `finished_at`, computed at read
 * time, so a model first listed after its attempts ran prices them too while a price change
 * never touches earlier attempts. An attempt with any model that can't be priced exactly, or
 * with no usage per model (every attempt from before agents reported it), has no figure.
 * These are the only readers of the view.
 */
import { inArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Database } from "../client.js";
import { attemptCosts } from "../schema.js";

/**
 * 1-hour cache writes cost this many times the model's base input price, for every model
 * (Anthropic's pricing page, https://docs.anthropic.com/en/docs/about-claude/pricing). The AI
 * Gateway lists no 1-hour price, so the view applies it to the stored input price.
 */
export const ONE_HOUR_CACHE_WRITE_MULTIPLIER = 2;

/** `numeric` comes back as a string, or null. */
const usd = (value: string | null | undefined): number | null =>
  value == null ? null : Number(value);

/** Each job's list price in USD; null when it has none (every ID of `jobIds` is a key). */
export async function costForJobs(
  db: Pick<Database, "select">,
  jobIds: readonly string[],
): Promise<Map<string, number | null>> {
  const costs = new Map<string, number | null>(jobIds.map((id) => [id, null]));
  if (jobIds.length === 0) return costs;
  const rows = await db
    .select({ jobId: attemptCosts.jobId, costUsd: attemptCosts.costUsd })
    .from(attemptCosts)
    .where(inArray(attemptCosts.jobId, [...new Set(jobIds)]));
  for (const row of rows) costs.set(row.jobId, usd(row.costUsd));
  return costs;
}

/** The list price (numeric, USD) of the job `jobId`, or null: for queries that aggregate it. */
export function attemptCostOf(jobId: AnyPgColumn | SQL): SQL<string | null> {
  return sql<string | null>`(select ac.cost_usd from attempt_costs ac where ac.job_id = ${jobId})`;
}
