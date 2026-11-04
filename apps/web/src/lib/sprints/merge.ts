import "server-only";
import {
  findStartedSprintEpic,
  getLane,
  getRepositoryWithConnection,
  getRun,
  isTrackerRun,
  listActiveRunJobIds,
  listLanes,
  pullRequestReviewGate,
  setSprintEpicState,
  type RalphLane,
  type RalphRun,
} from "@omniralph/db";
import { ChangeRequestRefusedError, type RepoRef, type ScmAdapter } from "@omniralph/scm";
import { recordClosedPullRequest } from "@/lib/ralph/cleanup";
import type { RalphDeps } from "@/lib/ralph/run";

/**
 * Merging a merge-together sprint's epic PRs into its sprint branch: once the epic's run is
 * done working, its PR/MR (targeting the sprint branch) is approved and merged when the checks
 * its target branch requires have passed (with none required, its CI has passed or it has
 * none), no review of it is still running and none of its review findings is open. Each new
 * push (its CI finishing, the job that pushed finishing), each finished review and the sprint
 * check evaluate it again. Om approves pinned to the head it judged; GitHub refuses an App's
 * approval of its own PR, which doesn't stop the merge (branch protection decides). A merge the
 * code host refuses stalls the epic and pauses the sprint with the host's reason; a head that
 * moved waits for the next evaluation.
 */

/** Why an epic PR isn't merged yet. */
export type EpicMergeWait =
  /** The epic's run is still working (or has a pending request, e.g. review findings). */
  | "working"
  | "draft"
  | "checks_pending"
  | "checks_failed"
  | "reviewing"
  | "findings"
  /** The PR/MR moved on while Om was deciding: its next evaluation decides. */
  | "head_changed";

export type EpicMergeResult =
  /** Not the PR/MR of a running merge-together sprint epic, aimed at its sprint branch. */
  | { status: "skipped" }
  | { status: "waiting"; why: EpicMergeWait }
  | { status: "merged" }
  /** It was closed or merged on the code host already: recorded. */
  | { status: "closed" }
  /** The code host refused the merge: the epic stalled and the sprint paused with `reason`. */
  | { status: "paused"; reason: string };

/** The pause reason of an epic PR the code host refused to merge. */
export const mergeRefusedReason = (identifier: string, branch: string, hostMessage: string) =>
  `The code host refused to merge ${identifier}'s PR into ${branch}: ${hostMessage}`;

const waiting = (why: EpicMergeWait): EpicMergeResult => ({ status: "waiting", why });

/**
 * Whether the checks gate the head: the required ones passed, or with none required, its CI
 * passed or it has none.
 */
async function checksGate(
  adapter: ScmAdapter,
  repo: RepoRef,
  number: number,
  headSha: string,
): Promise<EpicMergeWait | null> {
  const required = await adapter.getRequiredChecks(repo, number);
  if (required.headSha !== headSha) return "head_changed";
  const state =
    required.state === "none" ? (await adapter.getCiStatus(repo, number)).state : required.state;
  if (state === "failed") return "checks_failed";
  if (state === "pending") return "checks_pending";
  return null;
}

/**
 * Approves and merges a lane's PR/MR into its sprint branch when it is clean (see the module
 * comment). Anything but a running merge-together sprint epic's PR/MR targeting the sprint's
 * branch, in the sprint's repo, is skipped.
 */
