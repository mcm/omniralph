/**
 * The settings forms' drafts (what the inputs hold), their parsed values and
 * the cards they are saved in: repository review settings, the Ralph section
 * and review profiles. Pure, so the change lists can be tested.
 */
import {
  DEFAULT_RALPH_SETTINGS,
  parseCommaList,
  parseLines,
  parsePathExcludes,
  type RalphCodingPath,
  type RalphHistoryRewrite,
  type RalphSettingsInput,
  type RepositorySettingsInput,
  type ReviewProfileInput,
} from "@omniralph/shared";
import { formatSettingValue, type SettingSpec, type SettingValue } from "./changes";

/** A number typed into a number input; NaN (rejected by the schemas) when it isn't a number. */
export function typedNumber(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

/** A large count as the form shows it, with separators: 60000 → "60,000". */
export function groupedNumber(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Regroups a count as it is typed ("150000" → "150,000"), keeping the caret after the same
 * digit. Text that isn't only digits and separators is left alone, so validation can flag it.
 */
export function regroupTyped(value: string, caret: number): { value: string; caret: number } {
  if (!/^[\d,_\s]*$/.test(value)) return { value, caret };
  const digits = value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  if (digits === "") return { value: "", caret: 0 };
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // Digits before the caret, counted in the regrouped text.
  const stripped = value.replace(/\D/g, "").length - digits.length;
  let before = Math.max(0, value.slice(0, caret).replace(/\D/g, "").length - stripped);
  let next = 0;
  while (before > 0 && next < grouped.length) {
    if (grouped[next] !== ",") before--;
    next++;
  }
  return { value: grouped, caret: next };
}

/** A typed count that may have separators ("60,000", "60 000", "60_000"); NaN when empty. */
export function typedGroupedNumber(value: string): number {
  return typedNumber(value.replace(/[,_\s]/g, ""));
}

/** `keys` of `source`. */
export function pickKeys<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, source[key]])) as Pick<T, K>;
}

/** Shows an ID by its name in `names`, or the ID itself when it has none. */
const byName =
  (names: ReadonlyMap<string, string>) =>
  (value: SettingValue): string => {
    if (typeof value === "string") return names.get(value) ?? formatSettingValue(value);
    if (Array.isArray(value)) {
      return formatSettingValue(value.map((id: string) => names.get(id) ?? id));
    }
    return formatSettingValue(value);
  };

/** Shows each line of a list on its own line (commands, tool rules). */
const lines = (value: SettingValue): string =>
  Array.isArray(value) && value.length > 0 ? value.join("\n") : formatSettingValue(value);

// ── Repository review settings ───────────────────────────────────────────────

/**
 * Defaults of a newly connected repository's review settings (the
 * `repositories` column defaults in `@omniralph/db`; a test keeps them in step).
 */
export const REPOSITORY_SETTING_DEFAULTS = {
  profileId: "standard",
  triggers: { onOpen: true, onPush: true, drafts: false },
  reviewTaskIds: ["builtin:review-pr"],
  correlationTaskId: "builtin:correlate-findings",
} as const;

/** The repository review settings form. */
export interface RepositoryDraft {
  profileId: string;
  onOpen: boolean;
  onPush: boolean;
  drafts: boolean;
  /** One glob per line. */
  pathExcludes: string;
  customInstructions: string;
  pinnedHarnessIds: readonly string[];
  reviewTaskIds: readonly string[];
  correlationTaskId: string;
}

/** The repository review settings as saved. */
export interface RepositorySettingsValues {
  profileId: string;
  triggers: { onOpen: boolean; onPush: boolean; drafts: boolean };
  pathExcludes: readonly string[];
  customInstructions: string;
  pinnedHarnessIds: readonly string[];
  reviewTaskIds: readonly string[];
  correlationTaskId: string;
}

export function repositoryDraft(settings: RepositorySettingsValues): RepositoryDraft {
  return {
    profileId: settings.profileId,
    ...settings.triggers,
    pathExcludes: settings.pathExcludes.join("\n"),
    customInstructions: settings.customInstructions,
    pinnedHarnessIds: settings.pinnedHarnessIds,
    reviewTaskIds: settings.reviewTaskIds,
    correlationTaskId: settings.correlationTaskId,
  };
}

/** What the form compares and saves: lists parsed, IDs that no longer exist dropped. */
export interface RepositoryFormContext {
  /** The review tasks offered, in the order they're listed (and saved). */
  reviewTaskIds: readonly string[];
  /** Harnesses that can still be pinned (pins of revoked ones are dropped). */
  harnessIds: readonly string[];
}

