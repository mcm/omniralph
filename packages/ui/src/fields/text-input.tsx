"use client";

import type {
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { IconChevronDown } from "@tabler/icons-react";
import { useControlIds } from "./field-context.js";
import { FieldError } from "./field-error.js";

type ValidationProps = {
  /** Marks the value invalid (`aria-invalid`). Defaults to true when `errorMessage` is set. */
  invalid?: boolean;
  /** Shown under the control and linked by `aria-describedby`. */
  errorMessage?: ReactNode;
  /** Geist Mono, for machine facts (paths, branches, IDs). */
  mono?: boolean;
};

const classes = (base: string, mono: boolean | undefined, className: string | undefined) =>
  [base, mono && "or-input--mono", className].filter(Boolean).join(" ");

export type TextInputProps = ValidationProps & {
  ref?: Ref<HTMLInputElement>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "children" | "aria-invalid">;

/** A one-line text field. Inside a `Field`, the Field's label names it. */
export function TextInput(props: TextInputProps) {
  const {
    invalid,
    errorMessage,
    mono,
    className,
    id: idProp,
    "aria-describedby": describedByProp,
    type = "text",
    ...rest
  } = props;
  const ids = useControlIds({
    id: idProp,
    describedBy: describedByProp,
    invalid,
    hasError: errorMessage != null,
  });
  return (
    <>
      <input
        {...rest}
        type={type}
        id={ids.id}
        aria-invalid={ids.invalid}
        aria-describedby={ids.describedBy}
        className={classes("or-input", mono, className)}
      />
      {errorMessage == null ? null : <FieldError id={ids.errorId}>{errorMessage}</FieldError>}
    </>
  );
}

export type TextareaProps = ValidationProps & {
  ref?: Ref<HTMLTextAreaElement>;
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "children" | "aria-invalid">;

/** A multi-line text field. */
export function Textarea(props: TextareaProps) {
  const {
    invalid,
    errorMessage,
    mono,
    className,
    id: idProp,
    "aria-describedby": describedByProp,
    rows = 4,
    ...rest
  } = props;
  const ids = useControlIds({
    id: idProp,
    describedBy: describedByProp,
    invalid,
    hasError: errorMessage != null,
  });
  return (
    <>
      <textarea
        {...rest}
        rows={rows}
        id={ids.id}
        aria-invalid={ids.invalid}
        aria-describedby={ids.describedBy}
        className={classes("or-input or-textarea", mono, className)}
      />
      {errorMessage == null ? null : <FieldError id={ids.errorId}>{errorMessage}</FieldError>}
    </>
  );
}

export type SelectProps = ValidationProps & {
  /** `<option>` (and `<optgroup>`) elements. */
  children: ReactNode;
  ref?: Ref<HTMLSelectElement>;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "children" | "aria-invalid" | "multiple">;

/** A styled native `<select>`, so the platform picker and keyboard behavior stay. */
export function Select(props: SelectProps) {
  const {
    invalid,
    errorMessage,
    mono,
    className,
    id: idProp,
    "aria-describedby": describedByProp,
    children,
    ...rest
  } = props;
  const ids = useControlIds({
    id: idProp,
    describedBy: describedByProp,
    invalid,
    hasError: errorMessage != null,
  });
  return (
    <>
      <span className="or-select">
        <select
          {...rest}
          id={ids.id}
          aria-invalid={ids.invalid}
          aria-describedby={ids.describedBy}
          className={classes("or-input or-select__control", mono, className)}
        >
          {children}
        </select>
        <IconChevronDown className="or-select__chevron" size={16} stroke={1.75} aria-hidden />
      </span>
      {errorMessage == null ? null : <FieldError id={ids.errorId}>{errorMessage}</FieldError>}
    </>
  );
}
