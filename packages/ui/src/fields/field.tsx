"use client";

import { useId, type ReactNode } from "react";
import { FieldContext } from "./field-context.js";

export type FieldProps = {
  /** The visible label, a `<label for>` the control. */
  label: ReactNode;
  /** One line on what the setting does. Linked to the control by `aria-describedby`. */
  description?: ReactNode;
  /** The control's id. Defaults to a generated one the control picks up from the Field. */
  htmlFor?: string;
  /** One control: `TextInput`, `Textarea`, `Select` or `TokenInput`. */
  children: ReactNode;
  className?: string;
};

/**
 * A setting row: label and description on the left (200 px), the control on the right.
 * Collapses to one column at 768 px and narrower.
 */
export function Field({ label, description, htmlFor, children, className }: FieldProps) {
  const generatedId = useId();
  const controlId = htmlFor ?? `${generatedId}-control`;
  const descriptionId = description === undefined ? undefined : `${generatedId}-description`;

  return (
    <div className={["or-field", className].filter(Boolean).join(" ")}>
      <div className="or-field__head">
        <label htmlFor={controlId} className="or-field__label">
          {label}
        </label>
        {description === undefined ? null : (
          <p id={descriptionId} className="or-field__description">
            {description}
          </p>
        )}
      </div>
      <div className="or-field__control">
        <FieldContext value={{ controlId, descriptionId }}>{children}</FieldContext>
      </div>
    </div>
  );
}