export function repositoryValues(draft: RepositoryDraft, context: RepositoryFormContext) {
  return {
    profileId: draft.profileId,
    onOpen: draft.onOpen,
    onPush: draft.onPush,
    drafts: draft.drafts,
    pathExcludes: parsePathExcludes(draft.pathExcludes),
    customInstructions: draft.customInstructions,
    // In the harnesses' order, so picking them in another order isn't a change.
    pinnedHarnessIds: context.harnessIds.filter((id) => draft.pinnedHarnessIds.includes(id)),
    // In the listed order; review tasks that no longer exist are dropped.
    reviewTaskIds: context.reviewTaskIds.filter((id) => draft.reviewTaskIds.includes(id)),
    correlationTaskId: draft.correlationTaskId,
  } satisfies Record<string, SettingValue>;
}
export type RepositoryValues = ReturnType<typeof repositoryValues>;

export function repositoryInput(values: RepositoryValues): RepositorySettingsInput {
  return {
    profileId: values.profileId as RepositorySettingsInput["profileId"],
    triggers: { onOpen: values.onOpen, onPush: values.onPush, drafts: values.drafts },
    pathExcludes: [...values.pathExcludes],
    customInstructions: values.customInstructions,
    pinnedHarnessIds: [...values.pinnedHarnessIds],
    reviewTaskIds: [...values.reviewTaskIds],
    correlationTaskId: values.correlationTaskId,
  };
}

/** The repository settings page's cards and the settings each one saves. */
export const REPOSITORY_CARDS = {
  profile: ["profileId"],
  tasks: ["reviewTaskIds", "correlationTaskId"],
  triggers: ["onOpen", "onPush", "drafts"],
  files: ["pathExcludes", "customInstructions"],
  pinning: ["pinnedHarnessIds"],
} as const satisfies Record<string, readonly (keyof RepositoryValues)[]>;

/** The repository settings tabs' sections and the settings each one saves. */
export const REPOSITORY_SECTIONS = {
  review: [
    ...REPOSITORY_CARDS.triggers,
    ...REPOSITORY_CARDS.profile,
    ...REPOSITORY_CARDS.tasks,
    ...REPOSITORY_CARDS.files,
  ],
  harnesses: REPOSITORY_CARDS.pinning,
} as const satisfies Record<string, readonly (keyof RepositoryValues)[]>;

/** The repository settings' labels, showing profiles, tasks and harnesses by name. */
export function repositorySpecs(names: {
  profiles: ReadonlyMap<string, string>;
  tasks: ReadonlyMap<string, string>;
  harnesses: ReadonlyMap<string, string>;
}): Record<keyof RepositoryValues, SettingSpec<keyof RepositoryValues>> {
  return {
    profileId: { key: "profileId", label: "Review profile", format: byName(names.profiles) },
    reviewTaskIds: { key: "reviewTaskIds", label: "Review tasks", format: byName(names.tasks) },
    correlationTaskId: {
      key: "correlationTaskId",
      label: "Correlation task",
      format: byName(names.tasks),
    },
    onOpen: { key: "onOpen", label: "Review when opened" },
    onPush: { key: "onPush", label: "Review when pushed to" },
    drafts: { key: "drafts", label: "Include drafts" },
    pathExcludes: { key: "pathExcludes", label: "Path excludes", format: lines },
    customInstructions: { key: "customInstructions", label: "Custom instructions" },
    pinnedHarnessIds: {
      key: "pinnedHarnessIds",
      label: "Pinned harnesses",
      format: (value) =>
        Array.isArray(value) && value.length === 0
          ? "Not set (any harness)"
          : byName(names.harnesses)(value),
    },
  };
}

// ── Ralph ────────────────────────────────────────────────────────────────────

/** Defaults of the Ralph section's repository columns (`@omniralph/db`; a test keeps them in step). */
export const RALPH_REPOSITORY_DEFAULTS = {
  codingPath: "legacy",
  storyTaskId: "builtin:implement-story",
  requestTaskId: "builtin:handle-request",
} as const satisfies Partial<RalphSettingsInput>;

/** The Ralph form: lists as comma-separated or one-per-line text, numbers as typed. */
export interface RalphDraft {
  linearTeamKeys: string;
  linearProjectNames: string;
  linearLabels: string;
  codingPath: RalphCodingPath;
  storyTaskId: string;
  requestTaskId: string;
  verifyCommands: string;
  runPrdQualityGates: boolean;
  setupCommand: string;
  appendInstruction: string;
  model: string;
  fallbackModel: string;
  allowedTools: string;
  disallowedTools: string;
  openPullRequestEarly: boolean;
  historyRewrite: RalphHistoryRewrite;
  respondToReviews: boolean;
  maxReviewRounds: string;
  respondToCiFailures: boolean;
  maxFixRounds: string;
  cleanupMergedWorktrees: boolean;
  unmergedBranchTimeoutMinutes: string;
  manualLabels: string;
  allowPreparation: boolean;
  epicCompletedState: string;
}

