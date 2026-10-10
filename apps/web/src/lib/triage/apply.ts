/**
 * Applies a finished `triage.run` job to Linear (agents hold no Linear token):
 * the issue's title and description become the PRD (with its open questions
 * at the end), a new epic gets its story sub-issues, and the issue moves to
 * Todo when nothing is left to answer or Backlog otherwise. The outcome is
 * reported in the run's Linear agent session.
 *
 * Nothing in Linear changes for a result that isn't valid, or when the issue
 * or one of its sub-issues went in progress or done while triage ran.
 */
import {
  failCompletedJob,
  finishTriageRunJob,
  getTriageRun,
  setTriageRunStatus,
  skipJob,
  startTriageRunJob,
  ACTIVE_TRIAGE_RUN_STATUSES,
  type Database,
  type Job,
  type TriageRun,
} from "@omniralph/db";
import {
  renderOpenQuestions,
  validateTriageOutput,
  type MaterializationPlan,
  type TriageAgentOutput,
} from "@omniralph/ralph";
import { TriageRunPayload, TriageRunResult } from "@omniralph/shared";
import { getLinearGateway } from "@/lib/linear/client";
import type { IssueSummary, LinearGateway } from "@/lib/linear/gateway";
import { createPlannedSubIssues, runManualLabels } from "@/lib/ralph/epic-loader";
import { errorMessage, postActivity, quietly } from "@/lib/ralph/notify";
import { lockedIssues, lockedMessage } from "./start";

export interface TriageApplyDeps {
  db: Database;
  linear: LinearGateway;
}

/** What applying a triage job did. */
export type ApplyTriageOutcome =
  /** Not this run's current job, or its outcome was applied already. */
  | { status: "ignored" }
  /** The result was an error or didn't validate: nothing changed in Linear. */
  | { status: "invalid"; problem: string }
  /** The issue or one of its sub-issues is in progress or done: nothing changed. */
  | { status: "in_progress"; issues: string[] }
  /** A Linear read or write failed part way. */
  | { status: "failed"; error: string }
  | { status: "applied"; created: IssueSummary[]; stateType: "unstarted" | "backlog" };

const EPIC_SIZES = new Set(["L", "XL"]);
/** Title of the validation story `buildTriagePrompt` asks for (the last story). */
const VALIDATION_TITLE = /^validate\b/i;

const STATE_NAMES = { unstarted: "Todo", backlog: "Backlog" } as const;

/** The run a triage job belongs to, when the job is still its current one. */
async function currentRun(db: Database, job: Job): Promise<TriageRun | null> {
  const payload = TriageRunPayload.safeParse(job.payload);
  if (!payload.success) return null;
  const run = await getTriageRun(db, payload.data.triageRunId);
  return run && run.currentJobId === job.id ? run : null;
}

/**
 * The job's result as a validated triage, or the problem with it (the
 * session's own error, a malformed result, or one `validateTriageOutput`
 * rejects).
 */
export function readTriageResult(
  result: unknown,
): { triage: TriageAgentOutput; result: TriageRunResult } | { problem: string } {
  const parsed = TriageRunResult.safeParse(result);
  if (!parsed.success) return { problem: "the triage job returned a malformed result" };
  const { outcome, error, summary } = parsed.data;
  if (error !== null || !outcome) return { problem: error ?? "the triage returned no outcome" };
  const validated = validateTriageOutput({ ...outcome, summary });
  if ("problem" in validated) return { problem: validated.problem };
  return { triage: validated.result, result: parsed.data };
}

/** The issue's new description: the PRD, with its open questions at the end. */
export function triagedDescription(
  triage: Pick<TriageAgentOutput, "description" | "openQuestions">,
): string {
  const questions = renderOpenQuestions(triage.openQuestions);
  return questions ? `${triage.description.trim()}\n\n${questions}` : triage.description.trim();
}

/**
 * The sub-issues of a new epic, in story order: each story's priority and
 * manual flag, "blocks" relations from its dependency indexes, and the
 * validation story (the last one) blocked by every other story.
 */
