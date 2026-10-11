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
export const MAX_REVIEW_TASKS = 20;
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
  pinnedHarnessIds: z.array(z.uuid()).max(100),
  /**
   * Review tasks each review run of the repository's PRs/MRs fans out to, in
   * order (`repositories.review_task_ids`); the server checks they are review tasks.
   */
  reviewTaskIds: z
    .array(z.string().min(1).max(200))
    .min(1, "Choose at least one review task.")
    .max(MAX_REVIEW_TASKS, `At most ${MAX_REVIEW_TASKS} review tasks.`)
    .refine((ids) => new Set(ids).size === ids.length, "Choose each review task once."),
});
export type RepositorySettingsInput = z.infer<typeof RepositorySettingsInput>;

const ClaudeModel = z
  .string()
  .trim()
  .min(1, "Enter a model.")
  .max(200, "Model names can be at most 200 characters.")
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/, "Enter a Claude model ID, e.g. claude-sonnet-5-5.");

export const ReviewProfileInput = z.object({
  model: ClaudeModel,
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

export const MAX_LINEAR_ROUTING_VALUES = 50;
export const MAX_SETUP_COMMAND_LENGTH = 4000;
export const DEFAULT_RALPH_MODEL = "opus";

/**
 * Splits a comma-separated input (team keys, project names, labels) into
 * values: trimmed, blanks dropped, duplicates (ignoring case) removed.
 */
export function parseCommaList(text: string): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const value of text.split(",").map((v) => v.trim())) {
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    values.push(value);
  }
  return values;
}

const routingValues = (item: z.ZodString, what: string) =>
  z.array(item).max(MAX_LINEAR_ROUTING_VALUES, `At most ${MAX_LINEAR_ROUTING_VALUES} ${what}.`);

const RoutingName = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(255, "Names can be at most 255 characters.")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^,\u0000-\u001f\u007f]+$/, "Names can't contain commas or control characters.");

/** Longest `appendInstruction` (text appended to every story and request prompt). */
export const MAX_APPEND_INSTRUCTION_LENGTH = 10_000;
export const MAX_VERIFY_COMMANDS = 50;
export const MAX_TOOL_RULES = 100;
export const MAX_FIX_ROUNDS = 20;
export const MAX_UNMERGED_BRANCH_TIMEOUT_MINUTES = 7 * 24 * 60;
/** Whether request mode may rebase and `--force-with-lease` (`historyRewrite`). */
export const RALPH_HISTORY_REWRITE_POLICIES = ["when-asked", "never"] as const;
export type RalphHistoryRewrite = (typeof RALPH_HISTORY_REWRITE_POLICIES)[number];
/** Linear state types `epicCompletedState` may name instead of a state name. */
export const RALPH_EPIC_STATE_TYPES = ["started", "completed"] as const;

const ShellCommand = z
  .string()
  .trim()
  .min(1, "Enter a command.")
  .max(
    MAX_SETUP_COMMAND_LENGTH,
    `Commands can be at most ${MAX_SETUP_COMMAND_LENGTH.toLocaleString("en-US")} characters.`,
  )
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$/, "Commands are one line, without control characters.");

/** An Agent SDK tool name or permission rule, e.g. `Read`, `Bash(pnpm test:*)` or `mcp__server__tool`. */
const ToolRule = z
  .string()
  .trim()
  .min(1, "Enter a tool.")
  .max(500, "Tool rules can be at most 500 characters.")
  .regex(
    // eslint-disable-next-line no-control-regex
    /^[A-Za-z][A-Za-z0-9_-]*(\([^\u0000-\u001f\u007f]*\))?$/,
    "Enter a tool name or rule, e.g. Read or Bash(pnpm test:*).",
  );

const toolRules = (what: string) =>
  z.array(ToolRule).max(MAX_TOOL_RULES, `At most ${MAX_TOOL_RULES} ${what}.`);

const Rounds = z
  .int("Enter a whole number.")
  .min(0, "Enter 0 or more.")
  .max(MAX_FIX_ROUNDS, `At most ${MAX_FIX_ROUNDS}.`);

const UnmergedBranchTimeout = z
  .int("Enter a whole number.")
  .min(1, "Enter at least 1 minute.")
  .max(
    MAX_UNMERGED_BRANCH_TIMEOUT_MINUTES,
    `At most ${MAX_UNMERGED_BRANCH_TIMEOUT_MINUTES.toLocaleString("en-US")} minutes (a week).`,
  );

const AppendInstruction = z
  .string()
  .max(
    MAX_APPEND_INSTRUCTION_LENGTH,
    `The instruction can be at most ${MAX_APPEND_INSTRUCTION_LENGTH.toLocaleString("en-US")} characters.`,
  );

