"use client";

import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import {
  runTriageAnswersResultSchema,
  type RunTriageAnswersRequest,
  type RunTriageAnswersResult,
  type RunTriageSummary,
} from "@/lib/api/runs";

/** The toast of answers the run triages again with now. */
export const ANSWERS_SENT = "Answers sent. Triaging again…";
/** The toast of answers the run keeps until its current triage job is over. */
export const ANSWERS_PENDING =
  "Answers sent. Om will triage again once the current triage finishes.";

/**
 * Answers a triage run's open questions (`POST /api/ui/runs/{id}/triage/answers`), from the
 * Triage card, the View PRD sheet, the Inbox or the work item's PRD tab. A retriage shows at
 * once in the run's cached triage summary (Triaging, nothing left to answer); the run's
 * detail and triage summary, the Inbox and the work items then refetch. A refused send
 * (questions changed, another triage active) shows the server's message.
 */
export function useTriageAnswers(runId: string) {
  return useApiMutation<RunTriageAnswersResult, RunTriageAnswersRequest>({
    mutationFn: (body, { organizationId }) =>
      api.post(
        `/api/ui/runs/${encodeURIComponent(runId)}/triage/answers`,
        runTriageAnswersResultSchema,
        { body, organizationId },
      ),
    applyResult: async (result, cache) => {
      if (result.kind !== "retriage") return;
      await cache.set<RunTriageSummary>(
        cache.keys.runs.part(runId, "triage"),
        (summary) => summary && { ...summary, outcome: "triaging", answerQuestions: false },
      );
    },
    invalidate: (keys) => [keys.runs.detail(runId), keys.inbox.all, keys.workItems.all],
    success: (result) => (result.kind === "retriage" ? ANSWERS_SENT : ANSWERS_PENDING),
  });
}
