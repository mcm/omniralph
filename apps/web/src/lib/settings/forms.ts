/**
 * The settings forms' drafts (what the inputs hold), their parsed values and
 * the cards they are saved in: repository review settings and the Ralph
 * section. Pure, so the change lists can be tested.
 */
import {
  DEFAULT_RALPH_SETTINGS,
  parseLines,
  parsePathExcludes,
  type RalphHistoryRewrite,
  type RalphSettingsInput,
  type RepositorySettingsInput,
  type ReviewDepth,
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
  triggers: { onOpen: true, onPush: true, drafts: false },
} as const;

/** The repository review settings form. */
export interface RepositoryDraft {
  onOpen: boolean;
  onPush: boolean;
  drafts: boolean;
  /** One glob per line. */
  pathExcludes: string;
  customInstructions: string;
  pinnedHarnessIds: readonly string[];
}

/** The repository review settings as saved. */
export interface RepositorySettingsValues {
  triggers: { onOpen: boolean; onPush: boolean; drafts: boolean };
  pathExcludes: readonly string[];
  customInstructions: string;
  pinnedHarnessIds: readonly string[];
}

export function repositoryDraft(settings: RepositorySettingsValues): RepositoryDraft {
  return {
    ...settings.triggers,
    pathExcludes: settings.pathExcludes.join("\n"),
    customInstructions: settings.customInstructions,
    pinnedHarnessIds: settings.pinnedHarnessIds,
  };
}

/** What the form compares and saves: lists parsed, IDs that no longer exist dropped. */
export interface RepositoryFormContext {
  /** Harnesses that can still be pinned (pins of revoked ones are dropped). */
  harnessIds: readonly string[];
}

export function repositoryValues(draft: RepositoryDraft, context: RepositoryFormContext) {
  return {
    onOpen: draft.onOpen,
    onPush: draft.onPush,
    drafts: draft.drafts,
    pathExcludes: parsePathExcludes(draft.pathExcludes),
    customInstructions: draft.customInstructions,
    // In the harnesses' order, so picking them in another order isn't a change.
    pinnedHarnessIds: context.harnessIds.filter((id) => draft.pinnedHarnessIds.includes(id)),
  } satisfies Record<string, SettingValue>;
}
export type RepositoryValues = ReturnType<typeof repositoryValues>;

/** The settings to save: the form's values, with the review depth the repository has. */
export function repositoryInput(
  values: RepositoryValues,
  depth: ReviewDepth,
): RepositorySettingsInput {
  return {
    depth,
    triggers: { onOpen: values.onOpen, onPush: values.onPush, drafts: values.drafts },
    pathExcludes: [...values.pathExcludes],
    customInstructions: values.customInstructions,
    pinnedHarnessIds: [...values.pinnedHarnessIds],
  };
}

/** The repository settings page's cards and the settings each one saves. */
export const REPOSITORY_CARDS = {
  triggers: ["onOpen", "onPush", "drafts"],
  files: ["pathExcludes", "customInstructions"],
  pinning: ["pinnedHarnessIds"],
} as const satisfies Record<string, readonly (keyof RepositoryValues)[]>;

/** The repository settings tabs' sections and the settings each one saves. */
export const REPOSITORY_SECTIONS = {
  review: [...REPOSITORY_CARDS.triggers, ...REPOSITORY_CARDS.files],
  harnesses: REPOSITORY_CARDS.pinning,
} as const satisfies Record<string, readonly (keyof RepositoryValues)[]>;

