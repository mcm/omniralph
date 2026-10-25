/**
 * The settings forms' drafts (what the inputs hold), their parsed values and
 * the cards they are saved in: repository review settings. Pure, so the
 * change lists can be tested.
 */
import {
  parsePathExcludes,
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
