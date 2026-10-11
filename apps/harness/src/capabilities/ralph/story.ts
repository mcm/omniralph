import { buildStoryPrompt, RALPH_SYSTEM_APPEND } from "@omniralph/ralph";
import {
  MAX_ATTEMPTS_PER_STORY,
  RalphStoryPayload,
  type JobPayload,
  type RalphStoryResult,
} from "@omniralph/shared";
import { withoutJobEnv } from "../../job-env.js";
import {
  DEFAULT_STORY_MODEL,
  promptEpic,
  runStoryAttempt,
  type StoryOptions,
} from "../../lifecycle/story-attempt.js";
import type { JobContext } from "../index.js";
import { RALPH_TOOL_POLICY } from "./policy.js";

export {
  DEFAULT_STORY_MODEL,
  promptEpic,
  stashPrefix,
  type StoryOptions,
} from "../../lifecycle/story-attempt.js";

/** The agent's environment minus `OMNIRALPH_*`: Claude sessions and gates never see the job token. */
export function sessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return withoutJobEnv(env);
}

/**
 * Runs a `ralph.story` job: one attempt at one story (`runStoryAttempt`), with
 * ralph's story prompt (`buildStoryPrompt`), system prompt and tool policy,
 * the repository's model and tool settings, and a session without any token.
 */
export async function runStory(
  job: JobPayload,
  ctx: JobContext,
  options: StoryOptions = {},
): Promise<RalphStoryResult> {
  const parsed = RalphStoryPayload.safeParse(job.payload);
  if (!parsed.success) throw new Error("invalid ralph.story payload");
  const payload = parsed.data;
  return runStoryAttempt({
    payload,
    jobId: job.id,
    ctx,
    options,
    session: (prepared) => {
      const { epic, story } = promptEpic(payload);
      const prompt = buildStoryPrompt({
        epic,
        story,
        progressFile: prepared.progressFile,
        progress: payload.progress,
        ...(payload.lastFeedback && { previousAttemptFeedback: payload.lastFeedback }),
        guidance: payload.guidance.slice(-10),
        attempt: payload.attempt,
        maxAttempts: MAX_ATTEMPTS_PER_STORY,
        followUps: payload.epic.kind !== "single",
        verifyCommands: payload.qualityGates,
        ...(payload.settings.appendInstruction && {
          appendInstruction: payload.settings.appendInstruction,
        }),
        stashes: prepared.offered,
        ...(prepared.attachments && { attachments: prepared.attachments }),
        ...(options.now && { now: options.now() }),
      });
      return {
        prompt,
        policy: RALPH_TOOL_POLICY,
        systemAppend: RALPH_SYSTEM_APPEND,
        model: payload.settings.model ?? DEFAULT_STORY_MODEL,
        ...(payload.settings.fallbackModel && { fallbackModel: payload.settings.fallbackModel }),
        tools: {
          allowedTools: payload.settings.allowedTools,
          disallowedTools: payload.settings.disallowedTools,
        },
        env: sessionEnv(ctx.env()),
        ...(options.idleTimeoutMs !== undefined && { idleTimeoutMs: options.idleTimeoutMs }),
      };
    },
  });
}