/** The repository settings' labels, showing harnesses by name. */
export function repositorySpecs(names: {
  harnesses: ReadonlyMap<string, string>;
}): Record<keyof RepositoryValues, SettingSpec<keyof RepositoryValues>> {
  return {
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

/** What the Ralph form edits: the coding settings without the playbook bindings. */
export type RalphFormInput = Omit<RalphSettingsInput, "storyPlaybookId" | "requestPlaybookId">;

/** The Ralph form: picked lists as chips, commands one per line, numbers as typed. */
export interface RalphDraft {
  verifyCommands: string;
  runPrdQualityGates: boolean;
  setupCommand: string;
  appendInstruction: string;
  model: string;
  fallbackModel: string;
  allowedTools: string[];
  disallowedTools: string[];
  openPullRequestEarly: boolean;
  historyRewrite: RalphHistoryRewrite;
  respondToReviews: boolean;
  maxReviewRounds: string;
  respondToCiFailures: boolean;
  maxFixRounds: string;
  cleanupMergedWorktrees: boolean;
  unmergedBranchTimeoutMinutes: string;
  manualLabels: string[];
  blockedLabels: string[];
  allowPreparation: boolean;
  epicCompletedState: string;
}

/** The form's draft of saved settings (the playbook bindings, which it doesn't edit, left out). */
export function ralphDraft({
  storyPlaybookId: _story,
  requestPlaybookId: _request,
  ...settings
}: RalphSettingsInput): RalphDraft {
  return {
    ...settings,
    verifyCommands: settings.verifyCommands.join("\n"),
    allowedTools: [...settings.allowedTools],
    disallowedTools: [...settings.disallowedTools],
    maxReviewRounds: String(settings.maxReviewRounds),
    maxFixRounds: String(settings.maxFixRounds),
    unmergedBranchTimeoutMinutes: String(settings.unmergedBranchTimeoutMinutes),
    manualLabels: [...settings.manualLabels],
    blockedLabels: [...settings.blockedLabels],
  };
}

/** The draft's values as the server saves them (text trimmed). */
export function ralphValues(draft: RalphDraft): RalphFormInput {
  return {
    ...draft,
    verifyCommands: parseLines(draft.verifyCommands),
    setupCommand: draft.setupCommand.trim(),
    appendInstruction: draft.appendInstruction.trim(),
    model: draft.model.trim(),
    fallbackModel: draft.fallbackModel.trim(),
    allowedTools: draft.allowedTools.map((tool) => tool.trim()).filter(Boolean),
    disallowedTools: draft.disallowedTools.map((tool) => tool.trim()).filter(Boolean),
    maxReviewRounds: typedNumber(draft.maxReviewRounds),
    maxFixRounds: typedNumber(draft.maxFixRounds),
    unmergedBranchTimeoutMinutes: typedNumber(draft.unmergedBranchTimeoutMinutes),
    epicCompletedState: draft.epicCompletedState.trim(),
  };
}

/** The Ralph section's cards and the settings each one saves. */
export const RALPH_CARDS = {
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
  linear: ["manualLabels", "blockedLabels", "allowPreparation", "epicCompletedState"],
} as const satisfies Record<string, readonly (keyof RalphFormInput)[]>;

/** The settings that rewrite history or delete branches: the Danger zone saves them on their own. */
const DANGER_KEYS = [
  "historyRewrite",
  "cleanupMergedWorktrees",
  "unmergedBranchTimeoutMinutes",
] as const satisfies readonly (keyof RalphFormInput)[];

/** The Coding tab's sections and the settings each one saves. */
export const CODING_SECTIONS = {
  coding: [
    ...RALPH_CARDS.prompt,
    ...RALPH_CARDS.tools,
    ...RALPH_CARDS.verification,
    ...RALPH_CARDS.followUp.filter((key) => !(DANGER_KEYS as readonly string[]).includes(key)),
    ...RALPH_CARDS.linear,
  ],
  danger: DANGER_KEYS,
} satisfies Record<string, readonly (keyof RalphFormInput)[]>;

export const HISTORY_REWRITE_LABELS: Record<RalphHistoryRewrite, string> = {
  "when-asked": "When asked",
  always: "Always (rebase, never merge)",
  never: "Never",
};

const RALPH_LABELS: Record<keyof RalphFormInput, string> = {
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
  blockedLabels: "Blocked labels",
  allowPreparation: "Offer to run preparation",
  epicCompletedState: "Epic completed state",
};

/** The Ralph settings' labels. */
export function ralphSpecs(): Record<keyof RalphFormInput, SettingSpec<keyof RalphFormInput>> {
  const formats: Partial<Record<keyof RalphFormInput, SettingSpec["format"]>> = {
    historyRewrite: (value) =>
      HISTORY_REWRITE_LABELS[value as RalphHistoryRewrite] ?? String(value),
    verifyCommands: lines,
    allowedTools: (value) =>
      Array.isArray(value) && value.length === 0
        ? "Not set (Omniralph's whole coding policy)"
        : lines(value),
    disallowedTools: lines,
    blockedLabels: (value) =>
      Array.isArray(value) && value.length === 0 ? "None" : formatSettingValue(value),
  };
  return Object.fromEntries(
    (Object.keys(RALPH_LABELS) as (keyof RalphFormInput)[]).map((key) => [
      key,
      { key, label: RALPH_LABELS[key], format: formats[key] },
    ]),
  ) as Record<keyof RalphFormInput, SettingSpec<keyof RalphFormInput>>;
}

/** The Ralph defaults as the form describes them. */
export const RALPH_DEFAULT_TEXT = {
  model: DEFAULT_RALPH_SETTINGS.model,
  maxReviewRounds: String(DEFAULT_RALPH_SETTINGS.maxReviewRounds),
  maxFixRounds: String(DEFAULT_RALPH_SETTINGS.maxFixRounds),
  unmergedBranchTimeoutMinutes: `${DEFAULT_RALPH_SETTINGS.unmergedBranchTimeoutMinutes} minutes`,
  manualLabels: DEFAULT_RALPH_SETTINGS.manualLabels.join(", "),
  blockedLabels: DEFAULT_RALPH_SETTINGS.blockedLabels.join(", "),
  historyRewrite: HISTORY_REWRITE_LABELS[DEFAULT_RALPH_SETTINGS.historyRewrite],
  onOff: (value: boolean) => formatSettingValue(value),
};
