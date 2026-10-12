/**
 * Deleting runs' hidden refs (`refs/omniralph/runs/<run>`, where a run whose
 * story task pushes only at the end keeps its story commits) on the code
 * host once they're no longer needed, so they don't pile up there.
 *
 * - Story outcomes record the ref they pushed (`recordStoryHiddenRef`).
 * - A run that completes or fails (`advanceRun`) gets its refs deleted at once
 *   (`deleteRunHiddenRefs`). A stopped run may resume from its ref: only the
 *   age sweep deletes it.
 * - The `prune-hidden-refs` cron (`pruneHiddenRefs`) sweeps refs of ended
 *   runs that were missed, and those older than `HIDDEN_REF_MAX_AGE_DAYS`
 *   whose run isn't running.
 *
 * GitLab's API can't delete custom refs, so a harness deletes them with git:
 * a `worktree.cleanup` system RPC with only `hiddenRefs` (any harness that
 * takes system RPCs; its lifecycle token may push). Its outcome marks the
 * refs it reports deleted (`applyHiddenRefsJob`).
 */
import {
  getLaneByRepository,
  getMainLane,
  getRepositoryWithConnection,
  listHiddenRefsToDelete,
  listRunHiddenRefs,
  markHiddenRefsDeleted,
  recordHiddenRef,
  runReference,
  type Database,
  type Job,
  type RalphRun,
  type RalphTransaction,
} from "@omniralph/db";
import {
  legacyJobRouting,
  MAX_CLEANUP_HIDDEN_REFS,
  ralphHiddenRef,
  WORKTREE_CLEANUP_JOB_TYPE,
  WorktreeCleanupPayload,
  WorktreeCleanupResult,
  type RalphStoryResult,
} from "@omniralph/shared";
import { jobRepository } from "@/lib/scm/adapters";
import { errorMessage } from "./notify";
import { jobSettings } from "./payload";
import type { RalphDeps } from "./run";

/** Hidden refs older than this are deleted unless their run is running. */
export const HIDDEN_REF_MAX_AGE_DAYS = 14;

type HiddenRefDeps = Pick<RalphDeps, "db" | "dispatcher">;

/** At most one deletion of a run's hidden refs per repository at a time. */
export function hiddenRefsDedupeKey(runId: string, repositoryId: string): string {
  return `ralph-hidden-refs:${runId}:${repositoryId}`;
}

/** Records the hidden ref a story outcome reports, when it's the run's own. */
export async function recordStoryHiddenRef(
  tx: RalphTransaction,
  run: Pick<RalphRun, "id">,
  repositoryId: string,
  result: Pick<RalphStoryResult, "hiddenRef">,
): Promise<void> {
  const reported = result.hiddenRef;
  if (!reported) return;
  if (reported.ref !== ralphHiddenRef(run.id)) {
    console.warn(`Ignoring hidden ref ${reported.ref} reported by a story of ralph run ${run.id}`);
    return;
  }
  await recordHiddenRef(tx, { repositoryId, runId: run.id, ref: reported.ref, sha: reported.sha });
}

/**
 * Enqueues a `worktree.cleanup` RPC deleting `refs` of the run in a
 * repository, on any harness. Null when the repository is gone or
 * disconnected (the sweep tries again).
 */
export async function enqueueHiddenRefDeletion(
  deps: HiddenRefDeps,
  run: RalphRun,
  repositoryId: string,
  refs: readonly string[],
): Promise<{ jobId: string } | { why: string }> {
  const found = await getRepositoryWithConnection(deps.db, repositoryId);
  if (!found || found.repository.disconnectedAt) {
    return { why: "the repository is no longer connected" };
  }
  const lane =
    (await getLaneByRepository(deps.db, run.id, repositoryId)) ?? (await getMainLane(deps.db, run));
  if (!lane) return { why: "the run has no branch" };
  const { repository, connection } = found;
  const payload = WorktreeCleanupPayload.parse({
    runId: run.id,
    repositoryId: repository.id,
    repository: jobRepository(repository, connection),
    branch: lane.branch,
    baseBranch: lane.baseBranch,
    settings: jobSettings(repository),
    epic: { identifier: runReference(run) },
    hiddenRefs: refs.slice(0, MAX_CLEANUP_HIDDEN_REFS),
  });
  const { job } = await deps.dispatcher.createAndPublish({
    organizationId: run.organizationId,
    type: WORKTREE_CLEANUP_JOB_TYPE,
    ...legacyJobRouting(WORKTREE_CLEANUP_JOB_TYPE),
    payload,
    repositoryId: repository.id,
    ralphRunId: run.id,
    dedupeKey: hiddenRefsDedupeKey(run.id, repository.id),
  });
  return { jobId: job.id };
}

