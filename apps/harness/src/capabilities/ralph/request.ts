import { buildRequestPrompt, requestSystemAppend } from "@omniralph/ralph";
import { RalphRequestPayload, type JobPayload, type RalphRequestResult } from "@omniralph/shared";
import { requestEpic, runRequestAttempt } from "../../lifecycle/request-attempt.js";
import type { JobContext } from "../index.js";
import { PermissionRelay } from "../../tools/permissions.js";
import { RALPH_TOOL_POLICY } from "./policy.js";
import { sessionGitAccess } from "./git-access.js";
import { DEFAULT_STORY_MODEL, type StoryOptions } from "./story.js";

export { requestEpic, requestStashPrefix } from "../../lifecycle/request-attempt.js";

/**
 * Runs a `ralph.request` job: one request session (`runRequestAttempt`) with
 * ralph's request prompt (`buildRequestPrompt`), the request system prompt
 * (which follows the repository's `historyRewrite`), ralph's tool policy and
 * the repository's model and tool settings. The session may commit and push
 * the branch itself (git authenticates through the brokered helper, see
 * `sessionGitAccess`). Calls the repository's Claude Code settings `ask`
 * about are relayed to the Linear thread (`PermissionRelay`).
 */
export async function runRequest(
  job: JobPayload,
  ctx: JobContext,
  options: StoryOptions = {},
): Promise<RalphRequestResult> {
  const parsed = RalphRequestPayload.safeParse(job.payload);
  if (!parsed.success) throw new Error("invalid ralph.request payload");
  const payload = parsed.data;
  const permissions = new PermissionRelay({
    server: ctx.server,
    jobId: job.id,
    jobToken: ctx.jobToken,
    logger: ctx.logger,
    ...(options.fetch && { fetch: options.fetch }),
    ...(options.permissionTimeoutMs !== undefined && {
      timeoutMs: options.permissionTimeoutMs,
    }),
    ...(options.permissionPollIntervalMs !== undefined && {
      pollIntervalMs: options.permissionPollIntervalMs,
    }),
  });
  // The session fetches and pushes the branch itself, through the brokered helper.
  const git = await sessionGitAccess(ctx);
  try {
    return await runRequestAttempt({
      payload,
      jobId: job.id,
      ctx,
      options,
      gitEnv: ctx.env(),
      session: (prepared) => ({
        prompt: buildRequestPrompt({
          epic: requestEpic(payload),
          requests: payload.requests.map((r) => r.text),
          source: payload.source,
          branch: payload.branch,
          baseBranch: payload.baseBranch,
          remoteUrl: payload.repository.cloneUrl,
          ...(payload.prUrl && { prUrl: payload.prUrl }),
          progressFile: prepared.progressFile,
          qualityGates: payload.qualityGates,
          prTerm: payload.repository.provider === "gitlab" ? "merge request" : "pull request",
          historyRewrite: payload.historyRewrite,
          ...(prepared.attachments && { attachments: prepared.attachments }),
          ...(payload.settings.appendInstruction && {
            appendInstruction: payload.settings.appendInstruction,
          }),
          ...(payload.ship && { ship: { stashes: prepared.shipStashes } }),
        }),
        policy: RALPH_TOOL_POLICY,
        systemAppend: requestSystemAppend(payload.historyRewrite, payload.source, {
          ship: payload.ship,
        }),
        model: payload.settings.model ?? DEFAULT_STORY_MODEL,
        ...(payload.settings.fallbackModel && {
          fallbackModel: payload.settings.fallbackModel,
        }),
        tools: {
          allowedTools: payload.settings.allowedTools,
          disallowedTools: payload.settings.disallowedTools,
        },
        env: git.env,
        ...(options.idleTimeoutMs !== undefined && { idleTimeoutMs: options.idleTimeoutMs }),
        // The repository's Claude Code settings may `ask` about calls (e.g. `git commit`).
        askPermission: (call, signal) => permissions.ask(call, signal),
      }),
    });
  } finally {
    await git.close();
  }
}
