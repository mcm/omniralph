/**
 * Applies a finished `triage.run` job to Linear (agents hold no Linear token):
 * the issue's title and description become the PRD (with its open questions
 * at the end), a new epic gets its story sub-issues, a reformatted epic's
 * Backlog/Todo sub-issues are rewritten (with their missing relations and a
 * validation sub-issue), and the issue moves through the tracker's readiness state
 * mapping: to its first Ready-to-start state when nothing is left to answer, else to its
 * first Needs-refining state. Triage never starts the epic itself. The outcome is
 * reported in the run's Linear agent session.
 *
 * Nothing in Linear changes for a result that isn't valid, or when the issue
 * or one of its sub-issues went in progress or done while triage ran, except
 * that the triage label is removed whenever a triage job ends, so
 * adding it again triages again.
 */
import {
  failCompletedJob,
  finishTriageRunJob,
  getTriageRun,
  setTriageRunStatus,
  startTriageRunJob,
  ACTIVE_TRIAGE_RUN_STATUSES,
  type Database,
  type Job,
  type TriageRun,
} from "@omniralph/db";
import { skipJobAndClearDue } from "@/lib/dispatch/due";
import {
  renderOpenQuestions,
  validateTriageOutput,
  withoutOpenQuestions,
  type MaterializationPlan,
  type TriageAgentOutput,
} from "@omniralph/ralph";
import { QueryRunResult, RunSpecJobPayload, TriageRunResult } from "@omniralph/shared";
import { z } from "zod";
import { getLinearGateway } from "@/lib/tracker/linear/client";
import { toIssuePriority, type IssueSummary } from "@omniralph/tracker";
import type { LinearGateway } from "@omniralph/tracker/linear";
import { createPlannedSubIssues, runManualLabels } from "@/lib/ralph/epic-loader";
import { errorMessage, postActivity, quietly } from "@/lib/ralph/notify";
import { trackerConversation } from "@/lib/ralph/conversation";
import { getDispatcher } from "@/lib/dispatch";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { workItemTrackerFor } from "@/lib/work-items/get-tracker";
import type { WorkItemTracker } from "@/lib/work-items/tracker";
import { releaseTriageDelegation, removeTriageLabelQuietly } from "./label";
import { continueTriageAfterJob } from "./reply";
import { lockedIssues, lockedMessage, type TriageDeps } from "./start";

export interface TriageApplyDeps {
  db: Database;
  linear: LinearGateway;
  /** The work item tracker the issue's state changes go through (default: over `linear`). */
  tracker?: WorkItemTracker;
}

/** What the job handlers use: also what starts the job a pending reply asks for. */
export type TriageJobDeps = TriageApplyDeps &
  Partial<Pick<TriageDeps, "dispatcher" | "adapterFor">>;

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
  | {
      status: "applied";
      /** New sub-issues: a new epic's stories, or a reformatted epic's validation sub-issue. */
      created: IssueSummary[];
      /** Identifiers of the sub-issues a reformat rewrote. */
      reformatted: string[];
      /** Sub-issue updates (or their blockers) that were ignored, and why. */
      ignored: string[];
      /** Where the state mapping moved the issue. */
      readiness: TriageReadiness;
    };

/** Ready to start (no open questions left) or Needs refining. */
export type TriageReadiness = "ready" | "needs_refining";

const EPIC_SIZES = new Set(["L", "XL"]);
/** Title of the validation story `buildTriagePrompt` asks for (the last story). */
const VALIDATION_TITLE = /^validate\b/i;

const READINESS_NAMES = { ready: "Ready to start", needs_refining: "Needs refining" } as const;

/** The last line of the final response when triage leaves the issue Ready to start. */
export function readyToStartMessage(issue: Pick<IssueSummary, "identifier">): string {
  return `${issue.identifier} is ready to start. Start it from the Backlog, or delegate it to Om again.`;
}

/** Sub-issue state types a reformat may rewrite. */
const REFORMATTABLE = new Set(["backlog", "unstarted"]);

