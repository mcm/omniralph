import {
  RalphCleanupPayload,
  RalphCleanupResult,
  ralphStashBranch,
  ralphStashPrefix,
  type JobPayload,
} from "@omniralph/shared";
import type { JobContext } from "../index.js";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Cleanup after a ralph PR/MR merged (ported from cyralph's `cleanupMerged`
 * and `answerCleanup`), on the run's sticky agent, which holds the lane's
 * branch worktree. No Claude session:
 *
 * - `cleanup`: the worktree's uncommitted changes are stashed, the worktree
 *   is removed, and the local branch deleted unless it has commits the merged
 *   head doesn't. Returns the run's stash entries (and those recorded on the
 *   lane) still in the repository's stash list, for the stash question.
 * - `stashes`: pushes the entries to `ralph/stash/<epic>` on `origin` (one
 *   commit each) and drops them, or just drops them.
 * - `branch`: pushes the kept branch to `origin` and deletes it, or deletes it.
 *
 * A git failure is returned as `error` (the control panel says so and the
 * answer can be given again), not thrown; a canceled job rejects.
 */
export async function runCleanup(job: JobPayload, ctx: JobContext): Promise<RalphCleanupResult> {
  const parsed = RalphCleanupPayload.safeParse(job.payload);
  if (!parsed.success) throw new Error("invalid ralph.cleanup payload");
  const payload = parsed.data;
  const started = Date.now();
  const { repository, branch, action } = payload;
  const log = ctx.logger.child({
    repo: `${repository.provider}/${repository.fullPath}`,
    branch,
    action: action.kind,
  });
  const git = { env: ctx.env(), signal: ctx.signal };
  const result = (fields: Partial<RalphCleanupResult>) =>
    RalphCleanupResult.parse({ ...fields, durationMs: Date.now() - started });

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
        mergedSha: action.mergedSha,
        stashLabel: `${prefix}cleanup`,
      });
      const recorded = new Set([...action.stashes, ...(removed.stashed ? [removed.stashed] : [])]);
      const stashes = (await ctx.repos.listRepoStashes(repository, git)).filter(
        (e) => recorded.has(e.sha) || e.label.startsWith(prefix),
      );
      log.info({ ...removed, stashes: stashes.length }, "cleaned up after the merge");
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
  }
}
