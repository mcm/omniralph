/**
 * Cleanup after a ralph PR/MR merged (ported from cyralph's
 * `SessionManager.cleanupMerged`, `answerCleanup` and
 * `expireCleanupRequests`, `session-manager.ts:177-375`).
 *
 * - A merge also resolves the run's Linear issue (`resolveMergedIssue`).
 * - Triggers: the PR/MR's merge webhook, the Linear issue moving to completed,
 *   any follow-up check that finds it merged (`recordClosedPullRequest`), and
 *   the reconcile cron (`reconcileCleanup`) as the fallback.
 * - A PR/MR closed without merging (its close webhook, or any check that
 *   finds it closed) and a stopped run (`stopRun`) start a keep-branch
 *   cleanup (`startKeepBranchCleanup`): it stashes uncommitted changes and
 *   removes the worktree only, so a resumed run carries on from the local
 *   branch, and asks nothing. Resuming a stopped run drops one that hasn't
 *   started (`dropKeepBranchCleanups`). Nothing deletes a branch on origin.
 * - The work runs as a `worktree.cleanup` system RPC on the run's sticky
 *   harness (on both coding paths; a legacy `ralph.cleanup` job queued before
 *   that is still applied), which
 *   holds the lane's branch worktree, once none of the run's jobs is active
 *   (until then the lane's cleanup is `pending`). It stashes uncommitted
 *   changes, removes the worktree, and deletes the local branch unless it has
 *   unmerged commits. Its outcome (`applyCleanupJob`) says so in the run's
 *   session (a thought while the run is active, else a response) and asks
 *   about leftovers: the run's live stash entries ("Push to a branch on
 *   origin" / "Drop") and a kept branch ("Push to origin" / "Delete").
 * - The questions are stored on the lane (they survive restarts); a reply
 *   that answers one (`answerCleanup`, matched as cyralph does) runs another
 *   `worktree.cleanup` RPC doing it. Without an answer within
 *   `unmergedBranchTimeoutMinutes`, the cron deletes the kept branch.
 */
import {
  getJob,
  getLane,
  getLaneByRepository,
  getRepositoryWithConnection,
  getRun,
  getRunByIssue,
  isLinearRun,
  listActiveRunJobIds,
  listLanes,
  listLanesToCleanUp,
  listOpenPullRequestLanes,
  lockRun,
  updateLane,
  type Job,
  type RalphCleanupQuestion,
  type RalphLane,
  type RalphLaneCleanup,
  type RalphRun,
  type RalphRunOrigin,
  type RalphStash,
  type RalphTransaction,
  runReference,
} from "@omniralph/db";
import {
  branchAnswerMessage,
  closedCleanupMessage,
  branchExpiredMessage,
  branchQuestion,
  cleanupAnswerFailedMessage,
  cleanupOptions,
  DELETE_BRANCH,
  matchCleanupAnswer,
  mergedCleanupMessage,
  PUSH_BRANCH,
  PUSH_STASHES,
  stashAnswerMessage,
  stashQuestion,
} from "@omniralph/ralph";
import type { ChangeRequestStatus } from "@omniralph/scm";
import {
  parseRalphSettings,
  WORKTREE_CLEANUP_JOB_TYPE,
  WorktreeCleanupPayload,
  WorktreeCleanupResult,
  ralphStashBranch,
  type RalphCleanupAction,
  legacyJobRouting,
} from "@omniralph/shared";
import { jobRepository } from "@/lib/scm/adapters";
import { conversationFor } from "./conversation";
import { errorMessage, postActivity } from "./notify";
import { jobFailure } from "./outcome";
import { jobSettings } from "./payload";
import { changeRequestTerm } from "./publish";
import { advanceRun, FINISHED_RUN_STATUSES, stickyHarnessId, type RalphDeps } from "./run";

const ACTIVE_JOB_STATUSES = new Set<Job["status"]>(["queued", "running"]);

/** At most one cleanup job (`worktree.cleanup`, or a legacy `ralph.cleanup`) per lane at a time. */
export function cleanupDedupeKey(laneId: string): string {
  return `ralph-cleanup:${laneId}`;
}

export type CleanupStart =
  | {
      status: "ignored";
      reason:
        | "gone"
        | "not_merged"
        | "not_closed"
        | "not_stopped"
        | "started"
        | "repository_unavailable"
        | "opted_out";
    }
  /** None of the run's jobs ran on an agent: there's no worktree to remove. */
  | { status: "nothing" }
  /** One of the run's jobs is active (it may use the worktree): it starts when they're done. */
  | { status: "pending" }
  | { status: "enqueued"; jobId: string };