/** The validation sub-issue a reformatted epic gets when it has none. */
export const VALIDATION_STORY_TITLE = "Validate functional requirements";
export const VALIDATION_STORY_BODY = [
  "Verify that the finished epic meets every functional requirement of the parent issue's PRD and every other sub-issue's acceptance criteria. For each item, confirm it in the code or with a test; add missing tests and fix any gap you find.",
  "",
  "## Acceptance Criteria",
  "",
  "- [ ] Every functional requirement of the parent issue's PRD is met",
  "- [ ] All acceptance criteria of the other stories of this epic are met",
  "- [ ] All quality gates pass",
].join("\n");

/** What the sink needs from the trigger context `enqueueTriage` stores. */
export const TriageRunContext = z.object({
  /** The `triage_runs` row. */
  triageRunId: z.uuid(),
});
export type TriageRunContext = z.infer<typeof TriageRunContext>;

/** The triage run (`triage_runs.id`) a `builtin:triage` job belongs to; null for another job. */
export function triageRunIdOf(job: Pick<Job, "payload">): string | null {
  const payload = RunSpecJobPayload.safeParse(job.payload);
  if (!payload.success) return null;
  const context = TriageRunContext.safeParse(payload.data.trigger.context);
  return context.success ? context.data.triageRunId : null;
}

/** The run a triage job belongs to, when the job is still its current one. */
async function currentRun(db: Database, job: Job): Promise<TriageRun | null> {
  const runId = triageRunIdOf(job);
  const run = runId ? await getTriageRun(db, runId) : null;
  return run && run.currentJobId === job.id ? run : null;
}

