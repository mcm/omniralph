"use client";

import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import {
  runRetryResultSchema,
  type RunDetail,
  type RunRetryResult,
  type RunRetryTarget,
  type RunStep,
} from "@/lib/api/runs";
import { mutationResultSchema, type MutationResult } from "@/lib/api/schemas";
import { stepState } from "./progress";
import { updateRunDetail } from "./use-run-answer";

const runPath = (runId: string, action: "stop" | "retry") =>
  `/api/ui/runs/${encodeURIComponent(runId)}/${action}`;

/** The mutation key of a run's retries, so every retry button of the run can disable. */
export function runRetryKey(runId: string) {
  return ["run-retry", runId] as const;
}

/**
 * The step a retry starts again: the story or attempt it targets; for the whole run, the
 * selected step unless it is done, else the first step that isn't done.
 */
export function retriedStepId(
  steps: readonly RunStep[],
  target: RunRetryTarget,
  selectedStepId: string | undefined,
): string | undefined {
  if (target.kind === "story") return target.storyId;
  if (target.kind === "attempt") return target.attemptId;
  const selected = steps.find((step) => step.id === selectedStepId);
  if (selected && stepState(selected.status) !== "done") return selected.id;
  return steps.find((step) => stepState(step.status) !== "done")?.id;
}

export interface RunRetryVariables {
  target: RunRetryTarget;
  /** The step selected in the view, for a retry of the whole run. */
  selectedStepId?: string;
}

/** A step marked running (every step kind has the `running` status). */
const running = (step: RunStep): RunStep => ({ ...step, status: "running" }) as RunStep;

/**
 * Retries a run, one of its stories or one of its attempts (`POST /api/ui/runs/{id}/retry`
 * with `{target}`). Before the server answers, the run reads as queued and the retried step
 * as running; the server's detail then replaces it. A failure (409 "Om is already working on
 * this run.", a merged PR/MR…) puts it back with the server's message. A review's retry may
 * answer another run (the review of the PR's current head): `onRetried` gets that run.
 */
export function useRunRetry(runId: string, onRetried?: (result: RunRetryResult) => void) {
  return useApiMutation<RunRetryResult, RunRetryVariables>({
    mutationKey: runRetryKey(runId),
    mutationFn: ({ target }, { organizationId }) =>
      api.post(runPath(runId, "retry"), runRetryResultSchema, {
        body: { target },
        organizationId,
      }),
    optimistic: ({ target, selectedStepId }, cache) =>
      updateRunDetail(cache, cache.keys.runs.detail(runId), (detail): RunDetail => {
        const stepId = retriedStepId(detail.steps, target, selectedStepId);
        return {
          ...detail,
          status: "queued",
          steps: detail.steps.map((step) => (step.id === stepId ? running(step) : step)),
        };
      }),
    applyResult: async (result, cache) => {
      if (result.id !== runId) return;
      const { warning: _warning, ...detail } = result;
      await updateRunDetail(cache, cache.keys.runs.detail(runId), () => detail);
    },
    invalidate: (keys) => [keys.runs.all, keys.inbox.all],
    success: null,
    onSuccess: (result) => onRetried?.(result),
  });
}

/** Marks the cached run stopped, with nothing left to stop. */
function markStopped(cache: MutationCache, runId: string) {
  return updateRunDetail(cache, cache.keys.runs.detail(runId), (detail) => ({
    ...detail,
    status: "stopped",
    details: { ...detail.details, actions: { ...detail.details.actions, stop: false } },
  }));
}

/**
 * Stops an epic or request run (`POST /api/ui/runs/{id}/stop`). The run reads as stopped
 * before the server answers; a failure puts it back with the server's message.
 */
export function useRunStop(runId: string) {
  return useApiMutation<MutationResult, void>({
    mutationKey: ["run-stop", runId],
    mutationFn: (_variables, { organizationId }) =>
      api.post(runPath(runId, "stop"), mutationResultSchema, { organizationId }),
    optimistic: (_variables, cache) => markStopped(cache, runId),
    invalidate: (keys) => [keys.runs.all, keys.inbox.all],
    success: "Run stopped",
  });
}
