"use client";

import { toast } from "@omniralph/ui";
import type { QueryKey } from "@tanstack/react-query";
import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import { api, ApiError } from "@/lib/api/client";
import { runDetailSchema, type RunAnswerRequest, type RunDetail } from "@/lib/api/runs";
import { useScopeParam } from "@/screens/scope";
import { inboxDecisionKey, removeFromInbox } from "./use-inbox-decision";

/** An answer to a question that is no longer open (answered elsewhere, expired or replaced). */
export const QUESTION_ANSWERED = "This question was already answered.";

/** A run's cached detail, and not one of its parts (session, transcripts) under the same key. */
function isRunDetail(data: unknown): data is RunDetail {
  return typeof data === "object" && data !== null && "details" in data && "steps" in data;
}

/** Writes `update` into the run's cached detail (not its parts under the same key), when there is one. */
export function updateRunDetail(
  cache: MutationCache,
  key: QueryKey,
  update: (detail: RunDetail) => RunDetail,
): Promise<void> {
  return cache.set<unknown>(key, (previous) =>
    isRunDetail(previous) ? update(previous) : previous,
  );
}

/**
 * Answers a run's open question (`POST /api/ui/runs/{id}/answer` with `{questionKey,
 * optionId}`), from the Inbox or the run detail. Before the server answers, the question's
 * Inbox item leaves its feed and its tab count (the nav count too) drops by one, and the
 * cached run detail loses its question and reads as running; the server's detail then
 * replaces it. A 409 (answered elsewhere first) says so in an info toast and leaves the item
 * removed; any other failure puts everything back with the server's message. It shares the
 * item's mutation key, so the item's other decisions are disabled while it is pending.
 */
export function useRunAnswer(runId: string, questionKey: string) {
  const scope = useScopeParam();
  return useApiMutation<RunDetail | null, RunAnswerRequest>({
    mutationKey: inboxDecisionKey(questionKey),
    mutationFn: async (body, { organizationId }) => {
      try {
        return await api.post(`/api/ui/runs/${encodeURIComponent(runId)}/answer`, runDetailSchema, {
          body,
          organizationId,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) return null;
        throw error;
      }
    },
    optimistic: async (_body, cache) => {
      await removeFromInbox(cache, scope, questionKey);
      await updateRunDetail(cache, cache.keys.runs.detail(runId), (detail) => ({
        ...detail,
        status: "running",
        details: { ...detail.details, question: null },
      }));
    },
    applyResult: async (detail, cache) => {
      if (detail) await updateRunDetail(cache, cache.keys.runs.detail(runId), () => detail);
    },
    invalidate: (keys) => [keys.inbox.all, keys.runs.all],
    success: null,
    onSuccess: (detail) => {
      if (detail === null) toast(QUESTION_ANSWERED, { variant: "info" });
    },
  });
}