/** Longest summary or error a triage run keeps (`TriageRunResult`). */
const MAX_TEXT = 20_000;

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT - 1)}…` : trimmed;
}

/**
 * The job's result (a `QueryRunResult` whose structured output is the
 * triage) as a validated triage and the `TriageRunResult` its run keeps, or
 * the problem with it (a malformed result, a run that ended without one, a
 * triage `validateTriageOutput` rejects or one too large to keep) and, when
 * the run reported its usage, the failed `TriageRunResult` to keep.
 */
export function readTriageResult(
  result: unknown,
):
  | { triage: TriageAgentOutput; result: TriageRunResult }
  | { problem: string; result: TriageRunResult | null } {
  const parsed = QueryRunResult.safeParse(result);
  if (!parsed.success) {
    return { problem: "the triage job returned a malformed result", result: null };
  }
  const run = parsed.data;
  const base = { usage: run.usage, durationMs: run.durationMs };
  const failed = (problem: string) => ({
    problem,
    result: TriageRunResult.parse({
      summary: clip(problem),
      error: clip(problem),
      outcome: null,
      ...base,
    }),
  });
  if (run.outcome !== "answered") {
    return failed(`the triage ended without a result (${run.outcome})`);
  }
  const validated = validateTriageOutput(run.structured ?? undefined);
  if ("problem" in validated) return failed(validated.problem);
  const { summary, ...outcome } = validated.result;
  const kept = TriageRunResult.safeParse({ summary: clip(summary), error: null, outcome, ...base });
  if (!kept.success) {
    // E.g. more stories than a triage run keeps.
    return failed(`the triage result is too large: ${z.prettifyError(kept.error)}`);
  }
  return { triage: validated.result, result: kept.data };
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
  readiness: TriageReadiness,
  notes: readonly string[] = [],
  subIssues = 0,
): string {
  const plural = (n: number) => (n === 1 ? "" : "s");
  const structure =
    subIssues > 0
      ? `epic with ${subIssues} existing sub-issue${plural(subIssues)}`
      : created.length > 0
        ? `epic with ${created.length} new sub-issue${plural(created.length)}: ${created.map((c) => c.identifier).join(", ")}`
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
    `- **Status:** ${READINESS_NAMES[readiness]}`,
    ...notes.map((n) => `- ${n}`),
  ];
  if (triage.openQuestions.length > 0) {
    lines.push(
      "",
      `**Open questions** (it needs refining until they are answered; reply here to answer them):`,
      "",
      ...triage.openQuestions.map((q, i) => `${i + 1}. ${q}`),
    );
  } else {
    lines.push("", readyToStartMessage(issue));
  }
  return lines.join("\n");
}

/** The comment asking the issue's creator to answer its open questions. */
export function openQuestionsComment(
  issue: Pick<IssueSummary, "creator">,
  questions: readonly string[],
): string {
  const who = issue.creator?.url ?? (issue.creator ? `@${issue.creator.name}` : null);
  const intro = `${who ? `${who} ` : ""}triage left ${questions.length === 1 ? "an open question" : `${questions.length} open questions`} on this issue. It needs refining until ${questions.length === 1 ? "it is" : "they are"} answered (reply in the triage session, or edit the description and triage again):`;
  return [intro, "", ...questions.map((q, i) => `${i + 1}. ${q}`)].join("\n");
}

/** What `reformatSubIssues` changed. */
interface SubIssueReformat {
  reformatted: IssueSummary[];
  relations: number;
  validation: IssueSummary | null;
  ignored: string[];
}

/**
 * Applies a reformat's `subIssueUpdates` to `issue`'s Backlog/Todo
 * sub-issues: title, body and priority, plus the "blocks" relations they
 * lack (existing ones are kept). Updates for an issue that isn't a sub-issue
 * of `issue`, or one in another state, are ignored and reported. An epic
 * without a validation sub-issue gets one, blocked by every other
 * non-canceled sub-issue. Nothing is ever canceled, deleted or reparented.
 */
export async function reformatSubIssues(
  linear: LinearGateway,
  issue: IssueSummary,
  children: readonly IssueSummary[],
  updates: TriageAgentOutput["subIssueUpdates"],
): Promise<SubIssueReformat> {
  const byRef = new Map<string, IssueSummary>();
  for (const child of children) {
    byRef.set(child.id, child);
    byRef.set(child.identifier, child);
  }
  const done: SubIssueReformat = { reformatted: [], relations: 0, validation: null, ignored: [] };

  for (const update of updates) {
    const child = byRef.get(update.id);
    if (!child) {
      done.ignored.push(`\`${update.id}\` isn't a sub-issue of ${issue.identifier}`);
      continue;
    }
    if (!REFORMATTABLE.has(child.stateType)) {
      done.ignored.push(`${child.identifier} is ${child.stateName || child.stateType}`);
      continue;
    }
    await linear.updateIssue(child.id, {
      ...(update.title !== child.title && { title: update.title }),
      ...(update.body.trim() !== child.description.trim() && { description: update.body.trim() }),
      ...(update.priority !== child.priority && { priority: update.priority }),
    });
    done.reformatted.push(child);

    const existing = new Set((await linear.getBlockers(child.id)).map((b) => b.id));
    for (const ref of update.blockedBy) {
      const blocker = byRef.get(ref);
      if (!blocker || blocker.id === child.id) {
        done.ignored.push(`blocker \`${ref}\` of ${child.identifier} isn't a sibling sub-issue`);
        continue;
      }
      if (existing.has(blocker.id) || blocker.stateType === "canceled") continue;
      await linear.createBlocksRelation(blocker.id, child.id);
      existing.add(blocker.id);
      done.relations += 1;
    }
  }

  const live = children.filter((c) => c.stateType !== "canceled");
  if (live.length > 0 && !live.some((c) => VALIDATION_TITLE.test(c.title.trim()))) {
    const priorities = live.map((c) => c.priority).filter((p) => p > 0);
    const orders = children.map((c) => c.subIssueSortOrder).filter((o) => o !== undefined);
    const validation = await linear.createIssue({
      teamId: issue.teamId,
      parentId: issue.id,
      title: VALIDATION_STORY_TITLE,
      description: VALIDATION_STORY_BODY,
      priority: toIssuePriority(priorities.length > 0 ? Math.max(...priorities) : 3),
      ...(orders.length > 0 && { subIssueSortOrder: Math.max(...orders) + 1 }),
      ...(issue.projectName && { projectName: issue.projectName }),
    });
    for (const child of live) {
      await linear.createBlocksRelation(child.id, validation.id);
      done.relations += 1;
    }
    done.validation = validation;
  }
  return done;
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
    const claimed = await finishTriageRunJob(db, run.id, job.id, "failed", read.result);
    if (!claimed) return { status: "ignored" };
    await failCompletedJob(db, job.id, read.problem);
    await postActivity(trackerConversation(linear, sessionId), {
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
    await postActivity(trackerConversation(linear, sessionId), {
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
    await postActivity(trackerConversation(linear, sessionId), {
      type: "response",
      body: lockedMessage(issue, locked),
    });
    return { status: "in_progress", issues: locked };
  }

  const readiness: TriageReadiness = triage.openQuestions.length > 0 ? "needs_refining" : "ready";
  const notes: string[] = [];
  let created: IssueSummary[] = [];
  let reformat: SubIssueReformat | null = null;
  try {
    if (triage.outcome === "unchanged") {
      // Already a PRD: only its open questions change.
      const description = triagedDescription({
        description: withoutOpenQuestions(issue.description),
        openQuestions: triage.openQuestions,
      });
      if (description !== issue.description.trim()) {
        await linear.updateIssue(issue.id, { description });
      }
    } else {
      const description = triagedDescription(triage);
      await linear.updateIssue(issue.id, {
        ...(triage.title !== issue.title && { title: triage.title }),
        ...(description !== issue.description.trim() && { description }),
      });
    }

    if (
      triage.outcome === "reformat" &&
      (children.length > 0 || triage.subIssueUpdates.length > 0)
    ) {
      reformat = await reformatSubIssues(linear, issue, children, triage.subIssueUpdates);
      if (reformat.validation) created = [reformat.validation];
      if (reformat.reformatted.length > 0) {
        notes.push(
          `**Sub-issues reformatted:** ${reformat.reformatted.map((c) => c.identifier).join(", ")}`,
        );
      }
      if (reformat.relations > 0) notes.push(`**Blocks relations added:** ${reformat.relations}`);
      if (reformat.validation) {
        notes.push(`**Validation sub-issue created:** ${reformat.validation.identifier}`);
      }
      if (reformat.ignored.length > 0) {
        notes.push(`**Ignored sub-issue updates:** ${reformat.ignored.join("; ")}`);
      }
    }

    if (triage.outcome === "prd" && EPIC_SIZES.has(triage.size) && triage.stories.length > 0) {
      if (children.length === 0) {
        const [manualLabel] = await runManualLabels(db, { organizationId: job.organizationId });
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

    const tracker =
      deps.tracker ??
      (await workItemTrackerFor({ db, organizationId: run.organizationId, gateway: linear }));
    await tracker.setState(issue.id, { readiness });
  } catch (error) {
    return fail(error);
  }

  if (triage.openQuestions.length > 0) {
    await quietly(`Commenting the open questions on ${issue.identifier}`, () =>
      linear.addComment(issue.id, openQuestionsComment(issue, triage.openQuestions)),
    );
  }
  // Before the final response: a later delegation to Om must be a change Linear acts on.
  await releaseTriageDelegation({ db, organizationId: run.organizationId, linear }, issue.id);
  await postActivity(trackerConversation(linear, sessionId), {
    type: "response",
    body: appliedMessage(issue, triage, created, readiness, notes, reformat ? children.length : 0),
  });
  return {
    status: "applied",
    created,
    reformatted: reformat?.reformatted.map((c) => c.identifier) ?? [],
    ignored: reformat?.ignored ?? [],
    readiness,
  };
}

/**
 * A triage job started: its run is running (with the job as its current one,
 * when it started before `startTriage` recorded it). A job that is no longer
 * its run's current one, or whose run is over, is skipped. Then, since work
 * may have started on the issue while the job was queued, the issue and its
 * sub-issues are read again: when one is in progress or done, the run stops
 * and the job is skipped without a session (a failed read lets it run:
 * `applyTriageJob` checks again before writing).
 */
export async function onTriageJobStarted(
  db: Database,
  job: Job,
  deps?: TriageApplyDeps,
): Promise<{ skip: false } | { skip: true; reason: "skipped" }> {
  const runId = triageRunIdOf(job);
  const run = runId ? await getTriageRun(db, runId) : null;
  if (!run || !(await startTriageRunJob(db, run.id, job.id))) {
    await skipJobAndClearDue(db, job, { reason: "The triage run is over" });
    return { skip: true, reason: "skipped" };
  }

  let linear: LinearGateway;
  let issue: IssueSummary;
  let locked: string[];
  try {
    linear = deps?.linear ?? (await defaultDeps(db, run)).linear;
    issue = await linear.getIssue(run.linearIssueId);
    locked = lockedIssues(issue, await linear.getChildren(issue.id));
  } catch (error) {
    console.warn(`Re-checking the issue of triage job ${job.id} failed`, error);
    return { skip: false };
  }
  if (locked.length === 0) return { skip: false };
  if (!(await finishTriageRunJob(db, run.id, job.id, "stopped"))) return { skip: false };
  await skipJobAndClearDue(db, job, { reason: "The issue is in progress or done" });
  await postActivity(trackerConversation(linear, run.linearAgentSessionId, run.linearIssueId), {
    type: "response",
    body: lockedMessage(issue, locked),
  });
  await removeTriageLabelQuietly(linear, run.linearIssueId);
  return { skip: true, reason: "skipped" };
}

/**
 * A triage job completed: its result is applied, then a reply that arrived
 * while it ran starts the next job. Errors are logged, not thrown.
 */
export async function onTriageJobCompleted(
  db: Database,
  job: Job,
  deps?: TriageJobDeps,
): Promise<void> {
  try {
    const run = await currentRun(db, job);
    if (!run || !isActive(run)) return;
    const applyDeps = deps ?? (await defaultDeps(db, run));
    const outcome = await applyTriageJob(applyDeps, job);
    if (outcome.status !== "ignored") {
      await removeTriageLabelQuietly(applyDeps.linear, run.linearIssueId);
      await continueWithPendingReply(db, run.id, applyDeps);
    }
  } catch (error) {
    console.error(`Applying triage job ${job.id} failed`, error);
  }
}

/**
 * A triage job failed for good or was canceled: its run ends `failed` (or
 * `stopped`), the session says so and the triage label is removed;
 * a reply that arrived while it ran starts the next job. Errors are logged,
 * not thrown.
 */
export async function onTriageJobFinishedWithoutResult(
  db: Database,
  job: Job,
  status: "failed" | "stopped",
  error: string | null,
  deps?: TriageJobDeps,
): Promise<void> {
  try {
    const run = await currentRun(db, job);
    if (!run) return;
    const claimed = await finishTriageRunJob(db, run.id, job.id, status);
    if (!claimed) return;
    const jobDeps = deps ?? (await defaultDeps(db, run));
    const { linear } = jobDeps;
    await postActivity(
      trackerConversation(linear, run.linearAgentSessionId, run.linearIssueId),
      status === "failed"
        ? {
            type: "error",
            body: `Triage failed${error ? `: ${error}` : ""}. Nothing changed in Linear; mention me with \`/triage\` to try again.`,
          }
        : { type: "response", body: "Triage was canceled. Nothing changed in Linear." },
    );
    await removeTriageLabelQuietly(linear, run.linearIssueId);
    await continueWithPendingReply(db, run.id, jobDeps);
  } catch (err) {
    console.error(`Recording the end of triage job ${job.id} failed`, err);
  }
}

const isActive = (run: TriageRun) =>
  (ACTIVE_TRIAGE_RUN_STATUSES as readonly string[]).includes(run.status);

/** Starts the run's next job when replies arrived while the last one ran. */
async function continueWithPendingReply(
  db: Database,
  runId: string,
  deps: TriageJobDeps,
): Promise<void> {
  const run = await getTriageRun(db, runId);
  if (!run?.pendingReply) return;
  await continueTriageAfterJob(
    {
      db,
      organizationId: run.organizationId,
      linear: deps.linear,
      dispatcher: deps.dispatcher ?? getDispatcher(),
      adapterFor: deps.adapterFor ?? scmAdapterFor,
    },
    run.id,
  );
}

async function defaultDeps(db: Database, run: TriageRun): Promise<TriageApplyDeps> {
  return { db, linear: await getLinearGateway({ db, organizationId: run.organizationId }) };
}
