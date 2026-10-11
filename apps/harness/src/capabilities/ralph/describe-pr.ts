import {
  buildDescribePrPrompt,
  PR_DESCRIPTION_SCHEMA,
  PR_DESCRIPTION_SYSTEM_APPEND,
  readPullRequestDescription,
  type Epic,
} from "@omniralph/ralph";
import {
  MAX_LEASE_SECONDS,
  MAX_PULL_REQUEST_TITLE_LENGTH,
  RalphDescribePrPayload,
  RalphDescribePrResult,
  type JobPayload,
} from "@omniralph/shared";
import { RetryableJobError, type JobContext } from "../index.js";
import { ActivityRelay } from "../../tools/activities.js";
import { RALPH_DESCRIBE_PR_TOOL_POLICY } from "./policy.js";
import { createSessionRunner } from "./session.js";
import { DEFAULT_STORY_MODEL, sessionEnv, type StoryOptions } from "./story.js";

/** Longest PR/MR body returned (`RalphDescribePrResult`). */
const MAX_BODY = 60_000;

/** A title within `max` characters, cut at a word boundary when it's longer. */
export function fitTitle(title: string, max = MAX_PULL_REQUEST_TITLE_LENGTH): string {
  const line = title.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

function tail(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/** The epic `buildDescribePrPrompt` expects, from the job's payload. */
export function describeEpic(payload: RalphDescribePrPayload): Epic {
  return {
    kind: "children",
    issueId: "",
    identifier: payload.epic.identifier,
    title: payload.epic.title,
    description: payload.epic.prd,
    ...(payload.epic.url && { url: payload.epic.url }),
    branchName: payload.branch,
    qualityGates: payload.qualityGates,
    stories: [],
  };
}

/**
 * Writes the title and body of a finished run's PR/MR (ported from cyralph's
 * `describePullRequest`): a read-only Claude session in the epic's branch
 * worktree (Read/Grep/Glob and read-only git commands) studies the branch
 * against its base and reports them as a structured result. The control
 * panel opens or updates the PR/MR with them; this job never touches the code
 * host. A session without a valid title and body fails the job; a Claude rate
 * limit throws `RetryableJobError`.
 */
export async function runDescribePr(
  job: JobPayload,
  ctx: JobContext,
  options: StoryOptions = {},
): Promise<RalphDescribePrResult> {
  const parsed = RalphDescribePrPayload.safeParse(job.payload);
  if (!parsed.success) throw new Error("invalid ralph.describe-pr payload");
  const payload = parsed.data;
  const log = ctx.logger.child({
    repo: `${payload.repository.provider}/${payload.repository.fullPath}`,
    branch: payload.branch,
  });
  const relay = new ActivityRelay({
    server: ctx.server,
    jobId: job.id,
    jobToken: ctx.jobToken,
    logger: log,
    ...(options.fetch && { fetch: options.fetch }),
  });
  const runSession = options.runSession ?? createSessionRunner();
  const env = ctx.env();
  const prTerm = payload.repository.provider === "gitlab" ? "merge request" : "pull request";

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
        relay.post({
          type: "thought",
          body: `Writing the ${prTerm} title and description.`,
          ephemeral: false,
        });
        const session = await runSession({
          prompt: buildDescribePrPrompt({
            epic: describeEpic(payload),
            branch: payload.branch,
            baseBranch: payload.baseBranch,
            prTerm,
            progress: payload.progress,
            stories: payload.stories,
          }),
          cwd: worktree.path,
          policy: RALPH_DESCRIBE_PR_TOOL_POLICY,
          systemAppend: PR_DESCRIPTION_SYSTEM_APPEND,
          outputSchema: PR_DESCRIPTION_SCHEMA,
          model: payload.settings.model ?? DEFAULT_STORY_MODEL,
          ...(payload.settings.fallbackModel && { fallbackModel: payload.settings.fallbackModel }),
          env: sessionEnv(env),
          signal: ctx.signal,
          ...(options.idleTimeoutMs !== undefined && { idleTimeoutMs: options.idleTimeoutMs }),
          onEvent: (event) => relay.event(event),
        });

        if (session.stop === "aborted" || ctx.signal.aborted) {
          throw ctx.signal.reason ?? new Error("the describe session was aborted");
        }
        if (session.stop === "rate_limited") {
          const seconds =
            session.retryAfterMs !== undefined
              ? Math.ceil(session.retryAfterMs / 1000)
              : (options.defaultRetryAfterSeconds ?? 300);
          throw new RetryableJobError(
            session.error ?? "Claude rate limit",
            Math.min(Math.max(seconds, 1), MAX_LEASE_SECONDS),
          );
        }
        if (session.stop !== "completed") {
          throw new Error(
            `The ${prTerm} description session ${session.stop === "idle" ? "was stopped" : "failed"}: ${session.error ?? "unknown error"}`,
          );
        }
        const text = readPullRequestDescription(session.structured);
        if (!text) {
          throw new Error(
            `The ${prTerm} description session ended without a valid title and body. Its final message was: ${tail(session.output, 1000) || "(none)"}`,
          );
        }
        log.info({ title: text.title }, "described the branch");
        return RalphDescribePrResult.parse({
          title: fitTitle(text.title),
          body: text.body.length > MAX_BODY ? `${text.body.slice(0, MAX_BODY - 1)}…` : text.body,
          usage: session.usage,
        });
      },
    );
  } finally {
    await relay.flush();
  }
}
