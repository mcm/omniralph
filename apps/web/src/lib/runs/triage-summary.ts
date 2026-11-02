import "server-only";
/**
 * A triage run's summary (`GET /api/ui/runs/{id}/triage`): where it left the work item, from
 * its last result (`triage_runs.last_result`), and the issue as it read before triage, from
 * its first job's input (the trigger context `enqueueTriage` stores).
 */
import {
  getTriageRunDetail,
  type Database,
  type RunIndexEntry,
  type TriageRunWithJobs,
} from "@omniralph/db";
import { TriageRunResult } from "@omniralph/shared";
import { z } from "zod";
import type { RunTriageSummary, TriageSummaryOutcome } from "@/lib/api/runs";
import type { Role } from "@/lib/auth/roles";
import { canAnswerTriageQuestions } from "./actions";

/** The issue a triage job read, in its payload's trigger context. */
const JobIssue = z.object({
  trigger: z.object({
    context: z.object({ issue: z.object({ title: z.string(), description: z.string() }) }),
  }),
});

/**
 * The run's outcome: its status while it isn't finished, else whether its last result left
 * open questions (Needs refining) or none (Ready to start). A completed run without a valid
 * result is shown failed: it changed nothing.
 */
function outcomeOf(
  status: TriageRunWithJobs["run"]["status"],
  result: TriageRunResult | null,
): TriageSummaryOutcome {
  switch (status) {
    case "queued":
    case "running":
      return "triaging";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "completed":
      if (!result?.outcome) return "failed";
      return result.outcome.openQuestions.length > 0 ? "needs_answers" : "ready";
  }
}

/**
 * The summary of a triage run's detail (the run with its jobs, newest first), for a user with
 * `role` in its organization.
 */
export function triageSummary({ run, jobs }: TriageRunWithJobs, role: Role): RunTriageSummary {
  const parsed = TriageRunResult.safeParse(run.lastResult);
  const result = parsed.success ? parsed.data : null;
  const first = jobs.at(-1);
  const input = first ? JobIssue.safeParse(first.payload) : null;
  const outcome = outcomeOf(run.status, result);
  return {
    outcome,
    summary: result?.summary || null,
    error: result?.error ?? null,
    change: result?.outcome?.outcome ?? null,
    size: result?.outcome?.size ?? null,
    storyCount: result?.outcome?.stories.length ?? 0,
    openQuestions: result?.outcome?.openQuestions ?? [],
    answerQuestions: canAnswerTriageQuestions(outcome, role),
    originalIssue: input?.success ? input.data.trigger.context.issue : null,
  };
}

/**
 * A triage run's summary for a user with `role` in its organization; null when the run isn't a
 * triage run (or is gone).
 */
export async function loadRunTriageSummary(
  db: Database,
  run: RunIndexEntry,
  role: Role,
): Promise<RunTriageSummary | null> {
  if (run.kind !== "triage") return null;
  const detail = await getTriageRunDetail(db, run.organizationId, run.id);
  return detail && triageSummary(detail, role);
}
