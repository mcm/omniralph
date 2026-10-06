/**
 * Structured results of ralph's Claude sessions: the zod schemas, the JSON schemas passed to the
 * Agent SDK as `outputFormat`, and readers that validate and normalise a session's result.
 */
import { z } from "zod";

/** At most this many follow-up issues are filed from one story session. */
export const MAX_FOLLOW_UPS = 10;

export interface FollowUp {
  title: string;
  description: string;
  /** Work for a person: filed with the manual label so no agent attempts it. */
  manual?: boolean;
}

/** A JSON schema for `outputFormat`, from a zod schema. */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/** Why a structured result doesn't match its schema (or that there was none). */
function problemWith(error: z.ZodError | undefined): string {
  if (!error) return "no structured result";
  const issue = error.issues[0];
  return `invalid structured result: ${issue?.path.length ? `\`${issue.path.join(".")}\` ` : ""}${issue?.message ?? "doesn't match the schema"}`;
}

/** The structured result a story session must end with: it decides the story's outcome. */
export const StoryAgentOutput = z.object({
  status: z
    .enum(["complete", "blocked", "incomplete"])
    .describe(
      "complete: every acceptance criterion is met. blocked: a retry can't get past an obstacle. incomplete: unfinished; try again.",
    ),
  summary: z
    .string()
    .describe(
      "Posted to Linear: what you did, or precisely what is in the way and what would unblock it.",
    ),
  commit: z
    .object({
      summary: z.string().describe("One line describing the work in progress worth keeping."),
    })
    .optional()
    .describe("Blocked only: commit the work so far (if the checks pass) instead of stashing it."),
  appliedStashes: z
    .array(z.string())
    .optional()
    .describe("SHAs of the offered stash entries you applied with `git stash apply`."),
  followUps: z
    .array(
      z.object({
        title: z.string().describe("Short imperative title."),
        description: z
          .string()
          .describe(
            "What is wrong, where, and what done looks like (acceptance criteria as `- [ ]` checkboxes).",
          ),
        manual: z
          .boolean()
          .describe("True for work only a person can do (access, outside settings, a decision)."),
      }),
    )
    .describe(
      "Work outside this story's scope for the orchestrator to file as new stories. Empty when there is none.",
    ),
});
export type StoryAgentOutput = z.infer<typeof StoryAgentOutput>;

/** A story session's result after `readStoryOutcome`'s clean-up. */
export type StoryOutcome = Omit<StoryAgentOutput, "followUps"> & { followUps: FollowUp[] };

/** `outputFormat` schema of a story session. */
export const STORY_OUTPUT_SCHEMA = jsonSchema(StoryAgentOutput);

/**
 * A story session's structured result, with follow-ups trimmed, deduplicated by title and capped. A result
 * that is missing or doesn't match the schema gives the problem instead.
 */
export function readStoryOutcome(
  structured: unknown,
): { outcome: StoryOutcome } | { problem: string } {
  const parsed = structured === undefined ? undefined : StoryAgentOutput.safeParse(structured);
  if (!parsed?.success) return { problem: problemWith(parsed?.error) };
  const followUps: FollowUp[] = [];
  for (const f of parsed.data.followUps) {
    const title = f.title.replace(/\s+/g, " ").trim();
    if (!title || followUps.some((x) => x.title.toLowerCase() === title.toLowerCase())) continue;
    followUps.push({ title, description: f.description.trim(), ...(f.manual && { manual: true }) });
  }
  const commit = parsed.data.commit?.summary.trim()
    ? { summary: parsed.data.commit.summary.replace(/\s+/g, " ").trim() }
    : undefined;
  return { outcome: { ...parsed.data, commit, followUps: followUps.slice(0, MAX_FOLLOW_UPS) } };
}

/** The structured result of the session that writes a PR/MR title and description. */
export const DescribePrAgentOutput = z.object({
  title: z.string().describe("One line, imperative mood, at most ~70 characters."),
  body: z.string().describe("The markdown description."),
});
export type DescribePrAgentOutput = z.infer<typeof DescribePrAgentOutput>;

/** `outputFormat` schema of the session that writes a PR/MR title and description. */
export const PR_DESCRIPTION_SCHEMA = jsonSchema(DescribePrAgentOutput);

/** The title and description from a describe session's structured result, if it produced both. */
export function readPullRequestDescription(
  structured: unknown,
): { title: string; body: string } | undefined {
  const parsed = DescribePrAgentOutput.safeParse(structured);
  if (!parsed.success) return undefined;
  const title = parsed.data.title
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "");
  const body = parsed.data.body.trim();
  return title && body ? { title: title.slice(0, 200), body } : undefined;
}

/** The structured result a request session ends with (cyralph's `RequestResultSchema`). */
export const RequestAgentOutput = z.object({
  summary: z
    .string()
    .describe(
      "Posted to the Linear thread: what you did, with links (e.g. the pull/merge request URL).",
    ),
  pullRequest: z
    .object({
      action: z
        .enum(["open", "update", "ready"])
        .describe(
          "open: open the branch's pull/merge request as a draft. update: change the title/body of the open one. ready: mark it ready for review.",
        ),
      title: z.string().optional().describe("One line, at most ~70 characters (open, update)."),
      body: z.string().optional().describe("The markdown description (open, update)."),
    })
    .optional()
    .describe(
      "A change to the branch's pull/merge request for the orchestrator to make; push the branch first.",
    ),
});
export type RequestAgentOutput = z.infer<typeof RequestAgentOutput>;

/** `outputFormat` schema of a request session. */
export const REQUEST_OUTPUT_SCHEMA = jsonSchema(RequestAgentOutput);

/** A request session's result (summary trimmed), or the problem with it. */
export function readRequestResult(
  structured: unknown,
): { result: RequestAgentOutput } | { problem: string } {
  const parsed = structured === undefined ? undefined : RequestAgentOutput.safeParse(structured);
  if (!parsed?.success) return { problem: problemWith(parsed?.error) };
  const { pullRequest } = parsed.data;
  const title = pullRequest?.title?.replace(/\s+/g, " ").trim();
  const body = pullRequest?.body?.trim();
  return {
    result: {
      summary: parsed.data.summary.trim(),
      ...(pullRequest && {
        pullRequest: { action: pullRequest.action, ...(title && { title }), ...(body && { body }) },
      }),
    },
  };
}
