import { RALPH_EPIC_STATE_TYPES } from "@omniralph/shared";

/** The connected Linear workspace's values the settings pages pick from. */
export interface LinearSettingsOptions {
  teams: Array<{ key: string; name: string }>;
  /** Label names, workspace and team labels de-duplicated (ignoring case). */
  labels: string[];
  /** Project names. */
  projects: string[];
  /** Workflow state names, de-duplicated across teams (ignoring case). */
  states: string[];
  /** Project milestone names, de-duplicated across projects (ignoring case). */
  projectMilestones: string[];
  /** Current and upcoming cycles, by team key then number. */
  cycles: Array<{ id: string; number: number; name: string | null; teamKey: string }>;
  /** Active users, by name. */
  users: Array<{ id: string; name: string }>;
}

/** Saved Linear values to check against the workspace. */
export interface LinearSettingsValues {
  manualLabels?: readonly string[];
  blockedLabels?: readonly string[];
  epicCompletedState?: string | null;
}

export interface UnknownLinearValues {
  manualLabels: string[];
  blockedLabels: string[];
  /** The epic state when it is neither empty, a state type nor a state name; else null. */
  epicCompletedState: string | null;
}

/** `values` (in order, as saved) that aren't in `known`, ignoring case. */
function missing(values: readonly string[] | undefined, known: readonly string[]): string[] {
  const have = new Set(known.map((v) => v.toLowerCase()));
  return (values ?? []).filter((v) => !have.has(v.toLowerCase()));
}

/**
 * The saved values that no longer exist in the workspace (e.g. a renamed
 * label), matched ignoring case. `started`, `completed` and an empty epic
 * state are always valid.
 */
export function unknownLinearValues(
  options: LinearSettingsOptions,
  values: LinearSettingsValues,
): UnknownLinearValues {
  const epicState = values.epicCompletedState?.trim() ?? "";
  const knownEpicState =
    epicState === "" ||
    missing([epicState], [...RALPH_EPIC_STATE_TYPES, ...options.states]).length === 0;
  return {
    manualLabels: missing(values.manualLabels, options.labels),
    blockedLabels: missing(values.blockedLabels, options.labels),
    epicCompletedState: knownEpicState ? null : epicState,
  };
}
