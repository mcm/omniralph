/**
 * Forms of the control panel's Repository › Settings pages. The pages validate with these before submitting, and the server
 * actions validate again before saving.
 */
import { z } from "zod";
import { ReviewDepthSchema } from "./review-depth.js";

export const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 4000;
export const MAX_PATH_EXCLUDES = 200;
export const MAX_PATH_EXCLUDE_LENGTH = 500;
export const MAX_REVIEW_TASKS = 20;

const BRACKETS: Record<string, string> = { "{": "}", "(": ")" };
const MATCH_ALL = new Set(["*", "**", "**/*", "**/**", "/**", "/**/*", "/**/**"]);

/**
 * Why `pattern` isn't a usable path-exclude glob (gitignore-like, matched with
 * picomatch: a pattern without `/` matches at any depth, a leading `/` anchors
 * it to the repository root), or null when it is.
 */
export function pathExcludeGlobError(pattern: string): string | null {
  if (!pattern.trim()) return "Enter a glob pattern.";
  if (pattern !== pattern.trim()) return "Remove the leading or trailing spaces.";
  if (pattern.length > MAX_PATH_EXCLUDE_LENGTH) {
    return `Patterns can be at most ${MAX_PATH_EXCLUDE_LENGTH} characters.`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(pattern)) return "Patterns can't contain control characters.";
  if (pattern.startsWith("!")) return "Negated patterns (starting with !) aren't supported.";
  if (pattern.includes("***")) return "Use ** to match any number of directories.";
  if (MATCH_ALL.has(pattern)) return "This pattern would exclude every file.";

  const open: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\") {
      if (i === pattern.length - 1) return "The pattern ends with an unfinished escape (\\).";
      i++;
    } else if (char === "[") {
      // A character class: brackets inside it are literal.
      let end = i + 1;
      if (pattern[end] === "!" || pattern[end] === "^") end++;
      if (pattern[end] === "]") end++;
      while (end < pattern.length && pattern[end] !== "]") end += pattern[end] === "\\" ? 2 : 1;
      if (end >= pattern.length) return 'Missing a closing "]".';
      i = end;
    } else if (BRACKETS[char]) {
      open.push(BRACKETS[char]);
    } else if (char === "]") {
      return 'Unbalanced "]".';
    } else if (char === "}" || char === ")") {
      if (open.pop() !== char) return `Unbalanced "${char}".`;
    }
  }
  if (open.length > 0) return `Missing a closing "${open[open.length - 1]}".`;
  return null;
}

export const PathExcludeGlob = z.string().superRefine((pattern, ctx) => {
  const error = pathExcludeGlobError(pattern);
  if (error) ctx.addIssue({ code: "custom", message: error });
});