/**
 * What a cleanup is for: a PR/MR merged at `mergedSha` (its head), or a
 * keep-branch cleanup after the PR/MR closed unmerged or the run stopped.
 */
export type CleanupTarget = { mergedSha: string } | { keepBranch: "closed" | "stopped" };

/** The target a stored cleanup was started for. */
function targetOf(cleanup: RalphLaneCleanup): CleanupTarget {
  return cleanup.keepBranch
    ? { keepBranch: cleanup.keepBranch }
    : { mergedSha: cleanup.mergedSha ?? "" };
}

/** A new cleanup of `target`. */
function newCleanup(target: CleanupTarget): RalphLaneCleanup {
  return "keepBranch" in target
    ? {
        status: "pending",
        at: now(),
        mergedSha: null,
        keepBranch: target.keepBranch,
        questions: [],
      }
    : { status: "pending", at: now(), mergedSha: target.mergedSha, questions: [] };
}

const now = () => new Date().toISOString();

/**
 * Posts a cleanup message in the run's session: a thought while the run is
 * active (pending, running or waiting), otherwise a response, so Linear
 * sees a finished session complete again (in chat, always a new message).
 */
async function notify(
  deps: Pick<RalphDeps, "linear" | "chat">,
  run: RalphRun,
  body: string,
): Promise<void> {
  await postActivity(
    conversationFor(run, deps),
    { type: FINISHED_RUN_STATUSES.has(run.status) ? "response" : "thought", body },
    { notice: true },
  );
}

/**
 * Enqueues a `worktree.cleanup` system RPC for the lane on the lane's sticky
 * harness (the one holding its worktree; its token is the only system RPC token
 * that may push).
 * Null when that's impossible: the repository is gone or the lane's agent can't
 * take ralph jobs anymore (`why`, naming the lane's repository).
 */
async function enqueueCleanupJob(
  deps: RalphDeps,
  run: RalphRun,
  lane: RalphLane,
  action: RalphCleanupAction,
): Promise<{ jobId: string } | { why: string }> {
  const found = await getRepositoryWithConnection(deps.db, lane.repositoryId);
  if (!found || found.repository.disconnectedAt) {
    return { why: "the repository is no longer connected" };
  }
  const { repository, connection } = found;
  const harnessId = await stickyHarnessId(deps.db, run, lane);
  if (!harnessId) {
    return {
      why: `the agent that holds the branch in \`${repository.fullPath}\` can't take coding jobs anymore`,
    };
  }
  const payload = WorktreeCleanupPayload.parse({
    runId: run.id,
    repositoryId: repository.id,
    repository: jobRepository(repository, connection),
    branch: lane.branch,
    baseBranch: lane.baseBranch,
    settings: jobSettings(repository),
    epic: { identifier: runReference(run) },
    action,
  });
  const { job } = await deps.dispatcher.createAndPublish({
    organizationId: run.organizationId,
    type: WORKTREE_CLEANUP_JOB_TYPE,
    ...legacyJobRouting(WORKTREE_CLEANUP_JOB_TYPE),
    payload,
    repositoryId: repository.id,
    ralphRunId: run.id,
    dedupeKey: cleanupDedupeKey(lane.id),
    targetHarnessId: harnessId,
  });
  return { jobId: job.id };
}

/**
 * Starts the cleanup of a lane whose PR/MR merged at `mergedSha` (its head),
 * unless it started already (a failed or pending one starts again), the
 * repository opted out (`cleanupMergedWorktrees`), or the lane never ran a job
 * on an agent. Waits (`pending`) while one of the run's jobs is active.
 */
export function startCleanup(
  deps: RalphDeps,
  laneId: string,
  mergedSha: string,
): Promise<CleanupStart> {
  return beginCleanup(deps, laneId, { mergedSha });
}

/**
 * Starts the keep-branch cleanup of a lane (stash, remove the worktree, keep
 * the local branch) after its PR/MR closed unmerged or its run stopped, on
 * the same terms as `startCleanup`. A lane whose PR/MR merged gets the merge
 * cleanup instead; a stopped run's that resumed in the meantime gets none.
 */
