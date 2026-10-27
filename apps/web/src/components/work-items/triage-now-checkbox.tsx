"use client";

import { Checkbox } from "@omniralph/ui";
import { useId } from "react";
import "./triage-now-checkbox.css";

export const TRIAGE_NOW_LABEL = "Triage now";
export const TRIAGE_NOW_DESCRIPTION = "Om turns it into a PRD and sizes it.";

export interface TriageNowCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

/**
 * The "Triage now" choice when a work item is created: the `Checkbox` with its description
 * (linked by `aria-describedby`). Shared by the Backlog's New work item and Ask's "Add to
 * backlog"; whoever renders it decides the default (on, in both).
 */
export function TriageNowCheckbox({ checked, onChange, disabled }: TriageNowCheckboxProps) {
  const descriptionId = useId();
  return (
    <div className="or-wi-triage-now">
      <Checkbox
        label={TRIAGE_NOW_LABEL}
        checked={checked}
        disabled={disabled}
        aria-describedby={descriptionId}
        onCheckedChange={onChange}
      />
      <p id={descriptionId} className="or-wi-triage-now__description">
        {TRIAGE_NOW_DESCRIPTION}
      </p>
    </div>
  );
}