export function storyPlan(stories: TriageAgentOutput["stories"]): MaterializationPlan {
  const id = (i: number) => `story-${i}`;
  const last = stories.length - 1;
  const validation = last > 0 && VALIDATION_TITLE.test(stories[last]!.title) ? last : -1;
  return {
    issues: stories.map((s, i) => ({
      storyId: id(i),
      title: s.title,
      description: s.body,
      priority: s.priority,
      subIssueSortOrder: i,
      completed: false,
      manual: s.manual,
    })),
    relations: stories.flatMap((s, i) => {
      const deps = i === validation ? stories.map((_, j) => j).filter((j) => j !== i) : s.dependsOn;
      return [...new Set(deps)]
        .filter((d) => d !== i && d >= 0 && d < stories.length)
        .map((d) => ({ blocker: id(d), blocked: id(i) }));
    }),
  };
}

/** The final response in the session: what triage decided and what it changed. */
export function appliedMessage(
  issue: Pick<IssueSummary, "identifier">,
  triage: TriageAgentOutput,
  created: readonly IssueSummary[],
  stateType: "unstarted" | "backlog",
  notes: readonly string[] = [],
): string {
  const structure =
    created.length > 0
      ? `epic with ${created.length} new sub-issue${created.length === 1 ? "" : "s"}: ${created.map((c) => c.identifier).join(", ")}`
      : EPIC_SIZES.has(triage.size)
        ? "epic (its existing sub-issues kept)"
        : "single issue";
  const lines = [
    `Triaged **${issue.identifier}** (${triage.outcome === "prd" ? "rewritten as a PRD" : triage.outcome === "reformat" ? "reformatted" : "already in the PRD format"}).`,
    "",
    triage.summary,
    "",
    `- **Size:** ${triage.size}`,
    `- **Structure:** ${structure}`,
    `- **Status:** ${STATE_NAMES[stateType]}`,
    ...notes.map((n) => `- ${n}`),
  ];
  if (triage.openQuestions.length > 0) {
    lines.push(
      "",
      `**Open questions** (it stays in Backlog until they are answered; reply here to answer them):`,
      "",
      ...triage.openQuestions.map((q, i) => `${i + 1}. ${q}`),
    );
  } else {
    lines.push("", "No open questions: it's ready to delegate to ralph.");
  }
  return lines.join("\n");
}

/** The comment asking the issue's creator to answer its open questions. */
export function openQuestionsComment(
  issue: Pick<IssueSummary, "creator">,
  questions: readonly string[],
): string {
  const who = issue.creator?.url ?? (issue.creator ? `@${issue.creator.name}` : null);
  const intro = `${who ? `${who} ` : ""}triage left ${questions.length === 1 ? "an open question" : `${questions.length} open questions`} on this issue. It stays in Backlog until ${questions.length === 1 ? "it is" : "they are"} answered (reply in the triage session, or edit the description and triage again):`;
  return [intro, "", ...questions.map((q, i) => `${i + 1}. ${q}`)].join("\n");
}

/**
 * Applies a completed triage job's result to Linear. Idempotent: the run is
 * claimed (finished) before any Linear write, so a replayed result is ignored.
 */