export function startKeepBranchCleanup(
  deps: RalphDeps,
  laneId: string,
  reason: "closed" | "stopped",
): Promise<CleanupStart> {
  return beginCleanup(deps, laneId, { keepBranch: reason });
}

async function beginCleanup(
  deps: RalphDeps,
  laneId: string,
  target: CleanupTarget,
): Promise<CleanupStart> {
  const lane = await getLane(deps.db, laneId);
  if (!lane) return { status: "ignored", reason: "gone" };
  const result = await lockRun(deps.db, lane.runId, async (tx, run): Promise<CleanupStart> => {
    const current = await getLane(tx, laneId);
    if (!current) return { status: "ignored", reason: "gone" };
    const keep = "keepBranch" in target ? target.keepBranch : null;
    if (!keep && !current.prMerged) return { status: "ignored", reason: "not_merged" };
    const outdated =
      keep === "closed" && (!current.prClosed || current.prMerged)
        ? "not_closed"
        : keep === "stopped" && (run.status !== "stopped" || current.prMerged)
          ? "not_stopped"
          : null;
    if (outdated) {
      // A waiting or failed keep-branch cleanup that no longer applies is dropped (a merged
      // lane then gets the merge cleanup from the reconcile cron).
      if (current.cleanup?.keepBranch && !current.cleanup.jobId) {
        await updateLane(tx, laneId, { cleanup: null });
      }
      return { status: "ignored", reason: outdated };
    }
    let stored = current.cleanup;
    if (stored?.keepBranch && !keep) {
      // The PR/MR merged after a keep-branch cleanup: the merge's starts once that one is
      // through (`applyCleanupJob` hands a merged lane over to the reconcile cron).
      if (stored.jobId) return { status: "pending" };
      stored = null;
    }
    const state = stored ?? newCleanup(target);
    if (stored && (state.status === "running" || state.status === "done")) {
      return { status: "ignored", reason: "started" };
    }
    const found = await getRepositoryWithConnection(deps.db, current.repositoryId);
    if (!found) return { status: "ignored", reason: "repository_unavailable" };
    if (!parseRalphSettings(found.repository.ralphSettings).cleanupMergedWorktrees) {
      return { status: "ignored", reason: "opted_out" };
    }
    if (!current.harnessId) {
      await updateLane(tx, laneId, { cleanup: { ...state, status: "done", at: now() } });
      return { status: "nothing" };
    }
    if ((await listActiveRunJobIds(tx, run.id)).length > 0) {
      if (!stored || state.status !== "pending") {
        await updateLane(tx, laneId, { cleanup: { ...state, status: "pending", at: now() } });
      }
      return { status: "pending" };
    }
    const stashes = current.stashes.map((s) => s.sha);
    const enqueued = await enqueueCleanupJob(
      deps,
      run,
      current,
      state.keepBranch
        ? { kind: "cleanup", keepBranch: true, stashes }
        : { kind: "cleanup", mergedSha: state.mergedSha ?? undefined, stashes },
    );
    if ("why" in enqueued) {
      console.warn(`Not cleaning up ${current.branch} of ralph run ${run.id}: ${enqueued.why}`);
      await updateLane(tx, laneId, {
        cleanup: { ...state, status: "done", at: now(), error: enqueued.why },
      });
      return { status: "nothing" };
    }
    await updateLane(tx, laneId, {
      cleanup: { ...state, status: "running", at: now(), jobId: enqueued.jobId },
    });
    return { status: "enqueued", jobId: enqueued.jobId };
  });
  return result ?? { status: "ignored", reason: "gone" };
}

/**
 * Starts a keep-branch cleanup of every lane of a run that was just stopped
 * (`stopRun`): pending until its canceled jobs are through. Failures are
 * logged: the reconcile cron retries a cleanup that waits or failed.
 */
export async function cleanUpStoppedRun(deps: RalphDeps, runId: string): Promise<void> {
  for (const lane of await listLanes(deps.db, runId)) {
    try {
      await startKeepBranchCleanup(deps, lane.id, "stopped");
    } catch (error) {
      console.error(`Starting the cleanup of ${lane.branch} (ralph lane ${lane.id}) failed`, error);
    }
  }
}

/**
 * A stopped run resumes: its lanes' keep-branch cleanups that aren't running
 * are dropped (a running one just removes the worktree, which the next job
 * recreates from the kept branch), so they neither remove the worktree under
 * the resumed run nor stop a later stop or close from cleaning up again.
 */
