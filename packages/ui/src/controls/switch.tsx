"use client";

import { useId, useState, type ButtonHTMLAttributes, type MouseEvent, type Ref } from "react";

type SwitchLabel =
  | { /** A visible label, associated with the switch. */ label: string; "aria-label"?: undefined }
  | {
      label?: undefined;
      /** Names the switch when it has no visible label. */ "aria-label": string;
    }
  | { label?: undefined; "aria-label"?: undefined; "aria-labelledby": string };

export type SwitchProps = SwitchLabel & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
} & Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "role" | "type" | "children" | "aria-checked" | "aria-label" | "onChange" | "defaultChecked"
  >;

/**
 * An on/off setting: a `<button role="switch" aria-checked>`. Click, Space and Enter toggle
 * it (native button activation). Controlled with `checked`, or uncontrolled with
 * `defaultChecked`.
 */
export function Switch(props: SwitchProps) {
  const {
    label,
    checked: checkedProp,
    defaultChecked = false,
    onCheckedChange,
    className,
    id: idProp,
    onClick,
    ...rest
  } = props;
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const [uncontrolled, setUncontrolled] = useState(defaultChecked);
  const checked = checkedProp ?? uncontrolled;

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    onClick?.(event);
    if (event.defaultPrevented || rest.disabled) return;
    const next = !checked;
    if (checkedProp === undefined) setUncontrolled(next);
    onCheckedChange?.(next);
  }

  const button = (
    <button
      {...rest}
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? "on" : "off"}
      className={["or-switch", className].filter(Boolean).join(" ")}
      onClick={handleClick}
    >
      <span className="or-switch__thumb" aria-hidden="true" />
    </button>
  );

  if (label === undefined) return button;
  return (
    <span className="or-switch-field" data-disabled={rest.disabled ? "" : undefined}>
      {button}
      <label htmlFor={id} className="or-switch-field__label">
        {label}
      </label>
    </span>
  );
}