/** `started`, `completed` or a Linear state name, e.g. `In Review`. */
const EpicState = RoutingName;

const SetupCommand = z
  .string()
  .max(
    MAX_SETUP_COMMAND_LENGTH,
    `The setup command can be at most ${MAX_SETUP_COMMAND_LENGTH.toLocaleString("en-US")} characters.`,
  );

const manualLabels = () =>
  routingValues(RoutingName, "manual labels").min(1, "Enter at least one manual label.");

/**
 * Per-repository settings of ralph as stored
 * (`repositories.ralph_settings`; ported from cyralph's `repositories[]`).
 * Every field has its default, so `RalphSettings.parse({})` is the defaults.
 */
export const RalphSettings = z.object({
  /** Commands run as quality gates for every story and request in this repository. */
  verifyCommands: z
    .array(ShellCommand)
    .max(MAX_VERIFY_COMMANDS, `At most ${MAX_VERIFY_COMMANDS} commands.`)
    .default([]),
  /** Also run the PRD's `## Quality Gates` commands. */
  runPrdQualityGates: z.boolean().default(true),
  /** Text appended to every story and request prompt; null for none. */
  appendInstruction: AppendInstruction.trim().min(1).nullable().default(null),
  /** Agent SDK tools (or rules) the sessions may use; null: ralph's whole policy. They only narrow it. */
  allowedTools: toolRules("allowed tools").min(1).nullable().default(null),
  /** Agent SDK tools (or rules) denied on top of ralph's policy; null for none. */
  disallowedTools: toolRules("disallowed tools").min(1).nullable().default(null),
  /** Claude model (alias or ID) of the sessions. */
  model: ClaudeModel.default(DEFAULT_RALPH_MODEL),
  /** Model used when `model` is overloaded; null for none. */
  fallbackModel: ClaudeModel.nullable().default(null),
  /** Offer to run a manual story's `cyralph-prepare` commands ("Run it"). */
  allowPreparation: z.boolean().default(true),
  /** Linear labels marking a story as manual; the first labels the manual stories ralph files. */
  manualLabels: manualLabels().default(["manual"]),
  /** Whether request mode may rebase and `--force-with-lease` when asked to. */
  historyRewrite: z.enum(RALPH_HISTORY_REWRITE_POLICIES).default("when-asked"),
  /** Fix Omniralph review findings and `@bot` requests on the run's PR/MR. */
  respondToReviews: z.boolean().default(true),
  maxReviewRounds: Rounds.default(3),
  /** Fix failed CI on the run's PR/MR. */
  respondToCiFailures: z.boolean().default(true),
  maxFixRounds: Rounds.default(3),
  /** Remove the worktree and local branch after the PR/MR merges. */
  cleanupMergedWorktrees: z.boolean().default(true),
  /** Unmerged commits' branch is deleted after this long without an answer. */
  unmergedBranchTimeoutMinutes: UnmergedBranchTimeout.default(60),
  /**
   * The state an epic moves to when every story is complete: a state type
   * (`started` or `completed`) or a state name; null leaves it as it is.
   */
  epicCompletedState: EpicState.nullable().default(null),
  /** Open a draft PR/MR after the first pushed story (updated and marked ready at the end). */
  openPullRequestEarly: z.boolean().default(false),
  /** Run once in a fresh branch worktree (e.g. `pnpm install`); null for none. */
  setupCommand: SetupCommand.trim().min(1).nullable().default(null),
});
export type RalphSettings = z.output<typeof RalphSettings>;

export const DEFAULT_RALPH_SETTINGS: RalphSettings = RalphSettings.parse({});

/**
 * Stored ralph settings as the orchestrator reads them: missing or invalid
 * fields (an older row) get their default, the rest is kept.
 */
export function parseRalphSettings(stored: unknown): RalphSettings {
  const value = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  const settings: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(RalphSettings.shape)) {
    const parsed = field.safeParse(value[key]);
    settings[key] = parsed.success ? parsed.data : field.parse(undefined);
  }
  return settings as RalphSettings;
}

/**
 * An optional text field of the Ralph form: empty (after trimming) for none,
 * else valid for `schema`.
 */
const optionalText = (schema: z.ZodType) =>
  z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      if (!value) return;
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        ctx.addIssue({ code: "custom", message: parsed.error.issues[0]?.message ?? "Invalid." });
      }
    });