export async function dropKeepBranchCleanups(tx: RalphTransaction, runId: string): Promise<void> {
  for (const lane of await listLanes(tx, runId)) {
    if (lane.cleanup?.keepBranch && !lane.cleanup.jobId) {
      await updateLane(tx, lane.id, { cleanup: null });
    }
  }
}

/**
 * Records a PR/MR seen closed or merged (it's no longer followed up), and
 * starts the cleanup: when it merged, the merge cleanup; closed unmerged, the
 * keep-branch one. The single place every check that finds a ralph PR/MR
 * closed goes through. A cleanup that fails to start is logged: the
 * reconcile cron tries again.
 */
export async function recordClosedPullRequest(
  deps: RalphDeps,
  lane: RalphLane,
  state: ChangeRequestStatus,
): Promise<void> {
  await updateLane(deps.db, lane.id, {
    prClosed: true,
    prMerged: state.state === "merged",
    prStateUpdatedAt: new Date(),
    mergeSha: state.mergeSha,
  });
  try {
    if (state.state === "merged") await startCleanup(deps, lane.id, state.headSha);
    else await startKeepBranchCleanup(deps, lane.id, "closed");
  } catch (error) {
    console.error(`Starting the cleanup of ${lane.branch} (ralph lane ${lane.id}) failed`, error);
  }
  if (state.state === "merged") await resolveMergedIssue(deps, lane);
}

/**
 * A lane's PR/MR merged: the run's Linear issue (the epic, or the single
 * issue) moves to the team's first completed state, whether or not the code
 * host's Linear integration does it too. Not while another lane's work isn't
 * merged yet (its PR/MR is open, or not opened yet), nor when the issue is already completed or canceled; a chat run
 * has no issue. A failure is logged.
 */
async function resolveMergedIssue(deps: RalphDeps, lane: RalphLane): Promise<void> {
  try {
    const run = await getRun(deps.db, lane.runId);
    if (!run || !isLinearRun(run)) return;
    const lanes = await listLanes(deps.db, run.id);
    if (lanes.some((l) => l.id !== lane.id && !l.prClosed && !l.prMerged)) return;
    const issue = await deps.linear.getIssue(run.linearIssueId);
    if (issue.stateType === "completed" || issue.stateType === "canceled") return;
    await deps.linear.setIssueState(run.linearIssueId, { type: "completed" });
  } catch (error) {
    console.error(
      `Resolving the Linear issue of ralph lane ${lane.id} after its merge failed`,
      error,
    );
  }
}

/**
 * Checks whether the lane's PR/MR closed and records it (starts the
 * cleanup). Returns the state, or null when the repository is unavailable.
 */
async function checkPullRequest(
  deps: RalphDeps,
  lane: RalphLane,
): Promise<ChangeRequestStatus | null> {
  if (lane.prNumber === null) return null;
  const found = await getRepositoryWithConnection(deps.db, lane.repositoryId);
  if (!found || found.repository.disconnectedAt) return null;
  const { repository, connection } = found;
  const state = await deps
    .adapterFor(deps.db, connection)
    .getChangeRequestState(
      { fullPath: repository.fullPath, externalId: repository.externalId },
      lane.prNumber,
    );
  if (state.state !== "open") await recordClosedPullRequest(deps, lane, state);
  return state;
}

/** A close or merge webhook for a ralph PR/MR: checks it with the code host and cleans up. */
export async function cleanupClosedPullRequest(
  deps: RalphDeps,
  lane: RalphLane,
): Promise<ChangeRequestStatus | null> {
  return checkPullRequest(deps, lane);
}

/**
 * The Linear issue of a run moved to completed (cyralph's `issue_state`
 * trigger): the newest run's PRs/MRs are checked, and merged ones cleaned
 * up. One still open is left alone. Failures are logged.
 */
export async function cleanupAfterIssueCompleted(
  deps: RalphDeps,
  linearIssueId: string,
): Promise<void> {
  const run = await getRunByIssue(deps.db, deps.organizationId, linearIssueId);
  if (!run) return;
  for (const lane of await listLanes(deps.db, run.id)) {
    if (lane.prNumber === null || (lane.prClosed && !lane.prMerged)) continue;
    try {
      if (!lane.prClosed) await checkPullRequest(deps, lane);
      else if (!lane.cleanup) await checkMergedAgain(deps, lane);
    } catch (error) {
      console.error(
        `Checking ${lane.prUrl} after ${run.linearIdentifier} was completed failed`,
        error,
      );
    }
  }
}

