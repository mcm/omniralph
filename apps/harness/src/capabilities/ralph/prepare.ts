import { RalphPreparePayload, type RalphPrepareResult, type JobPayload } from "@omniralph/shared";
import type { JobContext } from "../index.js";
import { runApprovedCommands } from "../../rpc/worktree-exec.js";
import { ActivityRelay } from "../../tools/activities.js";
import type { StoryOptions } from "./story.js";

/**
 * Runs a legacy `ralph.prepare` job: the approved `cyralph-prepare` commands of
 * a manual story (`runApprovedCommands`, which the `worktree.exec` system RPC
 * runs too), each posted as an ephemeral action. The control panel now
 * enqueues `worktree.exec` instead; this stays for jobs queued before that.
 */
export async function runPrepare(
  job: JobPayload,
  ctx: JobContext,
  options: Pick<StoryOptions, "fetch"> = {},
): Promise<RalphPrepareResult> {
  const parsed = RalphPreparePayload.safeParse(job.payload);
  if (!parsed.success) throw new Error("invalid ralph.prepare payload");
  const payload = parsed.data;
  const relay = new ActivityRelay({
    server: ctx.server,
    jobId: job.id,
    jobToken: ctx.jobToken,
    logger: ctx.logger,
    ...(options.fetch && { fetch: options.fetch }),
  });
  try {
    return await runApprovedCommands(payload, ctx, (command) =>
      relay.post({ type: "action", body: "Prepare", parameter: command, ephemeral: true }),
    );
  } finally {
    await relay.flush();
  }
}