/** Splits the path-exclude textarea (one glob per line) into patterns, ignoring blank lines. */
export function parsePathExcludes(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** A playbook binding's value: a playbook ID (`builtin:<name>` or a UUID) the server resolves. */
const PlaybookId = (message: string) => z.string({ error: message }).min(1, message).max(200);

export const RepositorySettingsInput = z.object({
  /** The review depth (`repositories.review_depth`). */
  depth: ReviewDepthSchema,
  triggers: z.object({
    onOpen: z.boolean(),
    onPush: z.boolean(),
    /** Also review draft PRs/MRs (`includeDrafts`). */
    drafts: z.boolean(),
  }),
  pathExcludes: z
    .array(PathExcludeGlob)
    .max(MAX_PATH_EXCLUDES, `At most ${MAX_PATH_EXCLUDES} patterns.`),
  customInstructions: z
    .string()
    .max(
      MAX_CUSTOM_INSTRUCTIONS_LENGTH,
      `Custom instructions can be at most ${MAX_CUSTOM_INSTRUCTIONS_LENGTH.toLocaleString("en-US")} characters.`,
    ),
  /** Agents the repository is pinned to; empty means any agent. */
  pinnedHarnessIds: z.array(z.uuid()).max(100),
  /**
   * Review and review-summary playbooks each review run of the repository's PRs/MRs fans out
   * to, in order (`repositories.review_playbook_ids`); unchanged when left out. The server
   * checks each one's role.
   */
  reviewPlaybookIds: z
    .array(z.string().min(1).max(200))
    .min(1, "Choose at least one review playbook.")
    .max(MAX_REVIEW_TASKS, `At most ${MAX_REVIEW_TASKS} review playbooks.`)
    .refine((ids) => new Set(ids).size === ids.length, "Choose each review playbook once.")
    .optional(),
  /**
   * The correlation playbook that merges a review run's findings
   * (`repositories.correlation_playbook_id`); unchanged when left out.
   */
  correlationPlaybookId: PlaybookId("Choose a correlation playbook.").optional(),
  /** The story playbook of its story runs (`story_playbook_id`); unchanged when left out. */
  storyPlaybookId: PlaybookId("Choose a story playbook.").optional(),
  /** The request playbook of its request runs (`request_playbook_id`); unchanged when left out. */
  requestPlaybookId: PlaybookId("Choose a request playbook.").optional(),
});
export type RepositorySettingsInput = z.infer<typeof RepositorySettingsInput>;

const TaskTypeSwitch = z
  .boolean({ error: "Choose the organization's default, on or off." })
  .nullable();

/**
 * Which task types a repository runs (`repositories.query_enabled`, `enabled`, `ralph_enabled`):
 * each on, off, or null for the organization's default.
 */
export const RepositoryTaskTypesInput = z.object({
  /** Externally triggered query tasks (mentions, chat, triage). */
  query: TaskTypeSwitch,
  /** Reviews of its pull and merge requests. */
  review: TaskTypeSwitch,
  /** Coding (Linear delegations and requests). */
  coding: TaskTypeSwitch,
});
export type RepositoryTaskTypesInput = z.infer<typeof RepositoryTaskTypesInput>;

/** Most review or CI fix rounds a coding playbook may give a PR (`CODING_MAX_FIX_ROUNDS` in `@omniralph/tasks`). */
export const MAX_FIX_ROUNDS = 20;
/** Longest `codingInstructions` (text appended to every story and request prompt). */
export const MAX_CODING_INSTRUCTIONS_LENGTH = 10_000;
/**
 * Whether a repo's coding runs may rebase and `--force-with-lease` (`historyRewrite`):
 * only when a request asks for it, `always` (rebasing instead of ever merging
 * the base branch, without being asked) or `never`.
 */
export const RALPH_HISTORY_REWRITE_POLICIES = ["when-asked", "always", "never"] as const;
export type RalphHistoryRewrite = (typeof RALPH_HISTORY_REWRITE_POLICIES)[number];
/** Linear state types a playbook's `epicCompletedState` may name instead of a state name. */
export const RALPH_EPIC_STATE_TYPES = ["started", "completed"] as const;

/**
 * A repo's coding policy (`PUT /api/ui/repositories/{id}/coding`): the whole of it, and nothing
 * else (its work item match is saved on its own; models, commands and round limits are its
 * story and request playbooks').
 */
export const RepositoryCodingInput = z.strictObject({
  /** Whether work items routed to it are built (`repositories.ralph_enabled`). */
  codingEnabled: z.boolean({ error: "Choose on or off." }),
  /** Appended to every story and request prompt; empty or null for none. */
  codingInstructions: z
    .string()
    .max(
      MAX_CODING_INSTRUCTIONS_LENGTH,
      `Extra instructions can be at most ${MAX_CODING_INSTRUCTIONS_LENGTH.toLocaleString("en-US")} characters.`,
    )
    .nullable(),
  /** Open a draft PR after the first pushed story (updated and marked ready at the end). */
  openPullRequestEarly: z.boolean({ error: "Choose on or off." }),
  historyRewrite: z.enum(RALPH_HISTORY_REWRITE_POLICIES, { error: "Choose a policy." }),
  /** Fix review comments, `@bot` requests and failed CI on its runs' PRs. */
  respondToReviewsAndCi: z.boolean({ error: "Choose on or off." }),
});
export type RepositoryCodingInput = z.infer<typeof RepositoryCodingInput>;

/**
 * The Linear target of `epicCompletedState`: a state with that name, else
 * (for `started` or `completed`) the first state of that type.
 */
export function epicCompletedTarget(
  state: string | null | undefined,
): { name: string; type?: (typeof RALPH_EPIC_STATE_TYPES)[number] } | null {
  const value = state?.trim();
  if (!value) return null;
  const type = RALPH_EPIC_STATE_TYPES.find((t) => t === value.toLowerCase());
  return { name: value, ...(type && { type }) };
}

/** Splits a one-per-line textarea (commands, tool rules) into values, ignoring blank lines. */
export function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Field errors keyed by dotted path (`pathExcludes.2`, `triggers.onOpen`), first message per field. */
export type FieldErrors = Record<string, string>;

export function fieldErrors(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "form";
    errors[key] ??= issue.message;
  }
  return errors;
}