export function ralphDraft(settings: RalphSettingsInput): RalphDraft {
  return {
    ...settings,
    linearTeamKeys: settings.linearTeamKeys.join(", "),
    linearProjectNames: settings.linearProjectNames.join(", "),
    linearLabels: settings.linearLabels.join(", "),
    verifyCommands: settings.verifyCommands.join("\n"),
    allowedTools: settings.allowedTools.join("\n"),
    disallowedTools: settings.disallowedTools.join("\n"),
    maxReviewRounds: String(settings.maxReviewRounds),
    maxFixRounds: String(settings.maxFixRounds),
    unmergedBranchTimeoutMinutes: String(settings.unmergedBranchTimeoutMinutes),
    manualLabels: settings.manualLabels.join(", "),
  };
}

/** The draft's values as the server saves them (team keys upper-cased, text trimmed). */
export function ralphValues(draft: RalphDraft): RalphSettingsInput {
  return {
    ...draft,
    linearTeamKeys: parseCommaList(draft.linearTeamKeys).map((key) => key.toUpperCase()),
    linearProjectNames: parseCommaList(draft.linearProjectNames),
    linearLabels: parseCommaList(draft.linearLabels),
    verifyCommands: parseLines(draft.verifyCommands),
    setupCommand: draft.setupCommand.trim(),
    appendInstruction: draft.appendInstruction.trim(),
    model: draft.model.trim(),
    fallbackModel: draft.fallbackModel.trim(),
    allowedTools: parseLines(draft.allowedTools),
    disallowedTools: parseLines(draft.disallowedTools),
    maxReviewRounds: typedNumber(draft.maxReviewRounds),
    maxFixRounds: typedNumber(draft.maxFixRounds),
    unmergedBranchTimeoutMinutes: typedNumber(draft.unmergedBranchTimeoutMinutes),
    manualLabels: parseCommaList(draft.manualLabels),
    epicCompletedState: draft.epicCompletedState.trim(),
  };
}

/** The Ralph section's cards and the settings each one saves. */
export const RALPH_CARDS = {
  ralph: [
    "codingPath",
    "storyTaskId",
    "requestTaskId",
    "linearLabels",
    "linearProjectNames",
    "linearTeamKeys",
  ],
  verification: ["verifyCommands", "runPrdQualityGates", "setupCommand"],
  prompt: ["appendInstruction", "model", "fallbackModel"],
  tools: ["allowedTools", "disallowedTools"],
  followUp: [
    "openPullRequestEarly",
    "historyRewrite",
    "respondToReviews",
    "maxReviewRounds",
    "respondToCiFailures",
    "maxFixRounds",
    "cleanupMergedWorktrees",
    "unmergedBranchTimeoutMinutes",
  ],
  linear: ["manualLabels", "allowPreparation", "epicCompletedState"],
} as const satisfies Record<string, readonly (keyof RalphSettingsInput)[]>;

/** The settings that rewrite history or delete branches: the Danger zone saves them on their own. */
const DANGER_KEYS = [
  "historyRewrite",
  "cleanupMergedWorktrees",
  "unmergedBranchTimeoutMinutes",
] as const satisfies readonly (keyof RalphSettingsInput)[];

/** The Coding tab's sections and the settings each one saves. */
export const CODING_SECTIONS = {
  coding: [
    ...RALPH_CARDS.ralph,
    ...RALPH_CARDS.prompt,
    ...RALPH_CARDS.tools,
    ...RALPH_CARDS.verification,
    ...RALPH_CARDS.followUp.filter(
      (key) => !(DANGER_KEYS as readonly string[]).includes(key),
    ),
    ...RALPH_CARDS.linear,
  ],
  danger: DANGER_KEYS,
} satisfies Record<string, readonly (keyof RalphSettingsInput)[]>;

export const CODING_PATH_LABELS: Record<RalphCodingPath, string> = {
  legacy: "Legacy jobs",
  tasks: "Coding tasks",
};

export const HISTORY_REWRITE_LABELS: Record<RalphHistoryRewrite, string> = {
  "when-asked": "When asked",
  never: "Never",
};

