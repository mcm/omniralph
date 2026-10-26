"use client";

import * as RadioGroup from "@radix-ui/react-radio-group";
import { useId, type ReactNode, type Ref } from "react";

export interface RadioListOption<Value extends string = string> {
  value: Value;
  /** The option's label: text, or a reference badge (e.g. a repo with its code-host mark). */
  label: ReactNode;
  disabled?: boolean;
}

export interface RadioListProps<Value extends string = string> {
  /** The group's visible label; it names the `radiogroup`. */
  label: ReactNode;
  /** Shown beside the label without joining the group's name (e.g. "Expires in 2 hours"). */
  aside?: ReactNode;
  options: readonly RadioListOption<Value>[];
  value?: Value;
  defaultValue?: Value;
  onValueChange?: (value: Value) => void;
  /** Draws the option labels in the mono face (paths, branches, commands). */
  mono?: boolean;
  disabled?: boolean;
  /** Submits the chosen value under this name inside a `<form>`. */
  name?: string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/**
 * One-of-N choice as a vertical list of radios under a visible label (Radix radio group):
 * one tab stop, Up and Down arrows move to and select the previous or next option
 * (wrapping), and disabled options are skipped. Clicking an option's label selects it.
 */
export function RadioList<Value extends string = string>(props: RadioListProps<Value>) {
  const {
    label,
    aside,
    options,
    value,
    defaultValue,
    onValueChange,
    mono = false,
    disabled,
    name,
    className,
    ref,
  } = props;
  const id = useId();
  const labelId = `${id}-label`;

  return (
    <div className={["or-radio-list", className].filter(Boolean).join(" ")}>
      <div className="or-radio-list__head">
        <div id={labelId} className="or-radio-list__label">
          {label}
        </div>
        {aside ? <div className="or-radio-list__aside">{aside}</div> : null}
      </div>
      <RadioGroup.Root
        ref={ref}
        aria-labelledby={labelId}
        orientation="vertical"
        loop
        value={value}
        defaultValue={defaultValue}
        onValueChange={(next) => onValueChange?.(next as Value)}
        disabled={disabled}
        name={name}
        className={["or-radio-list__options", mono && "or-radio-list__options--mono"]
          .filter(Boolean)
          .join(" ")}
      >
        {options.map((option, index) => {
          const itemId = `${id}-${index}`;
          return (
            <div
              key={option.value}
              className="or-radio-list__option"
              data-disabled={option.disabled || disabled ? "" : undefined}
            >
              <RadioGroup.Item
                id={itemId}
                value={option.value}
                disabled={option.disabled}
                className="or-radio"
              >
                <RadioGroup.Indicator className="or-radio__dot" />
              </RadioGroup.Item>
              <label htmlFor={itemId} className="or-radio-list__option-label">
                {option.label}
              </label>
            </div>
          );
        })}
      </RadioGroup.Root>
    </div>
  );
}
