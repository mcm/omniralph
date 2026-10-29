/**
 * The turns of a run whose every attempt is a step (triage, ask): a failed run's last turn
 * is what failed, even when its job finished (e.g. the triage's result couldn't be applied).
 */
import type { RunStatus } from "@omniralph/db";

/**
 * `attempts` (newest first) as a run in `status` shows them: when the run failed and its
 * newest attempt completed, that attempt reads failed, so its turn never reads done, and
 * carries `runError` (what the run recorded) when it reported none itself.
 */
export function settleFailedTurn<A extends { status: string; error: string | null }>(
  attempts: readonly A[],
  status: RunStatus,
  runError: string | null = null,
): A[] {
  const [newest, ...rest] = attempts;
  if (status !== "failed" || newest?.status !== "completed") return [...attempts];
  return [{ ...newest, status: "failed", error: newest.error ?? runError }, ...rest];
}
