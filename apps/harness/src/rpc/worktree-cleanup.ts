import {
  WORKTREE_CLEANUP_JOB_TYPE,
  WorktreeCleanupPayload,
  WorktreeCleanupResult,
  ralphStashBranch,
  ralphStashPrefix,
  type JobPayload,
} from "@omniralph/shared";
import { jobGitAccess } from "../capabilities/ralph/git-access.js";
import type { SystemRpc, SystemRpcContext } from "./index.js";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Cleanup after a ralph PR/MR merged (ported from cyralph's `cleanupMerged`
 * and `answerCleanup`), on the run's sticky harness, which holds the lane's
 * branch worktree. No Claude session:
 *
 * - `cleanup`: the worktree's uncommitted changes are stashed, the worktree
 *   is removed, and the local branch deleted unless it has commits the merged
 *   head doesn't. Returns the run's stash entries (and those recorded on the
 *   lane) still in the repository's stash list, for the stash question. Its
 *   keep-branch form (a PR/MR closed unmerged, a stopped run) keeps the local
 *   branch: a resumed run recreates the worktree from it.
 * - `stashes`: pushes the entries to `ralph/stash/<epic>` on `origin` (one
 *   commit each) and drops them, or just drops them.
 * - `branch`: pushes the kept branch to `origin` and deletes it, or deletes it.
 *
 * Nothing here deletes a branch on `origin`. A git failure is returned as
 * `error` (the control panel says so and the answer can be given again), not
 * thrown; a canceled job rejects.
 */
export async function cleanUpWorktree(
  payload: WorktreeCleanupPayload,
  ctx: Pick<SystemRpcContext, "signal" | "env" | "jobToken" | "server" | "repos" | "logger">,
): Promise<WorktreeCleanupResult> {
  const started = Date.now();
  const { repository, branch, action } = payload;
  const log = ctx.logger.child({
    repo: `${repository.provider}/${repository.fullPath}`,
    branch,
    action: action.kind,
  });
  // The job token comes from a file kept current, in case waiting for the repository's locks takes long.
  const access = await jobGitAccess(ctx);
  const git = { env: access.env, signal: ctx.signal };
  const result = (fields: Partial<WorktreeCleanupResult>) =>
    WorktreeCleanupResult.parse({ ...fields, durationMs: Date.now() - started });

  try {
    if (action.kind === "cleanup") {
      // Only the run's own branch, never the base branch the repository works on.
      if (branch === payload.baseBranch) {
        return result({ error: `\`${branch}\` is the base branch, so I left it alone` });
      }
      const prefix = ralphStashPrefix(payload.runId);
      const removed = await ctx.repos.cleanupBranchWorktree(repository, {
        ...git,
        branch,
        mergedSha: action.keepBranch ? null : (action.mergedSha ?? null),
        stashLabel: `${prefix}cleanup`,
      });
      const recorded = new Set([...action.stashes, ...(removed.stashed ? [removed.stashed] : [])]);
      const stashes = (await ctx.repos.listRepoStashes(repository, git)).filter(
        (e) => recorded.has(e.sha) || e.label.startsWith(prefix),
      );
      log.info(
        { ...removed, stashes: stashes.length, keepBranch: !!action.keepBranch },
        action.keepBranch ? "removed the worktree, kept the branch" : "cleaned up after the merge",
      );
      return result({ ...removed, stashes });
    }
    if (action.kind === "stashes") {
      const entries = (await ctx.repos.listRepoStashes(repository, git)).filter((e) =>
        action.shas.includes(e.sha),
      );
      if (action.push) {
        await ctx.repos.pushStashes(
          repository,
          ralphStashBranch(payload.epic.identifier),
          entries,
          git,
        );
      }
      const handled = await ctx.repos.dropRepoStashes(
        repository,
        entries.map((e) => e.sha),
        git,
      );
      log.info({ push: action.push, handled }, "handled leftover stashes");
      return result({ handled });
    }
    if (action.push) await ctx.repos.pushBranch(repository, branch, git);
    await ctx.repos.deleteBranch(repository, branch, git);
    log.info({ push: action.push }, "handled the kept branch");
    return result({});
  } catch (error) {
    ctx.signal.throwIfAborted();
    log.warn({ err: error }, "cleanup failed");
    return result({ error: errorText(error).slice(0, 20_000) });
  } finally {
    await access.close();
  }
}

/**
 * `worktree.cleanup` (targeted at the run's sticky harness) cleans up a merged
 * lane's branch worktree or carries out an answer to a cleanup question
 * (`cleanUpWorktree`). Its job token is the only system RPC token that may
 * push (stashes to `ralph/stash/<epic>`, a kept branch). The control panel
 * applies the result (`applyCleanupJob`).
 */
export const worktreeCleanupRpc: SystemRpc = {
  name: WORKTREE_CLEANUP_JOB_TYPE,
  async run(job: JobPayload, ctx) {
    const payload = WorktreeCleanupPayload.safeParse(job.payload);
    if (!payload.success) throw new Error("invalid worktree.cleanup payload");
    return cleanUpWorktree(payload.data, ctx);
  },
};
