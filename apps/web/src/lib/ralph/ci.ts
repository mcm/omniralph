/**
 * Failed CI on ralph PRs/MRs (ported from cyralph's `SessionManager.pollCi`
 * and `onCiFailure`, `session-manager.ts:521-592`): when the CI of a ralph
 * lane's PR/MR head commit has finished and failed, the failed jobs and the
 * tails of their logs become a request on that lane, run as a `ralph.request`
 * job in the lane's branch worktree.
 *
 * - Triggers: GitHub `workflow_run` (completed) and GitLab `Pipeline Hook`
 *   webhooks (`respondToCiEvent`), and the ralph reconcile cron, which checks
 *   every open ralph PR/MR (`reconcileCi`).
 * - Skipped: repositories with `respondToReviewsAndCi` off, stopped (or failed)
 *   runs, and runs with an active job (it may push again; a later check
 *   catches up). A closed or merged PR/MR is recorded and left to cleanup.
 * - Only `failed` acts, once per head commit (`handled_ci_shas`), at most
 *   `maxFixRounds` times per PR/MR; after that the run says it's leaving it
 *   for a person.
 */
import {
  findLaneByBranch,
  findLaneByPullRequest,
  getLane,
  getRepositoryWithConnection,
  listActiveRunJobIds,
  listOpenPullRequestLanes,
  lockRun,
  updateLane,
  type RalphLane,
  type RalphRun,
  type RalphRunOrigin,
} from "@omniralph/db";
import { buildCiFailureRequest, type ChangeRequestWord } from "@omniralph/ralph";
import type { CiFailedJob, CiState } from "@omniralph/scm";
import { organizationPlaybooks } from "@/lib/playbooks";
import { roundLimits } from "./coding";
import { conversationFor } from "./conversation";
import { recordClosedPullRequest } from "./cleanup";
import { postActivity } from "./notify";
import { changeRequestTerm } from "./publish";
import {
  addLaneRequest,
  advanceQuietly,
  OVER,
  type PullRequestRequestDelivery,
} from "./pull-request-requests";
import type { RalphDeps } from "./run";

/** The most failed jobs whose logs are read (and listed) per failure. */
export const MAX_CI_JOBS = 5;

export type CiResponse =
  | {
      status: "ignored";
      reason: "not_ralph" | "repository_unavailable" | "opted_out" | "run_over" | "busy";
    }
  /** The PR/MR was closed or merged: recorded on the lane, left to cleanup. */
  | { status: "closed" }
  /** CI of the head commit hasn't failed (none, pending or passed). */
  | { status: "not_failed"; state: CiState }
  /** This head commit's failure was already seen. */
  | { status: "handled" }
  | { status: "round_limit"; rounds: number }
  | { status: PullRequestRequestDelivery; runId: string; jobs: number };

const ignored = (reason: Extract<CiResponse, { status: "ignored" }>["reason"]) =>
  ({ status: "ignored", reason }) as const;

