/** Form pieces shared by the agent and task forms. */
import { Checkbox, Cluster, Label } from "@iamthemcmaster/ui";
import type { FieldErrors } from "@omniralph/shared";

/** Names from a comma- or newline-separated list. */
export function splitNames(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** The error of `field` or of anything under it (`tools.builtin.2` for `tools.builtin`). */
export function errorFor(errors: FieldErrors, field: string): string | undefined {
  if (errors[field]) return errors[field];
  const nested = Object.keys(errors).find((key) => key.startsWith(`${field}.`));
  return nested && errors[nested];
}

function toggled<T>(list: readonly T[], value: T, on: boolean): T[] {
  return on
    ? [...list.filter((item) => item !== value), value]
    : list.filter((item) => item !== value);
}

/** Checkboxes choosing some of `options`. */
export function Choices<T extends string>({
  id,
  options,
  value,
  onChange,
  disabled,
}: {
  id: string;
  options: readonly T[];
  value: readonly T[];
  onChange: (value: T[]) => void;
  disabled: boolean;
}) {
  return (
    <Cluster gap={4}>
      {options.map((option) => (
        <div key={option} className="settings-check settings-check-center">
          <Checkbox
            id={`${id}-${option}`}
            checked={value.includes(option)}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(toggled(value, option, checked === true))}
          />
          <Label htmlFor={`${id}-${option}`} className="settings-mono">
            {option}
          </Label>
        </div>
      ))}
    </Cluster>
  );
}
