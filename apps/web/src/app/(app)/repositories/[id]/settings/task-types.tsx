"use client";

import { Field, NativeSelect } from "@iamthemcmaster/ui";
import type { RepositoryTaskTypesInput } from "@omniralph/shared";
import type { ActionResult } from "@/lib/action-result";
import { formatSettingValue, type SettingSpec } from "@/lib/settings/changes";
import { pickKeys } from "@/lib/settings/forms";
import { updateRepositoryTaskTypes } from "./actions";

/** A repository's task-type switches. */
export type TaskTypeSwitch = keyof RepositoryTaskTypesInput;

/** The switches' values: the repository's own (null inherits) and the organization's. */
export interface TaskTypesValues {
  /** The repository's own values; null uses the organization's default. */
  overrides: RepositoryTaskTypesInput;
  /** Whether the organization allows each task type by default. */
  inherited: Record<TaskTypeSwitch, boolean>;
}

/** A switch's choice in the form. */
export type TaskTypeChoice = "inherit" | "on" | "off";

export function taskTypeChoice(value: boolean | null): TaskTypeChoice {
  return value === null ? "inherit" : value ? "on" : "off";
}

export function taskTypeValue(choice: TaskTypeChoice): boolean | null {
  return choice === "inherit" ? null : choice === "on";
}

/** The switches: Query and Reviews on the Review settings tab, Coding on the Coding tab. */
export const TASK_TYPE_SWITCHES: Record<TaskTypeSwitch, { label: string; hint: string }> = {
  query: {
    label: "Query",
    hint: "Answer @mentions, chat questions and Linear triage about this repository. Omniralph's own queries (correlating review findings, describing pull requests) always run.",
  },
  review: {
    label: "Reviews",
    hint: "Review its pull and merge requests when the triggers below fire.",
  },
  coding: {
    label: "Coding",
    hint: "Build delegated Linear issues and handle requests here, pushing branches to it.",
  },
};

/** "Use organization default (On)": the inherit choice, showing the inherited value. */
export function inheritLabel(inherited: boolean): string {
  return `Use organization default (${formatSettingValue(inherited)})`;
}

/** Whether the task type runs: the repository's own value, else the organization's. */
export function taskTypeOn(values: TaskTypesValues, key: TaskTypeSwitch, value: boolean | null) {
  return value ?? values.inherited[key];
}

/** The change-list spec of a switch, naming the inherited value. */
export function taskTypeSpec(
  values: TaskTypesValues,
  key: TaskTypeSwitch,
): SettingSpec<TaskTypeSwitch> {
  return {
    key,
    label: TASK_TYPE_SWITCHES[key].label,
    format: (value) =>
      value === null ? inheritLabel(values.inherited[key]) : formatSettingValue(value),
  };
}

/** A task-type switch: the organization's default, on or off. */
export function TaskTypeSelect({
  name,
  values,
  value,
  disabled,
  error,
  compact = false,
  onChange,
}: {
  name: TaskTypeSwitch;
  values: TaskTypesValues;
  value: boolean | null;
  disabled: boolean;
  error?: string;
  /** In a section's header: the label beside the select, the hint for screen readers only. */
  compact?: boolean;
  onChange: (value: boolean | null) => void;
}) {
  const { label, hint } = TASK_TYPE_SWITCHES[name];
  const id = `task-type-${name}`;
  const select = (
    <NativeSelect
      id={id}
      value={taskTypeChoice(value)}
      disabled={disabled}
      aria-invalid={Boolean(error)}
      aria-describedby={compact ? `${id}-hint` : undefined}
      onChange={(e) => onChange(taskTypeValue(e.target.value as TaskTypeChoice))}
    >
      <option value="inherit">{inheritLabel(values.inherited[name])}</option>
      <option value="on">On</option>
      <option value="off">Off</option>
    </NativeSelect>
  );
  if (!compact) {
    return (
      <Field label={label} htmlFor={id} description={hint} error={error}>
        {select}
      </Field>
    );
  }
  return (
    <div className="settings-section-toggle">
      <label htmlFor={id}>{label}</label>
      {select}
      <span id={`${id}-hint`} className="sr-only">
        {hint}
      </span>
      {error && (
        <p role="alert" className="settings-inline-error">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Saves the task-type switches of `keys` (the others as saved), if any changed, then runs `save`
 * if it is given; the first failure stops it.
 */
export function saveWithTaskTypes(
  repositoryId: string,
  saved: RepositoryTaskTypesInput,
  draft: RepositoryTaskTypesInput,
  keys: readonly TaskTypeSwitch[],
  save: (() => Promise<ActionResult>) | null,
): () => Promise<ActionResult> {
  return async () => {
    if (keys.some((key) => saved[key] !== draft[key])) {
      const result = await updateRepositoryTaskTypes(repositoryId, {
        ...saved,
        ...pickKeys(draft, keys),
      });
      if (!result.ok || !save) return result;
    }
    return save ? save() : { ok: true };
  };
}