/** `` `a`, `b`, `c` and N more `` */
function jobNames(jobs: readonly CiFailedJob[]): string {
  const names = jobs.map((j) => `\`${j.name}\``);
  return names.length > 3
    ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`
    : names.join(", ");
}

/**
 * Checks the CI of a ralph lane's PR/MR and acts on a failure (see the module
 * comment).
 */
export async function respondToCi(
  deps: RalphDeps,
  found: { lane: RalphLane; run: RalphRun },
  options: { busyRunIds?: ReadonlySet<string> } = {},
): Promise<CiResponse> {
  const prNumber = found.lane.prNumber;
  if (prNumber === null || found.lane.prClosed) return ignored("not_ralph");
  const target = await getRepositoryWithConnection(deps.db, found.lane.repositoryId);
  if (!target || target.repository.disconnectedAt || !target.repository.codingEnabled) {
    return ignored("repository_unavailable");
  }
  if (!target.repository.respondToReviewsAndCi) return ignored("opted_out");
  if (OVER.has(found.run.status)) return ignored("run_over");
  // Work on the run may push again: check its CI later. Decided by the caller
  // before acting on any of a run's lanes, so each of its PRs/MRs is checked.
  const busy = options.busyRunIds
    ? options.busyRunIds.has(found.run.id)
    : await runIsBusy(deps, found.run.id);
  if (busy) return ignored("busy");

  const { repository, connection } = target;
  const repo = { fullPath: repository.fullPath, externalId: repository.externalId };
  const adapter = deps.adapterFor(deps.db, connection);
  const state = await adapter.getChangeRequestState(repo, prNumber);
  if (state.state !== "open") {
    await recordClosedPullRequest(deps, found.lane, state);
    return { status: "closed" };
  }
  const ci = await adapter.getCiStatus(repo, prNumber);
  if (ci.state !== "failed") return { status: "not_failed", state: ci.state };
  if (found.lane.handledCiShas.includes(ci.headSha)) return { status: "handled" };

  const term = changeRequestTerm(repository.provider) as ChangeRequestWord;
  const sha = ci.headSha.slice(0, 7);
  const prUrl = found.lane.prUrl ?? "";
  const { maxFixRounds } = await roundLimits(
    found.run,
    repository,
    organizationPlaybooks(deps.db, found.run.organizationId),
  );
  const overLimit = found.lane.ciFixRounds >= maxFixRounds;
  // Read outside the run lock: the logs come from the code host.
  const jobs = overLimit
    ? []
    : await Promise.all(
        ci.failedJobs.slice(0, MAX_CI_JOBS).map(async (job) => ({
          name: job.name,
          url: job.url,
          log: job.noLog
            ? ""
            : await adapter.getCiJobLog(repo, job.id).catch((error: unknown) => {
                console.warn(
                  `Couldn't read the log of ${job.name} on ${repository.fullPath}#${prNumber}`,
                  error,
                );
                return "";
              }),
        })),
      );

  const outcome = await lockRun(deps.db, found.run.id, async (tx, run): Promise<CiResponse> => {
    const lane = await getLane(tx, found.lane.id);
    if (!lane || lane.prClosed) return ignored("not_ralph");
    if (OVER.has(run.status)) return ignored("run_over");
    if (lane.handledCiShas.includes(ci.headSha)) return { status: "handled" };
    const handledCiShas = [...lane.handledCiShas, ci.headSha];
    const rounds = lane.ciFixRounds;
    if (rounds >= maxFixRounds) {
      await updateLane(tx, lane.id, { handledCiShas });
      const active = (await listActiveRunJobIds(tx, run.id)).length > 0;
      await postActivity(
        conversationFor(run, deps),
        {
          type: active ? "thought" : "response",
          body: `CI failed again on ${prUrl} (\`${sha}\`). I've already tried to fix CI ${rounds} time${rounds === 1 ? "" : "s"} on this ${term}, so I'm leaving this one for a person.`,
        },
        { notice: true },
      );
      return { status: "round_limit", rounds };
    }
    const allJobs = [
      ...jobs,
      ...ci.failedJobs.slice(MAX_CI_JOBS).map((j) => ({ name: j.name, url: j.url, log: "" })),
    ];
    const added = await addLaneRequest(tx, run, lane, {
      text: buildCiFailureRequest({
        prNumber,
        prUrl,
        headSha: ci.headSha,
        branch: lane.branch,
        jobs: allJobs,
        term,
      }),
      author: null,
      what: `CI failed on the ${term}`,
      trigger: "pr.ci-failed",
    });
    if (!added) return ignored("run_over");
    await updateLane(tx, lane.id, { handledCiShas, ciFixRounds: rounds + 1 });
    await postActivity(
      conversationFor(run, deps),
      {
        type: "thought",
        body: `CI failed on the ${term} (\`${sha}\`: ${jobNames(ci.failedJobs)}). Working on a fix.`,
      },
      { notice: true },
    );
    return { status: added.delivery, runId: run.id, jobs: ci.failedJobs.length };
  });
  if (!outcome) return ignored("not_ralph");
  if (outcome.status === "started") await advanceQuietly(deps, outcome.runId);
  return outcome;
}

const runIsBusy = async (deps: Pick<RalphDeps, "db">, runId: string) =>
  (await listActiveRunJobIds(deps.db, runId)).length > 0;

/** The runs of these lanes that have an active job. */
async function busyRuns(
  deps: Pick<RalphDeps, "db">,
  lanes: Iterable<{ run: RalphRun }>,
): Promise<Set<string>> {
  const busy = new Set<string>();
  for (const { run } of lanes) {
    if (!busy.has(run.id) && (await runIsBusy(deps, run.id))) busy.add(run.id);
  }
  return busy;
}

/** A CI webhook delivery: the PRs/MRs it names, or the branch it ran on. */
export interface CiEventTarget {
  prNumbers: number[];
  branch: string | null;
}

/**
 * Acts on a finished CI run reported by a webhook: the ralph lanes of the
 * PRs/MRs it names (else the open ralph PR/MR of its branch). Returns one
 * response per lane; none when it isn't a ralph PR/MR.
 */
export async function respondToCiEvent(
  deps: RalphDeps,
  repositoryId: string,
  event: CiEventTarget,
): Promise<CiResponse[]> {
  const lanes = new Map<string, { lane: RalphLane; run: RalphRun }>();
  for (const number of event.prNumbers) {
    const found = await findLaneByPullRequest(deps.db, repositoryId, number);
    if (found) lanes.set(found.lane.id, found);
  }
  if (event.prNumbers.length === 0 && event.branch) {
    const found = await findLaneByBranch(deps.db, repositoryId, event.branch);
    if (found) lanes.set(found.lane.id, found);
  }
  const busyRunIds = await busyRuns(deps, lanes.values());
  const responses: CiResponse[] = [];
  for (const found of lanes.values()) {
    responses.push(await respondToCi(deps, found, { busyRunIds }));
  }
  return responses;
}

/**
 * The reconcile cron's CI check of every open ralph PR/MR of the organization (the fallback for
 * lost or missing webhooks). Only runs of `origin` when given. Failures are logged and counted.
 */
export async function reconcileCi(
  deps: RalphDeps,
  origin?: RalphRunOrigin,
): Promise<{ checked: number; failed: number }> {
  const lanes = await listOpenPullRequestLanes(deps.db, deps.organizationId, origin);
  const busyRunIds = await busyRuns(deps, lanes);
  let failed = 0;
  for (const found of lanes) {
    try {
      await respondToCi(deps, found, { busyRunIds });
    } catch (error) {
      failed += 1;
      console.error(`Checking the CI of ralph lane ${found.lane.id} failed`, error);
    }
  }
  return { checked: lanes.length - failed, failed };
}
