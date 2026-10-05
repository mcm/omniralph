/**
 * Forms of the control panel's Repository › Settings and Settings › Profiles
 * pages. The pages validate with these before submitting, and the server
 * actions validate again before saving.
 */
import { z } from "zod";

export const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 4000;
export const MIN_PROFILE_TOKEN_CAP = 5000;
export const MAX_PATH_EXCLUDES = 200;
export const MAX_PATH_EXCLUDE_LENGTH = 500;
export const BUILT_IN_PROFILE_IDS = ["quick", "standard", "deep"] as const;

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

export const RepositorySettingsInput = z.object({
  profileId: z.enum(BUILT_IN_PROFILE_IDS, { error: "Choose a profile." }),
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
  pinnedAgentIds: z.array(z.uuid()).max(100),
});
export type RepositorySettingsInput = z.infer<typeof RepositorySettingsInput>;

export const ReviewProfileInput = z.object({
  model: z
    .string()
    .trim()
    .min(1, "Enter a model.")
    .max(200, "Model names can be at most 200 characters.")
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/,
      "Enter a Claude model ID, e.g. claude-sonnet-5-5.",
    ),
  maxTokensPerReview: z
    .int("Enter a whole number.")
    .min(
      MIN_PROFILE_TOKEN_CAP,
      `The token cap must be at least ${MIN_PROFILE_TOKEN_CAP.toLocaleString("en-US")}.`,
    )
    .max(10_000_000, "The token cap can be at most 10,000,000."),
  maxFiles: z
    .int("Enter a whole number.")
    .min(1, "Max files must be at least 1.")
    .max(10_000, "Max files can be at most 10,000."),
  allowRepoExploration: z.boolean(),
});
export type ReviewProfileInput = z.infer<typeof ReviewProfileInput>;

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