export async function applyTriageJob(deps: TriageApplyDeps, job: Job): Promise<ApplyTriageOutcome> {
  const { db, linear } = deps;
  const run = await currentRun(db, job);
  if (!run) return { status: "ignored" };
  const sessionId = run.linearAgentSessionId;

  const read = readTriageResult(job.result);
  if ("problem" in read) {
    const claimed = await finishTriageRunJob(db, run.id, job.id, "failed", job.result ?? null);
    if (!claimed) return { status: "ignored" };
    await failCompletedJob(db, job.id, read.problem);
    await postActivity(linear, sessionId, {
      type: "error",
      body: `Triage didn't produce a usable PRD, so I changed nothing in Linear: ${read.problem}. Mention me with \`/triage\` to try again.`,
    });
    return { status: "invalid", problem: read.problem };
  }
  const { triage, result } = read;

  const claimed = await finishTriageRunJob(db, run.id, job.id, "completed", result);
  if (!claimed) return { status: "ignored" };

  const fail = async (error: unknown): Promise<ApplyTriageOutcome> => {
    await setTriageRunStatus(db, run.id, "failed");
    await postActivity(linear, sessionId, {
      type: "error",
      body: `I couldn't apply the triage to Linear: ${errorMessage(error)}`,
    });
    return { status: "failed", error: errorMessage(error) };
  };

  let issue: IssueSummary;
  let children: IssueSummary[];
  try {
    issue = await linear.getIssue(run.linearIssueId);
    children = await linear.getChildren(issue.id);
  } catch (error) {
    return fail(error);
  }

  // Work may have started while triage ran: then nothing changes.
  const locked = lockedIssues(issue, children);
  if (locked.length > 0) {
    await setTriageRunStatus(db, run.id, "stopped");
    await postActivity(linear, sessionId, { type: "response", body: lockedMessage(issue, locked) });
    return { status: "in_progress", issues: locked };
  }

  const stateType = triage.openQuestions.length > 0 ? "backlog" : "unstarted";
  const notes: string[] = [];
  let created: IssueSummary[] = [];
  try {
    const description = triagedDescription(triage);
    await linear.updateIssue(issue.id, {
      ...(triage.title !== issue.title && { title: triage.title }),
      ...(description !== issue.description.trim() && { description }),
    });

    if (triage.outcome === "prd" && EPIC_SIZES.has(triage.size) && triage.stories.length > 0) {
      if (children.length === 0) {
        const payload = TriageRunPayload.parse(job.payload);
        const [manualLabel] = await runManualLabels(db, {
          repositoryId: payload.repository?.repositoryId ?? null,
        });
        created = await createPlannedSubIssues(
          linear,
          issue,
          storyPlan(triage.stories),
          manualLabel ?? "manual",
        );
      } else {
        notes.push(
          `Sub-issues: none created, the issue already has ${children.length}; triage again to reformat them.`,
        );
      }
    }

    if (issue.stateType !== stateType) await linear.setIssueState(issue.id, { type: stateType });
  } catch (error) {
    return fail(error);
  }

  if (triage.openQuestions.length > 0) {
    await quietly(`Commenting the open questions on ${issue.identifier}`, () =>
      linear.addComment(issue.id, openQuestionsComment(issue, triage.openQuestions)),
    );
  }
  await postActivity(linear, sessionId, {
    type: "response",
    body: appliedMessage(issue, triage, created, stateType, notes),
  });
  return { status: "applied", created, stateType };
}

/**
 * A triage job started: its run is running (with the job as its current one,
 * when it started before `startTriage` recorded it). A job that is no longer
 * its run's current one, or whose run is over, is skipped.
 */
export async function onTriageJobStarted(
  db: Database,
  job: Job,
): Promise<{ skip: false } | { skip: true; reason: "skipped" }> {
  const payload = TriageRunPayload.safeParse(job.payload);
  const run = payload.success ? await getTriageRun(db, payload.data.triageRunId) : null;
  if (run && (await startTriageRunJob(db, run.id, job.id))) return { skip: false };
  await skipJob(db, job.id, { reason: "The triage run is over" });
  return { skip: true, reason: "skipped" };
}

/** A triage job completed: its result is applied. Errors are logged, not thrown. */
export async function onTriageJobCompleted(
  db: Database,
  job: Job,
  deps?: TriageApplyDeps,
): Promise<void> {
  try {
    const run = await currentRun(db, job);
    if (!run || !isActive(run)) return;
    await applyTriageJob(deps ?? (await defaultDeps(db, run)), job);
  } catch (error) {
    console.error(`Applying triage job ${job.id} failed`, error);
  }
}

/**
 * A triage job failed for good or was canceled: its run ends `failed` (or
 * `stopped`) and the session says so. Errors are logged, not thrown.
 */
export async function onTriageJobFinishedWithoutResult(
  db: Database,
  job: Job,
  status: "failed" | "stopped",
  error: string | null,
  deps?: TriageApplyDeps,
): Promise<void> {
  try {
    const run = await currentRun(db, job);
    if (!run) return;
    const claimed = await finishTriageRunJob(db, run.id, job.id, status);
    if (!claimed) return;
    const { linear } = deps ?? (await defaultDeps(db, run));
    await postActivity(
      linear,
      run.linearAgentSessionId,
      status === "failed"
        ? {
            type: "error",
            body: `Triage failed${error ? `: ${error}` : ""}. Nothing changed in Linear; mention me with \`/triage\` to try again.`,
          }
        : { type: "response", body: "Triage was canceled. Nothing changed in Linear." },
    );
  } catch (err) {
    console.error(`Recording the end of triage job ${job.id} failed`, err);
  }
}

const isActive = (run: TriageRun) =>
  (ACTIVE_TRIAGE_RUN_STATUSES as readonly string[]).includes(run.status);

async function defaultDeps(db: Database, run: TriageRun): Promise<TriageApplyDeps> {
  return { db, linear: await getLinearGateway({ db, organizationId: run.organizationId }) };
}
