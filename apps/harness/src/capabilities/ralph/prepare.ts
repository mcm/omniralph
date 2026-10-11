import { preparationHash } from "@omniralph/ralph";
import { RalphPreparePayload, RalphPrepareResult, type JobPayload } from "@omniralph/shared";
import type { JobContext } from "../index.js";
import type { BranchWorktree } from "../../workspace/repoCache.js";
import { CommandError, runShell } from "../../workspace/git.js";
import { ActivityRelay } from "../../tools/activities.js";
import { sessionEnv, type StoryOptions } from "./story.js";

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
  payload: RalphPreparePayload,
): Promise<boolean> {
  if (payload.approvedHeadSha) return head === payload.approvedHeadSha;
  const ahead = await worktree
    .git(["rev-list", "--count", `refs/remotes/origin/${payload.baseBranch}..HEAD`])
    .catch(() => "");
  return ahead.trim() === "0";
}

/**
 * Runs the approved `cyralph-prepare` commands of a manual story (ported from
 * cyralph's `runApprovedPreparation`) in the epic's branch worktree. Nothing
 * runs when the worktree HEAD or the commands changed since the approval
 * (`stale`); otherwise the commands run one at a time with `bash -lc` and stop
 * at the first failure. The commands get the agent's environment without the
 * job token. The control panel posts the result; the story stays with a person.
 */
export async function runPrepare(
  job: JobPayload,
  ctx: JobContext,
  options: Pick<StoryOptions, "fetch"> = {},
): Promise<RalphPrepareResult> {
  const parsed = RalphPreparePayload.safeParse(job.payload);
  if (!parsed.success) throw new Error("invalid ralph.prepare payload");
  const payload = parsed.data;
  const started = Date.now();
  const log = ctx.logger.child({
    repo: `${payload.repository.provider}/${payload.repository.fullPath}`,
    branch: payload.branch,
    story: payload.story.identifier,
  });
  const relay = new ActivityRelay({
    server: ctx.server,
    jobId: job.id,
    jobToken: ctx.jobToken,
    logger: log,
    ...(options.fetch && { fetch: options.fetch }),
  });
  const env = ctx.env();
  const plainEnv = sessionEnv(env);

  try {
    return await ctx.repos.withBranchWorktree(
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
          status: RalphPrepareResult["status"],
          commands: RalphPrepareResult["commands"],
          headSha = head,
        ) =>
          RalphPrepareResult.parse({ status, commands, headSha, durationMs: Date.now() - started });

        if (
          preparationHash(payload.commands) !== payload.commandsHash ||
          !(await headMatches(worktree, head, payload))
        ) {
          log.info({ head, approved: payload.approvedHeadSha }, "preparation approval is stale");
          return result("stale", []);
        }

        const ran: RalphPrepareResult["commands"] = [];
        for (const command of payload.commands) {
          relay.post({ type: "action", body: "Prepare", parameter: command, ephemeral: true });
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
                : {
                    exitCode: null,
                    output: error instanceof Error ? error.message : String(error),
                  };
            ran.push({
              command,
              exitCode: failed.exitCode,
              output: tail(failed.output, MAX_OUTPUT),
            });
            log.info({ command, exitCode: failed.exitCode }, "preparation command failed");
            return result("failed", ran, await currentHead(worktree, head));
          }
        }
        log.info({ commands: ran.length }, "ran the preparation");
        return result("completed", ran, await currentHead(worktree, head));
      },
    );
  } finally {
    await relay.flush();
  }
}

/** HEAD after the commands (they may have committed), falling back to HEAD before. */
async function currentHead(worktree: BranchWorktree, before: string): Promise<string> {
  return (await worktree.git(["rev-parse", "HEAD"], { signal: null }).catch(() => before)).trim();
}
