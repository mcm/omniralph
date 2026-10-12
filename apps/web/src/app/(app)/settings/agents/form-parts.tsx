/** Form pieces shared by the agent and task forms. */
import { Checkbox, Label } from "@iamthemcmaster/ui";
import type { FieldErrors } from "@omniralph/shared";

export const monoInput = { fontFamily: "var(--font-mono)" } as const;

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
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-4)" }}>
      {options.map((option) => (
        <div key={option} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <Checkbox
            id={`${id}-${option}`}
            checked={value.includes(option)}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(toggled(value, option, checked === true))}
          />
          <Label htmlFor={`${id}-${option}`} style={monoInput}>
            {option}
          </Label>
        </div>
      ))}
    </div>
  );
}
