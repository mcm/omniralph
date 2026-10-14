/**
 * Triage runs as the Triage pages show them: the run, the issue and repository
 * its latest `triage.run` job read (the run keeps only Linear's issue ID), and
 * the result it kept (`TriageRunResult`).
 */
import type { RunActivity, TriageRunJob, TriageRunWithJobs } from "@omniralph/db";
import { RunSpecJobPayload, TRIAGE_RUN_JOB_TYPE, TriageRunResult } from "@omniralph/shared";
import { z } from "zod";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import type {
  TriageActivityRow,
  TriageIssueRef,
  TriageJobRow,
  TriageResultView,
  TriageRunDetailView,
  TriageRunRow,
} from "./display";

/** What the pages read from a job's trigger context (`enqueueTriage`). */
const TriageJobContext = z.object({
  triageRunId: z.uuid().optional(),
  issue: z
    .object({
      identifier: z.string().min(1),
      title: z.string().nullish(),
      url: z.string().nullish(),
    })
    .nullish(),
  branch: z.string().nullish(),
  reply: z.string().nullish(),
});
type TriageJobContext = z.infer<typeof TriageJobContext>;

function jobContext(job: Pick<TriageRunJob, "payload">): TriageJobContext | null {
  const payload = RunSpecJobPayload.safeParse(job.payload);
  if (!payload.success) return null;
  const context = TriageJobContext.safeParse(payload.data.trigger.context);
  return context.success ? context.data : null;
}

/** Only web links are linked to. */
function webUrl(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function issueRef(context: TriageJobContext | null): TriageIssueRef | null {
  const issue = context?.issue;
  if (!issue) return null;
  return { identifier: issue.identifier, title: issue.title || null, url: webUrl(issue.url) };
}

/**
 * The triage run a `triage.run` job belongs to, named by the issue it read (or "Triage"),
 * for links from the Jobs page; null for other jobs.
 */
export function triageJobRun(job: {
  type: string;
  payload: Record<string, unknown>;
}): { id: string; label: string } | null {
  if (job.type !== TRIAGE_RUN_JOB_TYPE) return null;
  const context = jobContext(job);
  if (!context?.triageRunId) return null;
  return { id: context.triageRunId, label: context.issue?.identifier ?? "Triage" };
}

/** The run's last result, null without one (or one that doesn't parse). */
function resultView(lastResult: unknown): TriageResultView | null {
  const parsed = TriageRunResult.safeParse(lastResult);
  return parsed.success ? parsed.data : null;
}

/** Why a failed run failed: its last result's error, else its latest job's. */
function runError(entry: TriageRunWithJobs, result: TriageResultView | null): string | null {
  if (entry.run.status !== "failed") return null;
  return result?.error ?? entry.jobs.find((j) => j.error)?.error ?? null;
}

export function triageRunRow(entry: TriageRunWithJobs): TriageRunRow {
  const { run, jobs } = entry;
  // Jobs are newest first; an older job read the issue too when the latest one didn't.
  const latest = jobs[0] ?? null;
  const issue = jobs.map((job) => issueRef(jobContext(job))).find(Boolean) ?? null;
  const result = resultView(run.lastResult);
  const repo = latest?.repository ?? null;
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    issue,
    repository: repo && {
      provider: repo.provider,
      fullPath: repo.fullPath,
      url: repositoryWebUrl(repo.provider, repo.baseUrl, repo.fullPath),
    },
    outcome: result?.outcome?.outcome ?? null,
    size: result?.outcome?.size ?? null,
    openQuestions: result?.outcome ? result.outcome.openQuestions.length : null,
    error: runError(entry, result),
    agent: latest?.agent ?? null,
    jobCount: jobs.length,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

function triageJobRow(job: TriageRunJob): TriageJobRow {
  return {
    id: job.id,
    status: job.status,
    cancelRequested: job.cancelRequested,
    deliveryCount: job.deliveryCount,
    error: job.error,
    agent: job.agent,
    reply: jobContext(job)?.reply || null,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

function activityRow(activity: RunActivity): TriageActivityRow {
  return {
    id: activity.id,
    jobId: activity.jobId,
    type: activity.type,
    body: activity.body,
    parameter: activity.parameter,
    createdAt: activity.createdAt.toISOString(),
  };
}

export function triageRunDetailView(
  entry: TriageRunWithJobs,
  activities: readonly RunActivity[],
): TriageRunDetailView {
  const latest = entry.jobs[0];
  return {
    ...triageRunRow(entry),
    linearAgentSessionId: entry.run.linearAgentSessionId,
    branch: (latest && latest.repository && jobContext(latest)?.branch) || null,
    pendingReply: entry.run.pendingReply,
    result: resultView(entry.run.lastResult),
    jobs: entry.jobs.map(triageJobRow),
    activities: activities.map(activityRow),
  };
}
