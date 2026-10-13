"use client";

import * as React from "react";
import Link from "next/link";
import { Field, NativeSelect } from "@iamthemcmaster/ui";
import {
  fieldErrors as toFieldErrors,
  RepositoryTaskTypesInput,
  type FieldErrors,
} from "@omniralph/shared";
import { SettingsCard } from "@/components/settings-card";
import { formatSettingValue, settingChanges, type SettingSpec } from "@/lib/settings/changes";
import { updateRepositoryTaskTypes } from "./actions";

/** A repository's task-type switches. */
export type TaskTypeSwitch = keyof RepositoryTaskTypesInput;

/** The card's values: the repository's own switches (null inherits) and the organization's. */
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

/** The switches in the order the card shows them. */
export const TASK_TYPE_SWITCHES: readonly { key: TaskTypeSwitch; label: string; hint: string }[] = [
  {
    key: "query",
    label: "Query",
    hint: "Answer @mentions, chat questions and Linear triage about this repository. Omniralph's own queries (correlating review findings, describing pull requests) always run.",
  },
  {
    key: "review",
    label: "Reviews",
    hint: "Review its pull and merge requests when the triggers below fire.",
  },
  {
    key: "coding",
    label: "Coding",
    hint: "Build delegated Linear issues and handle requests here, pushing branches to it.",
  },
];

/** "Use organization default (On)": the inherit choice, showing the inherited value. */
export function inheritLabel(inherited: boolean): string {
  return `Use organization default (${formatSettingValue(inherited)})`;
}

/**
 * Repository › Settings › Task types: Query, Reviews and Coding, each the organization's
 * default (Settings › Harnesses), on or off.
 */
export function TaskTypesCard({
  repositoryId,
  values,
  readOnly,
}: {
  repositoryId: string;
  values: TaskTypesValues;
  readOnly: boolean;
}) {
  const saved = values.overrides;
  const [draft, setDraft] = React.useState(saved);
  const [errors, setErrors] = React.useState<FieldErrors>({});

  const specs = TASK_TYPE_SWITCHES.map(({ key, label }): SettingSpec<TaskTypeSwitch> => ({
    key,
    label,
    format: (value) =>
      value === null ? inheritLabel(values.inherited[key]) : formatSettingValue(value),
  }));

  return (
    <SettingsCard
      title="Task types"
      description={
        <>
          Which kinds of task Omniralph runs for this repository. Each uses the organization&apos;s
          default unless it&apos;s turned on or off here.
          {!readOnly && (
            <>
              {" "}
              Change the defaults in{" "}
              <Link href="/settings/harnesses" className="settings-link">
                Settings › Harnesses
              </Link>
              .
            </>
          )}
        </>
      }
      confirm={{
        consequence:
          "New mentions, chat questions, reviews and delegations of this repository use the new values. Queued and running jobs keep going.",
      }}
      readOnly={readOnly}
      changes={settingChanges(specs, saved, draft)}
      onDiscard={() => {
        setDraft(saved);
        setErrors({});
      }}
      prepare={() => {
        const parsed = RepositoryTaskTypesInput.safeParse(draft);
        if (!parsed.success) {
          setErrors(toFieldErrors(parsed.error));
          return null;
        }
        return {
          action: () => updateRepositoryTaskTypes(repositoryId, parsed.data),
          success: "Task types saved",
          onSuccess: () => setErrors({}),
          onError: (result: { fieldErrors?: FieldErrors }) => setErrors(result.fieldErrors ?? {}),
        };
      }}
    >
      {TASK_TYPE_SWITCHES.map(({ key, label, hint }) => (
        <Field
          key={key}
          label={label}
          htmlFor={`task-type-${key}`}
          description={hint}
          error={errors[key]}
        >
          <NativeSelect
            id={`task-type-${key}`}
            value={taskTypeChoice(draft[key])}
            disabled={readOnly}
            onChange={(e) =>
              setDraft((d) => ({ ...d, [key]: taskTypeValue(e.target.value as TaskTypeChoice) }))
            }
          >
            <option value="inherit">{inheritLabel(values.inherited[key])}</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </NativeSelect>
        </Field>
      ))}
    </SettingsCard>
  );
}
