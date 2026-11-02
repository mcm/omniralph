/**
 * The task verifier of a story run: once an attempt's session reports the story
 * complete and its checks pass, a query run of the story playbook's verifier
 * (`verifierTaskId`, `builtin:verify-task` by default) checks the attempt's commit
 * against the story's acceptance criteria before the story counts as done. It is
 * invoked as the PR description is (`RunInvoker { kind: "ralph-run" }`, the
 * `run-result` sink hands its output back), and its outcome is applied by
 * `applyJobOutcomes` under the run's row lock, which finds it through the story's
 * `last_job_id`. Each check is kept in the story's `verifications`.
 */
import {
  setJobRalphStory,
  updateStory,
  type Job,
  type RalphStory,
  type RalphTaskVerification,
} from "@omniralph/db";
import { storyIssueBody } from "@omniralph/ralph";
import {
  excerpt,
  MAX_VERIFIED_CRITERIA,
  RALPH_VERIFY_TASK_JOB_TYPE,
  RalphStoryPayload,
  RalphVerifyTaskPayload,
  type RalphStoryResult,
  type RalphTaskVerdict,
} from "@omniralph/shared";
import { organizationPlaybooks } from "@/lib/playbooks";
import { ralphJobPayload, taskVerdictOf, verifierTaskFor, verifyTaskJobInput } from "./coding";
import { conversationFor } from "./conversation";
import { runDedupeKey } from "./dedupe";
import { laneAgentId, storyLane } from "./lanes";
import { postActivity } from "./notify";
import type { OutcomeContext } from "./outcome";

/** Longest acceptance criterion passed to the verifier. */
const MAX_CRITERION_LENGTH = 4000;
/** Longest story description passed to the verifier (the payload's limit). */
const MAX_DESCRIPTION_LENGTH = 200_000;

/** The verification `story` waits on: its running one whose job is the story's last job. */
export function runningVerification(
  story: Pick<RalphStory, "lastJobId" | "verifications">,
): RalphTaskVerification | null {
  const last = story.verifications.at(-1);
  return last?.status === "running" && last.jobId === story.lastJobId ? last : null;
}

/** What starting a task verifier did. */
export type VerifierStart =
  | { started: true }
  /** No verifier runs: the story is done as the session reported, `problem` saying why (null: it has none to run). */
  | { started: false; problem: string | null };

/**
 * The story's description and acceptance criteria as the tracker has them now (the story
 * job's payload when the tracker can't be read).
 */