/** The Ralph section of Repository › Settings (`repositories.ralph_*`). */
export const RalphSettingsInput = z.object({
  /** Linear delegations may build in this repository. */
  ralphEnabled: z.boolean(),
  /** Linear team keys routed here, e.g. `ENG`. */
  linearTeamKeys: routingValues(
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_]{1,32}$/, "Team keys are letters and digits, e.g. ENG."),
    "team keys",
  ),
  linearProjectNames: routingValues(RoutingName, "project names"),
  linearLabels: routingValues(RoutingName, "labels"),

  // Verification
  verifyCommands: RalphSettings.shape.verifyCommands.unwrap(),
  runPrdQualityGates: z.boolean(),
  /** Run once in a fresh branch worktree; empty for none. */
  setupCommand: SetupCommand,

  // Prompt and model
  /** Empty for none. */
  appendInstruction: AppendInstruction,
  /** Claude model (alias or ID) the story sessions use. */
  model: ClaudeModel,
  /** Empty for none. */
  fallbackModel: optionalText(ClaudeModel),

  // Tools (empty lists for none)
  allowedTools: toolRules("allowed tools"),
  disallowedTools: toolRules("disallowed tools"),

  // PR follow-up
  /** Open a draft PR/MR after the first pushed story. */
  openPullRequestEarly: z.boolean(),
  historyRewrite: z.enum(RALPH_HISTORY_REWRITE_POLICIES, { error: "Choose a policy." }),
  respondToReviews: z.boolean(),
  maxReviewRounds: Rounds,
  respondToCiFailures: z.boolean(),
  maxFixRounds: Rounds,
  cleanupMergedWorktrees: z.boolean(),
  unmergedBranchTimeoutMinutes: UnmergedBranchTimeout,

  // Linear
  /** Linear labels marking a story as manual; the first labels the manual stories ralph files. */
  manualLabels: manualLabels(),
  allowPreparation: z.boolean(),
  /** Empty to leave the epic's state alone. */
  epicCompletedState: optionalText(EpicState),
});
export type RalphSettingsInput = z.infer<typeof RalphSettingsInput>;

/** The stored settings of a valid Ralph form (empty text and lists become null). */
export function ralphSettingsFromInput(input: RalphSettingsInput): RalphSettings {
  const text = (value: string) => value.trim() || null;
  const list = (values: readonly string[]) => (values.length > 0 ? [...values] : null);
  return RalphSettings.parse({
    verifyCommands: input.verifyCommands,
    runPrdQualityGates: input.runPrdQualityGates,
    appendInstruction: text(input.appendInstruction),
    allowedTools: list(input.allowedTools),
    disallowedTools: list(input.disallowedTools),
    model: input.model,
    fallbackModel: text(input.fallbackModel),
    allowPreparation: input.allowPreparation,
    manualLabels: input.manualLabels,
    historyRewrite: input.historyRewrite,
    respondToReviews: input.respondToReviews,
    maxReviewRounds: input.maxReviewRounds,
    respondToCiFailures: input.respondToCiFailures,
    maxFixRounds: input.maxFixRounds,
    cleanupMergedWorktrees: input.cleanupMergedWorktrees,
    unmergedBranchTimeoutMinutes: input.unmergedBranchTimeoutMinutes,
    epicCompletedState: text(input.epicCompletedState),
    openPullRequestEarly: input.openPullRequestEarly,
    setupCommand: text(input.setupCommand),
  } satisfies z.input<typeof RalphSettings>);
}

/** The Ralph form's values of stored settings (none becomes empty text or lists). */
export function ralphSettingsFormValues(
  settings: RalphSettings,
): Omit<
  RalphSettingsInput,
  "ralphEnabled" | "linearTeamKeys" | "linearProjectNames" | "linearLabels"
> {
  return {
    verifyCommands: [...settings.verifyCommands],
    runPrdQualityGates: settings.runPrdQualityGates,
    setupCommand: settings.setupCommand ?? "",
    appendInstruction: settings.appendInstruction ?? "",
    model: settings.model,
    fallbackModel: settings.fallbackModel ?? "",
    allowedTools: [...(settings.allowedTools ?? [])],
    disallowedTools: [...(settings.disallowedTools ?? [])],
    openPullRequestEarly: settings.openPullRequestEarly,
    historyRewrite: settings.historyRewrite,
    respondToReviews: settings.respondToReviews,
    maxReviewRounds: settings.maxReviewRounds,
    respondToCiFailures: settings.respondToCiFailures,
    maxFixRounds: settings.maxFixRounds,
    cleanupMergedWorktrees: settings.cleanupMergedWorktrees,
    unmergedBranchTimeoutMinutes: settings.unmergedBranchTimeoutMinutes,
    manualLabels: [...settings.manualLabels],
    allowPreparation: settings.allowPreparation,
    epicCompletedState: settings.epicCompletedState ?? "",
  };
}

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
