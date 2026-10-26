import { preparationHash } from "@omniralph/ralph";
import {
  WORKTREE_EXEC_JOB_TYPE,
  WorktreeExecPayload,
  WorktreeExecResult,
  type JobPayload,
} from "@omniralph/shared";
import { withoutJobEnv } from "../job-env.js";
import type { BranchWorktree } from "../workspace/repoCache.js";
import { CommandError, runShell } from "../workspace/git.js";
import type { SystemRpc, SystemRpcContext } from "./index.js";

/** Longest output (tail) returned per command. */
const MAX_OUTPUT = 4000;

function tail(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/**
 * Whether the worktree is where the approval was given: HEAD is the approved
 * SHA or, when nothing was committed when it was approved, HEAD has no commits
 * on top of `origin/<base>`.
 */
async function headMatches(
  worktree: BranchWorktree,
  head: string,
  payload: WorktreeExecPayload,
): Promise<boolean> {
  if (payload.approvedHeadSha) return head === payload.approvedHeadSha;
  const ahead = await worktree
    .git(["rev-list", "--count", `refs/remotes/origin/${payload.baseBranch}..HEAD`])
    .catch(() => "");
  return ahead.trim() === "0";
}

/**
 * Runs approved commands (a manual story's `cyralph-prepare` commands, ported
 * from cyralph's `runApprovedPreparation`) in the lane's branch worktree.
 * Nothing runs when the worktree HEAD or the commands changed since the
 * approval (`stale`); otherwise the commands run one at a time with `bash -lc`
 * and stop at the first failure. The commands get the agent's environment
 * without the job token, so no git credential. `onCommand` is told about each
 * command before it runs.
 */
export async function runApprovedCommands(
  payload: WorktreeExecPayload,
  ctx: Pick<SystemRpcContext, "signal" | "env" | "repos" | "logger">,
  onCommand?: (command: string) => void,
): Promise<WorktreeExecResult> {
  const started = Date.now();
  const log = ctx.logger.child({
    repo: `${payload.repository.provider}/${payload.repository.fullPath}`,
    branch: payload.branch,
    story: payload.story.identifier,
  });
  const env = ctx.env();
  const plainEnv = withoutJobEnv(env);

  return ctx.repos.withBranchWorktree(
    payload.repository,
    {
      branch: payload.branch,
      baseBranch: payload.baseBranch,
      ...(payload.settings.setupCommand && { setupCommand: payload.settings.setupCommand }),
      env,
      signal: ctx.signal,
    },
    async (worktree) => {
      const head = (await worktree.git(["rev-parse", "HEAD"])).trim();
      const result = (
        status: WorktreeExecResult["status"],
        commands: WorktreeExecResult["commands"],
        headSha = head,
      ) =>
        WorktreeExecResult.parse({ status, commands, headSha, durationMs: Date.now() - started });

      if (
        preparationHash(payload.commands) !== payload.commandsHash ||
        !(await headMatches(worktree, head, payload))
      ) {
        log.info({ head, approved: payload.approvedHeadSha }, "approval of the commands is stale");
        return result("stale", []);
      }

      const ran: WorktreeExecResult["commands"] = [];
      for (const command of payload.commands) {
        onCommand?.(command);
        try {
          const output = await runShell(command, {
            cwd: worktree.path,
            env: plainEnv,
            signal: ctx.signal,
            mergeOutput: true,
          });
          ran.push({ command, exitCode: 0, output: tail(output, MAX_OUTPUT) });
        } catch (error) {
          ctx.signal.throwIfAborted();
          const failed =
            error instanceof CommandError
              ? { exitCode: error.exitCode, output: error.output }
              : { exitCode: null, output: error instanceof Error ? error.message : String(error) };
          ran.push({ command, exitCode: failed.exitCode, output: tail(failed.output, MAX_OUTPUT) });
          log.info({ command, exitCode: failed.exitCode }, "approved command failed");
          return result("failed", ran, await currentHead(worktree, head));
        }
      }
      log.info({ commands: ran.length }, "ran the approved commands");
      return result("completed", ran, await currentHead(worktree, head));
    },
  );
}

/** HEAD after the commands (they may have committed), falling back to HEAD before. */
async function currentHead(worktree: BranchWorktree, before: string): Promise<string> {
  return (await worktree.git(["rev-parse", "HEAD"], { signal: null }).catch(() => before)).trim();
}

/**
 * `worktree.exec` (targeted at the run's sticky agent) runs a manual story's
 * approved commands in its lane's branch worktree (`runApprovedCommands`). The
 * job token only reads the repository (to fetch the branch); the commands get
 * no token. The control panel applies the result (`applyPreparationJob`).
 */
export const worktreeExecRpc: SystemRpc = {
  name: WORKTREE_EXEC_JOB_TYPE,
  async run(job: JobPayload, ctx) {
    const payload = WorktreeExecPayload.safeParse(job.payload);
    if (!payload.success) throw new Error("invalid worktree.exec payload");
    return runApprovedCommands(payload.data, ctx);
  },
};
