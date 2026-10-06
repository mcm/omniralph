/**
 * Replies in a run's agent session. Every reply is stored as the run's
 * guidance (added to the next story prompts) and the run is advanced; a reply
 * to a run whose PR/MR step failed retries that step.
 *
 * Stop, "start anyway" and preparation answers are handled separately (FR-15).
 */
import { appendGuidance, getRunBySession, lockRun, updateRun } from "@omniralph/db";
import type { LinearWebhookEvent } from "@/lib/linear/webhook";
import { advanceRun, FINISHED_RUN_STATUSES, type AdvanceResult, type RalphDeps } from "./run";

export type SessionPromptedEvent = Extract<LinearWebhookEvent, { kind: "session_prompted" }>;

export async function handleReply(
  event: SessionPromptedEvent,
  deps: RalphDeps,
): Promise<AdvanceResult | null> {
  const text = event.body.trim();
  if (!text || event.signal === "stop") return null;
  const run = await getRunBySession(deps.db, event.sessionId);
  if (!run || FINISHED_RUN_STATUSES.has(run.status)) return null;
  const stored = await lockRun(deps.db, run.id, async (tx, current) => {
    if (FINISHED_RUN_STATUSES.has(current.status)) return false;
    await appendGuidance(tx, current.id, text);
    // A waiting run's error is a failed PR/MR step: clearing it retries the step.
    if (current.status === "waiting" && current.error) {
      await updateRun(tx, current.id, { error: null });
    }
    return true;
  });
  if (!stored) return null;
  return advanceRun(run.id, deps);
}
