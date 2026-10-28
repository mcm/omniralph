/**
 * An attempt's usage per model (`attempt_model_usage`), stored from its result's
 * `usage.byModel` in the transaction that stores the result (`completeJob`).
 */
import { eq } from "drizzle-orm";
import { gatewayModelId, mergeModelUsage, TokenUsage } from "@omniralph/shared";
import type { Database } from "./client.js";
import { attemptModelUsage } from "./schema.js";

/** The client or the transaction that stores the result. */
type Writer = Pick<Database, "delete" | "insert">;

export type AttemptModelUsageRow = typeof attemptModelUsage.$inferInsert;

/**
 * One row per model of `result.usage.byModel`; none for a result without it or whose usage
 * doesn't parse. Without a 1-hour split, every cache write is in `cacheWrite5mTokens` and
 * `cacheWrite1hTokens` stays null (unknown, not all 5-minute).
 */
export function attemptModelUsageRows(
  jobId: string,
  result: Record<string, unknown> | null | undefined,
): AttemptModelUsageRow[] {
  const parsed = TokenUsage.safeParse(result?.usage);
  if (!parsed.success || !parsed.data.byModel) return [];
  // The same model twice (a buggy agent) is one row.
  return mergeModelUsage(parsed.data.byModel, []).map((m) => {
    const oneHour =
      m.cacheWrite1hInputTokens === null
        ? null
        : Math.min(m.cacheWrite1hInputTokens, m.cacheCreationInputTokens);
    return {
      jobId,
      model: m.model,
      priceModelId: gatewayModelId(m.canonicalModel ?? m.model),
      inputTokens: m.inputTokens,
      cacheReadTokens: m.cacheReadInputTokens,
      cacheWrite5mTokens: m.cacheCreationInputTokens - (oneHour ?? 0),
      cacheWrite1hTokens: oneHour,
      outputTokens: m.outputTokens,
      largestRequestInputTokens:
        m.largestRequestInputTokens === null
          ? null
          : Math.min(m.largestRequestInputTokens, 2_147_483_647),
      fastMode: m.fastMode,
    };
  });
}

/** Replaces the job's `attempt_model_usage` rows with its result's. */
export async function replaceAttemptModelUsage(
  tx: Writer,
  jobId: string,
  result: Record<string, unknown> | null | undefined,
): Promise<void> {
  await tx.delete(attemptModelUsage).where(eq(attemptModelUsage.jobId, jobId));
  const rows = attemptModelUsageRows(jobId, result);
  if (rows.length > 0) await tx.insert(attemptModelUsage).values(rows);
}