/** A lane known merged but never cleaned up: its merged head is read again to start. */
async function checkMergedAgain(deps: RalphDeps, lane: RalphLane): Promise<CleanupStart | null> {
  if (lane.prNumber === null) return null;
  const found = await getRepositoryWithConnection(deps.db, lane.repositoryId);
  if (!found || found.repository.disconnectedAt) return null;
  const state = await deps
    .adapterFor(deps.db, found.connection)
    .getChangeRequestState(
      { fullPath: found.repository.fullPath, externalId: found.repository.externalId },
      lane.prNumber,
    );
  return state.state === "merged" ? startCleanup(deps, lane.id, state.headSha) : null;
}

/**
 * The lane a cleanup job (`worktree.cleanup`, or a legacy `ralph.cleanup`:
 * same payload and result) works on, with its run.
 */
async function jobLane(
  tx: RalphTransaction,
  run: RalphRun,
  job: Job,
): Promise<{
  lane: RalphLane;
  payload: WorktreeCleanupPayload & { action: RalphCleanupAction };
} | null> {
  const payload = WorktreeCleanupPayload.safeParse(job.payload);
  // One deleting hidden refs only isn't a lane's cleanup (`applyHiddenRefsJob`).
  if (!payload.success || !payload.data.action) return null;
  const lane = await getLaneByRepository(tx, run.id, payload.data.repositoryId);
  if (!lane?.cleanup || lane.cleanup.jobId !== job.id) return null;
  return { lane, payload: { ...payload.data, action: payload.data.action } };
}

/** Replaces the open question of the same kind (cyralph's `ask`). */
function withQuestion(
  questions: readonly RalphCleanupQuestion[],
  question: RalphCleanupQuestion,
): RalphCleanupQuestion[] {
  return [...questions.filter((q) => q.kind !== question.kind), question];
}

/**
 * Applies the outcome of a lane's cleanup job once it finished (from
 * its outcome hooks, and the reconcile cron for one that was missed): says
 * what was cleaned up and asks about leftovers, or what an answer did. A
 * failed cleanup is tried again by the cron; a failed answer can be given
 * again; a failed timeout deletion is retried by the cron.
 */
