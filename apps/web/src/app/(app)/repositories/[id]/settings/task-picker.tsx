"use client";

import { Field, NativeSelect } from "@iamthemcmaster/ui";

/** A task a repository setting can pick (built-in or the organization's own). */
export interface TaskChoiceOption {
  id: string;
  name: string;
  builtin: boolean;
}

/**
 * A select of tasks of one kind. A current value that isn't offered (since
 * deleted, or no longer of the right kind) stays selectable so its error shows.
 */
export function TaskPicker({
  id,
  label,
  hint,
  value,
  choices,
  disabled,
  error,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  choices: readonly TaskChoiceOption[];
  disabled: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  const unlisted = value !== "" && !choices.some((task) => task.id === value);
  return (
    <Field label={label} htmlFor={id} description={hint} error={error} required>
      <NativeSelect
        id={id}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {unlisted && <option value={value}>{value}</option>}
        {choices.map((task) => (
          <option key={task.id} value={task.id}>
            {task.builtin ? `${task.name} (built-in)` : task.name}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}