/** Groups hidden refs by repository. */
function byRepository(rows: ReadonlyArray<{ repositoryId: string; ref: string }>) {
  const groups = new Map<string, string[]>();
  for (const row of rows)
    groups.set(row.repositoryId, [...(groups.get(row.repositoryId) ?? []), row.ref]);
  return groups;
}

/**
 * A run completed or failed: its undeleted hidden refs are deleted (one RPC
 * per repository). Failures are logged: the cron sweeps what's left.
 */
export async function deleteRunHiddenRefs(deps: HiddenRefDeps, run: RalphRun): Promise<number> {
  let enqueued = 0;
  try {
    for (const [repositoryId, refs] of byRepository(await listRunHiddenRefs(deps.db, run.id))) {
      const result = await enqueueHiddenRefDeletion(deps, run, repositoryId, refs);
      if ("why" in result) {
        console.warn(`Not deleting the hidden refs of ralph run ${run.id}: ${result.why}`);
      } else enqueued += 1;
    }
  } catch (error) {
    console.error(`Deleting the hidden refs of ralph run ${run.id} failed: ${errorMessage(error)}`);
  }
  return enqueued;
}

/**
 * The `prune-hidden-refs` cron: enqueues the deletion of undeleted hidden
 * refs whose run is completed or failed, or that are older than
 * `HIDDEN_REF_MAX_AGE_DAYS` and whose run isn't running. A deletion already
 * under way isn't enqueued again (its dedupe key).
 */
export async function pruneHiddenRefs(
  deps: HiddenRefDeps,
  now = new Date(),
): Promise<{ refs: number; enqueued: number; failed: number }> {
  const olderThan = new Date(now.getTime() - HIDDEN_REF_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  const rows = await listHiddenRefsToDelete(deps.db, olderThan);
  const groups = new Map<string, { run: RalphRun; repositoryId: string; refs: string[] }>();
  for (const { hiddenRef, run } of rows) {
    const key = `${run.id}:${hiddenRef.repositoryId}`;
    const group = groups.get(key) ?? { run, repositoryId: hiddenRef.repositoryId, refs: [] };
    group.refs.push(hiddenRef.ref);
    groups.set(key, group);
  }
  const counts = { refs: rows.length, enqueued: 0, failed: 0 };
  for (const { run, repositoryId, refs } of groups.values()) {
    try {
      const result = await enqueueHiddenRefDeletion(deps, run, repositoryId, refs);
      if ("why" in result) {
        counts.failed += 1;
        console.warn(`Not deleting the hidden refs of ralph run ${run.id}: ${result.why}`);
      } else counts.enqueued += 1;
    } catch (error) {
      counts.failed += 1;
      console.error(
        `Deleting the hidden refs of ralph run ${run.id} failed: ${errorMessage(error)}`,
      );
    }
  }
  return counts;
}

/**
 * A `worktree.cleanup` job with `hiddenRefs` finished: the refs its result
 * reports deleted (of those it was given) are marked deleted. Others stay for
 * the sweep. Returns how many were marked.
 */
export async function applyHiddenRefsJob(db: Database, job: Job): Promise<number> {
  if (job.status !== "completed") return 0;
  const payload = WorktreeCleanupPayload.safeParse(job.payload);
  const given = payload.success ? (payload.data.hiddenRefs ?? []) : [];
  if (!payload.success || given.length === 0) return 0;
  const result = WorktreeCleanupResult.safeParse(job.result);
  if (!result.success) return 0;
  const deleted = result.data.deletedRefs.filter((ref) => given.includes(ref));
  return markHiddenRefsDeleted(db, payload.data.repositoryId, deleted);
}