export async function applyCleanupJob(deps: RalphDeps, jobId: string): Promise<boolean> {
  const job = await getJob(deps.db, jobId);
  if (!job?.ralphRunId || ACTIVE_JOB_STATUSES.has(job.status)) return false;
  const applied = await lockRun(deps.db, job.ralphRunId, async (tx, run) => {
    const found = await jobLane(tx, run, job);
    if (!found) return false;
    const { lane, payload } = found;
    const cleanup = lane.cleanup!;
    const parsed = job.status === "completed" ? WorktreeCleanupResult.safeParse(job.result) : null;
    const error = !parsed
      ? jobFailure(job)
      : !parsed.success
        ? "the agent sent an invalid result"
        : parsed.data.error;
    const { jobId: _jobId, answer, ...rest } = cleanup;
    const action = payload.action;

    if (action.kind === "cleanup") {
      if (error || !parsed?.success) {
        console.warn(`The cleanup of ${lane.branch} (ralph run ${run.id}) failed: ${error}`);
        await updateLane(tx, lane.id, {
          cleanup: { ...rest, status: "failed", at: now(), error: error ?? "unknown error" },
        });
        return true;
      }
      const result = parsed.data;
      const known = new Map(lane.stashes.map((s) => [s.sha, s]));
      // Entries someone dropped or applied by other means are forgotten.
      const stashes: RalphStash[] = result.stashes.map(
        (e) =>
          known.get(e.sha) ?? {
            sha: e.sha,
            reason: e.sha === result.stashed ? "cleanup" : "leftover",
            at: e.date,
          },
      );
      const target = await getRepositoryWithConnection(deps.db, lane.repositoryId);
      const repository = target?.repository;
      if (rest.keepBranch) {
        // Asks nothing: the branch stays, and so do the stash entries (a resumed run is offered
        // its own). A PR/MR that merged meanwhile is handed to the cron's merge cleanup; a
        // stopped run that resumed meanwhile can be cleaned up again when it stops again.
        if (rest.keepBranch === "closed" && result.removedWorktree && !lane.prMerged) {
          await notify(
            deps,
            run,
            closedCleanupMessage({
              term: changeRequestTerm(repository?.provider ?? "github"),
              prUrl: lane.prUrl ?? `#${lane.prNumber}`,
              branch: lane.branch,
              stashed: result.stashed,
            }),
          );
        }
        const over = lane.prMerged || (rest.keepBranch === "stopped" && run.status !== "stopped");
        await updateLane(tx, lane.id, {
          stashes,
          cleanup: over ? null : { ...rest, status: "done", at: now(), error: undefined },
        });
        return true;
      }
      let questions = rest.questions;
      const settings = parseRalphSettings(repository?.ralphSettings);
      if (result.removedWorktree || result.hadBranch) {
        await notify(
          deps,
          run,
          mergedCleanupMessage({
            term: changeRequestTerm(repository?.provider ?? "github"),
            prUrl: lane.prUrl ?? `#${lane.prNumber}`,
            branch: lane.branch,
            keptBranch: result.unmerged > 0,
            stashed: result.stashed,
          }),
        );
      }
      const asked = now();
      if (result.stashes.length > 0) {
        const question: RalphCleanupQuestion = {
          kind: "stashes",
          shas: result.stashes.map((e) => e.sha),
          askedAt: asked,
        };
        questions = withQuestion(questions, question);
        await ask(
          deps,
          run,
          { lane, jobId: job.id },
          question,
          stashQuestion({
            epic: runReference(run),
            repository: repository?.fullPath ?? payload.repository.fullPath,
            stashBranch: ralphStashBranch(runReference(run)),
            entries: result.stashes,
          }),
        );
      }
      if (result.unmerged > 0) {
        const minutes = settings.unmergedBranchTimeoutMinutes;
        const question: RalphCleanupQuestion = {
          kind: "branch",
          commits: result.unmerged,
          askedAt: asked,
          deadline: new Date(Date.parse(asked) + minutes * 60_000).toISOString(),
        };
        questions = withQuestion(questions, question);
        await ask(
          deps,
          run,
          { lane, jobId: job.id },
          question,
          branchQuestion({ branch: lane.branch, commits: result.unmerged, minutes }),
        );
      }
      await updateLane(tx, lane.id, {
        stashes,
        cleanup: { ...rest, status: "done", at: now(), questions, error: undefined },
      });
      return true;
    }

    const option = answer?.option ?? (action.push ? PUSH_BRANCH : DELETE_BRANCH);
    if (error || !parsed?.success) {
      await updateLane(tx, lane.id, { cleanup: { ...rest, at: now() } });
      // A timed-out branch is deleted again on the next pass, without a word.
      if (answer?.expired) {
        console.warn(`Deleting ${lane.branch} after its question timed out failed: ${error}`);
      } else {
        await notify(deps, run, cleanupAnswerFailedMessage(option, error ?? "unknown error"));
      }
      return true;
    }
    const question = rest.questions.find((q) => q.kind === action.kind);
    const questions = rest.questions.filter((q) => q.kind !== action.kind);
    if (action.kind === "stashes") {
      await updateLane(tx, lane.id, {
        stashes: lane.stashes.filter((s) => !action.shas.includes(s.sha)),
        cleanup: { ...rest, at: now(), questions },
      });
      await notify(
        deps,
        run,
        stashAnswerMessage({
          option,
          count: parsed.data.handled,
          epic: runReference(run),
          stashBranch: ralphStashBranch(runReference(run)),
        }),
      );
      return true;
    }
    await updateLane(tx, lane.id, { cleanup: { ...rest, at: now(), questions } });
    const commits = question?.kind === "branch" ? question.commits : 0;
    if (answer?.expired && question?.kind === "branch") {
      const minutes = Math.round(
        (Date.parse(question.deadline) - Date.parse(question.askedAt)) / 60_000,
      );
      await notify(deps, run, branchExpiredMessage({ branch: lane.branch, commits, minutes }));
    } else {
      await notify(deps, run, branchAnswerMessage({ option, branch: lane.branch, commits }));
    }
    return true;
  });
  return applied ?? false;
}

