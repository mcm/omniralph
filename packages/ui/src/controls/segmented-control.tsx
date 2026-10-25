"use client";

import { useRef, useState, type KeyboardEvent, type Ref } from "react";
import type { TablerIcon } from "@tabler/icons-react";

export interface SegmentedOption<Value extends string = string> {
  value: Value;
  label: string;
  /** An optional leading Tabler icon. */
  icon?: TablerIcon;
  disabled?: boolean;
}

export type SegmentedControlProps<Value extends string = string> = {
  options: readonly SegmentedOption<Value>[];
  value?: Value;
  defaultValue?: Value;
  onValueChange?: (value: Value) => void;
  size?: "md" | "sm";
  className?: string;
  ref?: Ref<HTMLDivElement>;
} & (
  | {
      /** Names the group for assistive tech. */ "aria-label": string;
      "aria-labelledby"?: undefined;
    }
  | { "aria-label"?: undefined; "aria-labelledby": string }
);

/**
 * One-of-N choice drawn as segments: a `radiogroup` of `radio`s with one tab stop.
 * Arrow keys move to and select the next or previous option (wrapping); Home and End select
 * the first and last. Disabled options are skipped.
 */
export function SegmentedControl<Value extends string = string>(
  props: SegmentedControlProps<Value>,
) {
  const {
    options,
    value: valueProp,
    defaultValue,
    onValueChange,
    size = "md",
    className,
    ref,
    ...labelling
  } = props;
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const value = valueProp ?? uncontrolled;
  const buttons = useRef(new Map<Value, HTMLButtonElement>());

  const enabled = options.filter((option) => !option.disabled);
  // The tab stop: the selected option, else the first enabled one.
  const tabStop = enabled.some((option) => option.value === value) ? value : enabled[0]?.value;

  function select(next: Value) {
    buttons.current.get(next)?.focus();
    if (next === value) return;
    if (valueProp === undefined) setUncontrolled(next);
    onValueChange?.(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: Value) {
    const index = enabled.findIndex((option) => option.value === current);
    if (index === -1 || enabled.length === 0) return;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % enabled.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (index - 1 + enabled.length) % enabled.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = enabled.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    select(enabled[next]!.value);
  }

  return (
    <div
      {...labelling}
      ref={ref}
      role="radiogroup"
      className={["or-seg", size === "sm" && "or-seg--sm", className].filter(Boolean).join(" ")}
    >
      {options.map(({ value: optionValue, label, icon: Icon, disabled }) => {
        const checked = optionValue === value;
        return (
          <button
            key={optionValue}
            ref={(node) => {
              if (node) buttons.current.set(optionValue, node);
              else buttons.current.delete(optionValue);
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            data-state={checked ? "checked" : "unchecked"}
            disabled={disabled}
            tabIndex={optionValue === tabStop ? 0 : -1}
            className="or-seg__option"
            onClick={() => select(optionValue)}
            onKeyDown={(event) => onKeyDown(event, optionValue)}
          >
            {Icon && <Icon size={size === "sm" ? 14 : 16} stroke={1.75} aria-hidden="true" />}
            {label}
          </button>
        );
      })}
    </div>
  );
}