async function storyCriteria(
  ctx: OutcomeContext,
  story: RalphStory,
  payload: RalphStoryPayload,
): Promise<{ description: string; acceptanceCriteria: string[] }> {
  const text = await ctx.tracker
    .getIssue(story.trackerIssueId)
    .then((issue) => issue.description)
    .catch((error: unknown) => {
      console.warn(`${story.identifier}: could not read its acceptance criteria`, error);
      return payload.story.description;
    });
  const body = storyIssueBody(text);
  return {
    description: body.description.slice(0, MAX_DESCRIPTION_LENGTH),
    acceptanceCriteria: body.acceptanceCriteria
      .map((criterion) => criterion.trim().slice(0, MAX_CRITERION_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_VERIFIED_CRITERIA),
  };
}

/**
 * Starts the task verifier of a story attempt its session reported complete (`job`,
 * with `result`): a `ralph.verify-task` query run of the story playbook's verifier on
 * the story's lane agent, in a checkout of the attempt's commit. The story stays
 * `running` with the verifier as its last job, and what completing it applies (the
 * session's summary and follow-ups) waits in its new `verifications` entry. No verifier
 * runs when the job's playbook has none (it isn't a story playbook), or when it can't be
 * started (`problem` says why: the story is done without it).
 */
export async function startTaskVerifier(
  ctx: OutcomeContext,
  story: RalphStory,
  job: Job,
  result: RalphStoryResult,
): Promise<VerifierStart> {
  const { run } = ctx;
  const playbooks = organizationPlaybooks(ctx.db, run.organizationId);
  const taskId = await verifierTaskFor(job, playbooks);
  if (!taskId) return { started: false, problem: null };
  const parsed = RalphStoryPayload.safeParse(ralphJobPayload(job));
  if (!parsed.success) {
    return { started: false, problem: "its attempt has no story to check against" };
  }
  const attempt = parsed.data;
  const commitSha = result.commitSha ?? result.hiddenRef?.sha ?? null;
  const criteria = await storyCriteria(ctx, story, attempt);
  const parsedPayload = RalphVerifyTaskPayload.safeParse({
    runId: run.id,
    repositoryId: attempt.repositoryId,
    repository: attempt.repository,
    branch: attempt.branch,
    baseBranch: attempt.baseBranch,
    settings: attempt.settings,
    storyId: story.id,
    attempt: story.attempts + 1,
    epic: {
      identifier: attempt.epic.identifier,
      title: attempt.epic.title,
      prd: attempt.epic.prd,
    },
    story: {
      identifier: attempt.story.identifier,
      title: attempt.story.title,
      ...criteria,
    },
    commitSha,
    qualityGates: attempt.qualityGates,
  });
  if (!parsedPayload.success) {
    return { started: false, problem: "its attempt couldn't be described to the verifier" };
  }
  const payload = parsedPayload.data;
  const routing = await verifyTaskJobInput(taskId, payload, playbooks);
  if (typeof routing === "string") return { started: false, problem: routing };
  const lane = await storyLane(ctx.tx, run, story);
  const { job: verifier, created } = await ctx.dispatcher.createAndPublish({
    organizationId: run.organizationId,
    type: RALPH_VERIFY_TASK_JOB_TYPE,
    ...routing,
    repositoryId: attempt.repositoryId,
    ralphRunId: run.id,
    dedupeKey: runDedupeKey(run.id),
    targetAgentId: lane ? await laneAgentId(ctx.db, run, lane) : undefined,
  });
  if (!created) return { started: false, problem: "another of the run's jobs is still active" };
  await setJobRalphStory(ctx.tx, verifier.id, story.id);

  const now = (ctx.now ?? new Date()).toISOString();
  const verifications: RalphTaskVerification[] = [
    // A check the run moved on from (a stop, a restart) never reports back.
    ...story.verifications.map((v) =>
      v.status === "running"
        ? {
            ...v,
            status: "failed" as const,
            error: "The run moved on before the verifier finished.",
            finishedAt: now,
            pending: undefined,
          }
        : v,
    ),
    {
      jobId: verifier.id,
      storyJobId: job.id,
      attempt: payload.attempt,
      status: "running",
      commitSha,
      criteria: [],
      summary: null,
      error: null,
      startedAt: now,
      finishedAt: null,
      pending: {
        summary: result.summary,
        followUps: result.followUps,
        wroteProgress: result.progress !== undefined,
      },
    },
  ];
  await updateStory(ctx.tx, story.id, { lastJobId: verifier.id, verifications });
  const count = criteria.acceptanceCriteria.length;
  await postActivity(conversationFor(run, ctx), {
    type: "thought",
    body:
      `🔎 **${story.identifier}** passed its checks${commitSha ? ` in \`${commitSha.slice(0, 10)}\`` : ""}. ` +
      (count > 0
        ? `Checking it against its ${count === 1 ? "acceptance criterion" : `${count} acceptance criteria`} before it counts as done.`
        : "It lists no acceptance criteria, so I'm checking it against its description before it counts as done."),
  });
  return { started: true };
}

/** A finished verification, with what the story run does with it. */
export type VerificationOutcome =
  /** Every criterion holds: the story is done. */
  | { kind: "accepted"; verification: RalphTaskVerification }
  /** A criterion was sent back: the attempt failed, with `feedback` for the next one. */
  | { kind: "rejected"; verification: RalphTaskVerification; feedback: string }
  /** The verifier couldn't check: the story is done as the session reported. */
  | { kind: "failed"; verification: RalphTaskVerification };

/** Why a verifier job that didn't complete couldn't check. */
function verifierFailure(job: Job | null): string {
  if (!job) return "the verifier's job is gone";
  if (job.error) return job.error;
  switch (job.status) {
    case "canceled":
      return "the verifier was canceled";
    case "expired":
      return "no agent picked up the verifier in time";
    case "skipped":
      return "the verifier was skipped";
    default:
      return "the verifier failed without an error message";
  }
}

/** The outcome of a finished verifier job, before it's stored. */
export function verificationOutcome(
  verification: RalphTaskVerification,
  job: Job | null,
  now: Date,
): VerificationOutcome {
  const finished = { ...verification, finishedAt: now.toISOString(), pending: undefined };
  const verdict =
    job?.status === "completed"
      ? taskVerdictOf(job)
      : { kind: "failed" as const, error: verifierFailure(job) };
  if (verdict.kind === "failed") {
    return {
      kind: "failed",
      verification: { ...finished, status: "failed", error: verdict.error },
    };
  }
  const { criteria, summary } = verdict.verdict;
  if (criteria.length === 0) {
    return {
      kind: "failed",
      verification: {
        ...finished,
        status: "failed",
        summary: summary || null,
        error: "the verifier returned no verdicts",
      },
    };
  }
  const checked = { ...finished, criteria, summary: summary || null };
  if (criteria.every((c) => c.accepted)) {
    return { kind: "accepted", verification: { ...checked, status: "accepted" } };
  }
  return {
    kind: "rejected",
    verification: { ...checked, status: "rejected" },
    feedback: rejectionFeedback(verification.commitSha, verdict.verdict),
  };
}

/** The next attempt's feedback after the verifier sent criteria back: each with its reason. */
export function rejectionFeedback(commitSha: string | null, verdict: RalphTaskVerdict): string {
  const rejected = verdict.criteria.filter((c) => !c.accepted);
  const accepted = verdict.criteria.length - rejected.length;
  return [
    `An independent verifier checked the previous attempt${commitSha ? ` (\`${commitSha.slice(0, 10)}\`, already on the branch)` : ""} against the story's acceptance criteria and sent ${rejected.length === 1 ? "this criterion" : "these criteria"} back:`,
    "",
    ...rejected.map((c) => `- ${c.criterion}\n  Why: ${c.reason || "no reason given"}`),
    "",
    ...(verdict.summary ? [`Its summary: ${excerpt(verdict.summary, 3000)}`, ""] : []),
    accepted > 0
      ? `Fix what it sent back; the ${accepted === 1 ? "criterion" : `${accepted} criteria`} it accepted already hold.`
      : "Fix what it sent back.",
  ].join("\n");
}