/** Posts a cleanup question as a select elicitation with its two options. */
async function ask(
  deps: Pick<RalphDeps, "linear" | "chat">,
  run: RalphRun,
  where: { lane: RalphLane; jobId: string },
  question: RalphCleanupQuestion,
  body: string,
): Promise<void> {
  const options = cleanupOptions(question);
  await postActivity(
    conversationFor(run, deps),
    { type: "elicitation", body },
    {
      signal: "select",
      signalMetadata: { options: options.map((value) => ({ value })) },
      event: {
        kind: "cleanup_question",
        // One question of each kind per lane and cleanup job (a replayed result asks once).
        key: `cleanup:${where.lane.id}:${where.jobId}:${question.kind}`,
        details: { laneId: where.lane.id, branch: where.lane.branch, question, options },
      },
    },
  );
}

/**
 * A cleanup job finished (completed, failed for good or canceled):
 * its outcome is applied, cleanups of the run's other lanes that waited for
 * it start, and an unfinished run moves on. Errors are logged; the reconcile
 * cron catches up.
 */
export async function onCleanupJobFinished(deps: RalphDeps, job: Job): Promise<void> {
  try {
    await applyCleanupJob(deps, job.id);
    if (job.ralphRunId) await afterRunJob(deps, job.ralphRunId);
  } catch (error) {
    console.error(`Applying the outcome of cleanup job ${job.id} failed`, error);
  }
}

/**
 * After one of the run's jobs finished: an unfinished run moves on (only
 * after a cleanup job; other jobs advance it themselves), and the lanes whose
 * cleanup waited start it.
 */
export async function startPendingCleanups(deps: RalphDeps, runId: string): Promise<void> {
  for (const lane of await listLanes(deps.db, runId)) {
    if (lane.cleanup?.status !== "pending") continue;
    await beginCleanup(deps, lane.id, targetOf(lane.cleanup));
  }
}

async function afterRunJob(deps: RalphDeps, runId: string): Promise<void> {
  const run = await getRun(deps.db, runId);
  if (!run) return;
  if (!FINISHED_RUN_STATUSES.has(run.status)) await advanceRun(run.id, deps);
  await startPendingCleanups(deps, run.id);
}

export type CleanupAnswer =
  | { status: "enqueued"; jobId: string; option: string }
  /** The lane's previous answer is still being carried out. */
  | { status: "busy"; option: string }
  | { status: "failed"; option: string; error: string };

/**
 * A reply in the run's session that answers one of its lanes' open cleanup
 * questions (`matchCleanupAnswer`: the option, `1`/`2` when only one is open,
 * or a short reply with a unique first word; newest question first) runs a
 * `worktree.cleanup` RPC doing it. Null: the reply isn't an answer.
 */
export async function answerCleanup(
  deps: RalphDeps,
  runId: string,
  reply: string,
  /** Only this lane's question (an answer from Omniralph names the question it answers). */
  only?: { laneId: string },
): Promise<CleanupAnswer | null> {
  const result = await lockRun(deps.db, runId, async (tx, run) => {
    const lanes = await listLanes(tx, run.id);
    const pending = lanes
      .filter((lane) => !only || lane.id === only.laneId)
      .flatMap((lane) => (lane.cleanup?.questions ?? []).map((question) => ({ ...question, lane })))
      .sort((a, b) => a.askedAt.localeCompare(b.askedAt));
    if (pending.length === 0) return null;
    const match = matchCleanupAnswer(reply, pending);
    if (!match) return null;
    const { question, option } = match;
    const lane = question.lane;
    const cleanup = lane.cleanup!;
    if (cleanup.jobId) return { status: "busy" as const, option };
    const push = option === PUSH_STASHES || option === PUSH_BRANCH;
    const action: RalphCleanupAction =
      question.kind === "stashes"
        ? { kind: "stashes", push, shas: question.shas }
        : { kind: "branch", push };
    const enqueued = await enqueueCleanupJob(deps, run, lane, action);
    if ("why" in enqueued) {
      await notify(deps, run, cleanupAnswerFailedMessage(option, enqueued.why));
      return { status: "failed" as const, option, error: enqueued.why };
    }
    await updateLane(tx, lane.id, {
      cleanup: {
        ...cleanup,
        at: now(),
        jobId: enqueued.jobId,
        answer: { kind: question.kind, option },
      },
    });
    return { status: "enqueued" as const, jobId: enqueued.jobId, option };
  });
  if (result?.status === "busy") {
    const run = await getRun(deps.db, runId);
    if (run) {
      await notify(
        deps,
        run,
        "I'm still carrying out the previous answer about this branch. Answer again once it's done.",
      );
    }
  }
  return result;
}