export async function mergeSprintEpicWhenClean(
  deps: RalphDeps,
  laneId: string,
): Promise<EpicMergeResult> {
  const { db } = deps;
  const lane = await getLane(db, laneId);
  if (!lane || lane.prNumber === null || lane.prClosed) return { status: "skipped" };
  const run = await getRun(db, lane.runId);
  if (!run || !isTrackerRun(run)) return { status: "skipped" };
  const found = await findStartedSprintEpic(
    db,
    run.organizationId,
    run.trackerProvider,
    run.trackerIssueId,
  );
  if (!found) return { status: "skipped" };
  const { sprint, epic } = found;
  const branch = sprint.sprintBranch;
  if (
    !sprint.mergeTogether ||
    sprint.status !== "running" ||
    epic.state !== "running" ||
    !branch ||
    lane.repositoryId !== sprint.repositoryId ||
    lane.baseBranch !== branch
  ) {
    return { status: "skipped" };
  }
  if (run.status !== "completed" || (await listActiveRunJobIds(db, run.id)).length > 0) {
    return waiting("working");
  }

  const target = await getRepositoryWithConnection(db, lane.repositoryId);
  if (!target || target.repository.disconnectedAt) return { status: "skipped" };
  const { repository, connection } = target;
  const repo = { fullPath: repository.fullPath, externalId: repository.externalId };
  const adapter = deps.adapterFor(db, connection);
  const number = lane.prNumber;

  const pr = await adapter.getChangeRequest(repo, number);
  if (pr.state !== "open") {
    await recordClosedPullRequest(deps, lane, await adapter.getChangeRequestState(repo, number));
    return { status: "closed" };
  }
  // Only into the sprint branch: never land an epic on the default branch by itself.
  if (pr.baseRef !== branch) return { status: "skipped" };
  if (pr.draft) return waiting("draft");
  const checks = await checksGate(adapter, repo, number, pr.headSha);
  if (checks) return waiting(checks);
  const reviews = await pullRequestReviewGate(db, {
    repositoryId: repository.id,
    prNumber: number,
  });
  if (reviews.reviewing) return waiting("reviewing");
  if (reviews.openFindings > 0) return waiting("findings");

  const headSha = pr.headSha;
  try {
    await adapter.approvePullRequest(repo, number, { headSha });
  } catch (error) {
    if (!(error instanceof ChangeRequestRefusedError)) throw error;
    if (error.reason === "head_changed") return waiting("head_changed");
    // E.g. GitHub's "Can not approve your own pull request": the merge decides.
    console.warn(`Approving ${repo.fullPath}#${number} was refused`, error.hostMessage);
  }
  let mergeSha: string | null;
  try {
    ({ mergeSha } = await adapter.mergePullRequest(repo, number, { headSha }));
  } catch (error) {
    if (!(error instanceof ChangeRequestRefusedError)) throw error;
    if (error.reason === "head_changed") return waiting("head_changed");
    if (error.reason === "not_open") {
      const state = await adapter.getChangeRequestState(repo, number);
      if (state.state === "open") return waiting("head_changed");
      await recordClosedPullRequest(deps, lane, state);
      return { status: "closed" };
    }
    const reason = mergeRefusedReason(epic.identifier, branch, error.hostMessage);
    await setSprintEpicState(db, {
      organizationId: run.organizationId,
      epicId: epic.id,
      from: ["running"],
      state: "stalled",
      pause: reason,
    });
    return { status: "paused", reason };
  }
  // Recorded now rather than on the merge webhook: the epic merges and the next one starts.
  await recordClosedPullRequest(deps, lane, { state: "merged", headSha, mergeSha });
  return { status: "merged" };
}

/** Each open PR/MR of the run that a sprint may merge (`mergeSprintEpicWhenClean`). */
export async function mergeSprintEpicLanes(
  deps: RalphDeps,
  run: Pick<RalphRun, "id">,
): Promise<EpicMergeResult[]> {
  const lanes = (await listLanes(deps.db, run.id)).filter(
    (lane: RalphLane) => lane.prNumber !== null && !lane.prClosed,
  );
  const results: EpicMergeResult[] = [];
  for (const lane of lanes) results.push(await mergeSprintEpicWhenClean(deps, lane.id));
  return results;
}

/**
 * `mergeSprintEpicWhenClean` after a CI result, a finished job or review: logged, never thrown,
 * so a sprint never breaks the handler it follows.
 */
export async function mergeSprintEpicQuietly(deps: RalphDeps, laneId: string): Promise<void> {
  try {
    await mergeSprintEpicWhenClean(deps, laneId);
  } catch (error) {
    console.error(`Merging the sprint epic PR of ralph lane ${laneId} failed`, error);
  }
}