const RALPH_LABELS: Record<keyof RalphSettingsInput, string> = {
  codingPath: "Coding path",
  storyTaskId: "Story task",
  requestTaskId: "Request task",
  linearLabels: "Linear labels",
  linearProjectNames: "Linear projects",
  linearTeamKeys: "Linear team keys",
  verifyCommands: "Verify commands",
  runPrdQualityGates: "Run the PRD's quality gates",
  setupCommand: "Setup command",
  appendInstruction: "Appended instruction",
  model: "Model",
  fallbackModel: "Fallback model",
  allowedTools: "Allowed tools",
  disallowedTools: "Disallowed tools",
  openPullRequestEarly: "Open the pull request early",
  historyRewrite: "History rewrites",
  respondToReviews: "Fix review findings",
  maxReviewRounds: "Max review rounds",
  respondToCiFailures: "Fix failed CI",
  maxFixRounds: "Max CI fix rounds",
  cleanupMergedWorktrees: "Clean up after the merge",
  unmergedBranchTimeoutMinutes: "Unmerged branch timeout (minutes)",
  manualLabels: "Manual labels",
  allowPreparation: "Offer to run preparation",
  epicCompletedState: "Epic completed state",
};

/** The Ralph settings' labels, showing tasks by name. */
export function ralphSpecs(
  taskNames: ReadonlyMap<string, string>,
): Record<keyof RalphSettingsInput, SettingSpec<keyof RalphSettingsInput>> {
  const formats: Partial<Record<keyof RalphSettingsInput, SettingSpec["format"]>> = {
    codingPath: (value) => CODING_PATH_LABELS[value as RalphCodingPath] ?? String(value),
    historyRewrite: (value) =>
      HISTORY_REWRITE_LABELS[value as RalphHistoryRewrite] ?? String(value),
    storyTaskId: byName(taskNames),
    requestTaskId: byName(taskNames),
    verifyCommands: lines,
    allowedTools: (value) =>
      Array.isArray(value) && value.length === 0
        ? "Not set (Omniralph's whole coding policy)"
        : lines(value),
    disallowedTools: lines,
  };
  return Object.fromEntries(
    (Object.keys(RALPH_LABELS) as (keyof RalphSettingsInput)[]).map((key) => [
      key,
      { key, label: RALPH_LABELS[key], format: formats[key] },
    ]),
  ) as Record<keyof RalphSettingsInput, SettingSpec<keyof RalphSettingsInput>>;
}

/** The Ralph defaults as the form describes them. */
export const RALPH_DEFAULT_TEXT = {
  model: DEFAULT_RALPH_SETTINGS.model,
  maxReviewRounds: String(DEFAULT_RALPH_SETTINGS.maxReviewRounds),
  maxFixRounds: String(DEFAULT_RALPH_SETTINGS.maxFixRounds),
  unmergedBranchTimeoutMinutes: `${DEFAULT_RALPH_SETTINGS.unmergedBranchTimeoutMinutes} minutes`,
  manualLabels: DEFAULT_RALPH_SETTINGS.manualLabels.join(", "),
  historyRewrite: HISTORY_REWRITE_LABELS[DEFAULT_RALPH_SETTINGS.historyRewrite],
  codingPath: CODING_PATH_LABELS[RALPH_REPOSITORY_DEFAULTS.codingPath],
  onOff: (value: boolean) => formatSettingValue(value),
};

// ── Review profiles ──────────────────────────────────────────────────────────

/** A review profile's form. */
export interface ProfileDraft {
  model: string;
  maxTokensPerReview: string;
  maxFiles: string;
  allowRepoExploration: boolean;
}

export function profileDraft(profile: ReviewProfileInput): ProfileDraft {
  return {
    model: profile.model,
    maxTokensPerReview: groupedNumber(profile.maxTokensPerReview),
    maxFiles: String(profile.maxFiles),
    allowRepoExploration: profile.allowRepoExploration,
  };
}

export function profileValues(draft: ProfileDraft): ReviewProfileInput {
  return {
    model: draft.model.trim(),
    maxTokensPerReview: typedGroupedNumber(draft.maxTokensPerReview),
    maxFiles: typedNumber(draft.maxFiles),
    allowRepoExploration: draft.allowRepoExploration,
  };
}

export const PROFILE_SPECS: readonly SettingSpec<keyof ReviewProfileInput>[] = [
  { key: "model", label: "Model" },
  { key: "maxTokensPerReview", label: "Token cap per review" },
  { key: "maxFiles", label: "Max files" },
  { key: "allowRepoExploration", label: "Allow repository exploration" },
];