/**
 * Deletes kept branches whose question got no answer within
 * `unmergedBranchTimeoutMinutes` (a `worktree.cleanup` RPC; the outcome says
 * "Nobody answered within …"). Leftover stashes have no timeout.
 */
async function expireBranchQuestion(deps: RalphDeps, lane: RalphLane, at: Date): Promise<boolean> {
  const question = lane.cleanup?.questions.find((q) => q.kind === "branch");
  if (!question || question.kind !== "branch" || Date.parse(question.deadline) > at.getTime()) {
    return false;
  }
  const result = await lockRun(deps.db, lane.runId, async (tx, run) => {
    const current = await getLane(tx, lane.id);
    if (!current?.cleanup || current.cleanup.jobId) return false;
    if (!current.cleanup.questions.some((q) => q.kind === "branch")) return false;
    const enqueued = await enqueueCleanupJob(deps, run, current, { kind: "branch", push: false });
    if ("why" in enqueued) {
      console.warn(`Can't delete ${current.branch} after its question timed out: ${enqueued.why}`);
      return false;
    }
    await updateLane(tx, current.id, {
      cleanup: {
        ...current.cleanup,
        at: now(),
        jobId: enqueued.jobId,
        answer: { kind: "branch", option: DELETE_BRANCH, expired: true },
      },
    });
    return true;
  });
  return result ?? false;
}

/**
 * The reconcile cron's cleanup pass of the organization's runs (the fallback for missed webhooks):
 * open ralph PRs/MRs of repositories that clean up are checked (merged ones
 * are recorded and cleaned up); merged lanes whose cleanup never started,
 * waits or failed are started; finished cleanup jobs whose outcome was never
 * applied are applied; and kept branches whose question timed out are
 * deleted. Only runs of `origin` when given. Failures are logged and counted.
 */
export async function reconcileCleanup(
  deps: RalphDeps,
  at = new Date(),
  origin?: RalphRunOrigin,
): Promise<{ checked: number; started: number; expired: number; failed: number }> {
  const counts = { checked: 0, started: 0, expired: 0, failed: 0 };
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      counts.failed += 1;
      console.error(`${what} failed: ${errorMessage(error)}`);
    }
  };
  const optedIn = new Map<string, boolean>();
  const cleansUp = async (repositoryId: string) => {
    if (!optedIn.has(repositoryId)) {
      const found = await getRepositoryWithConnection(deps.db, repositoryId);
      optedIn.set(
        repositoryId,
        !!found &&
          !found.repository.disconnectedAt &&
          parseRalphSettings(found.repository.ralphSettings).cleanupMergedWorktrees,
      );
    }
    return optedIn.get(repositoryId) ?? false;
  };

  for (const { lane } of await listOpenPullRequestLanes(deps.db, deps.organizationId, origin)) {
    if (!(await cleansUp(lane.repositoryId))) continue;
    await attempt(`Checking whether ${lane.prUrl} merged`, async () => {
      counts.checked += 1;
      await checkPullRequest(deps, lane);
    });
  }

  for (const { lane } of await listLanesToCleanUp(deps.db, deps.organizationId, origin)) {
    const cleanup = lane.cleanup;
    await attempt(`Cleaning up ${lane.branch} (coding task lane ${lane.id})`, async () => {
      if (cleanup?.jobId) {
        const job = await getJob(deps.db, cleanup.jobId);
        if (job && ACTIVE_JOB_STATUSES.has(job.status)) return;
        if (job) {
          await applyCleanupJob(deps, job.id);
        } else {
          const { jobId: _gone, answer: _answer, ...rest } = cleanup;
          await updateLane(deps.db, lane.id, {
            cleanup: { ...rest, status: rest.status === "running" ? "failed" : rest.status },
          });
        }
        return;
      }
      if (!cleanup) {
        if (!(await cleansUp(lane.repositoryId))) return;
        if ((await checkMergedAgain(deps, lane))?.status === "enqueued") counts.started += 1;
        return;
      }
      if (cleanup.status === "pending" || cleanup.status === "failed") {
        const started = await beginCleanup(deps, lane.id, targetOf(cleanup));
        if (started.status === "enqueued") counts.started += 1;
        return;
      }
      if (await expireBranchQuestion(deps, lane, at)) counts.expired += 1;
    });
  }
  return counts;
}
