"use client";

import { IconCheck, IconMinus } from "@tabler/icons-react";
import {
  useCallback,
  useEffect,
  useRef,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";

type CheckboxLabel =
  | {
      /** The visible label; clicking it toggles the box. */ label: ReactNode;
      "aria-label"?: undefined;
    }
  | {
      label?: undefined;
      /** Names the box when it has no visible label (e.g. a table row). */ "aria-label": string;
    };

export type CheckboxProps = CheckboxLabel & {
  checked?: boolean;
  defaultChecked?: boolean;
  /** Shows the mixed state and sets the DOM `indeterminate` property. */
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  ref?: Ref<HTMLInputElement>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "children" | "aria-label">;

/** A native `<input type="checkbox">` with the Ultraviolet appearance, inside its `<label>`. */
export function Checkbox(props: CheckboxProps) {
  const {
    label,
    indeterminate = false,
    onCheckedChange,
    onChange,
    className,
    ref,
    ...rest
  } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);

  const setRef = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") return ref(node);
      if (ref) ref.current = node;
    },
    [ref],
  );

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onChange?.(event);
    onCheckedChange?.(event.target.checked);
  }

  const box = (
    <span className="or-checkbox__box">
      <input
        {...rest}
        ref={setRef}
        type="checkbox"
        className="or-checkbox__input"
        aria-checked={indeterminate ? "mixed" : undefined}
        onChange={handleChange}
      />
      <span className="or-checkbox__mark" aria-hidden="true">
        <IconCheck className="or-checkbox__check" size={12} stroke={3} />
        <IconMinus className="or-checkbox__dash" size={12} stroke={3} />
      </span>
    </span>
  );

  const classes = ["or-checkbox", className].filter(Boolean).join(" ");
  if (label === undefined) return <span className={classes}>{box}</span>;
  return (
    <label className={classes} data-disabled={rest.disabled ? "" : undefined}>
      {box}
      <span className="or-checkbox__label">{label}</span>
    </label>
  );
}
