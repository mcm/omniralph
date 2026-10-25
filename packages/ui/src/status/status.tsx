import type { ReactNode } from "react";

/**
 * What a state means (Design rule 15): `need` (lavender, needs you), `run` and `good`
 * (mint; `run` glows), `fail` (coral) and `neutral` (everything else).
 */
export type StatusTone = "need" | "run" | "good" | "fail" | "neutral";

export const STATUS_TONES: readonly StatusTone[] = ["need", "run", "good", "fail", "neutral"];

export interface StatusDotProps {
  tone: StatusTone;
  /** Required: the dot's accessible name, e.g. "Running". */
  label: string;
  className?: string;
}

/** A colored dot on its own, named by `label`. */
export function StatusDot({ tone, label, className }: StatusDotProps) {
  return (
    <span
      className={["or-dot", `or-dot--${tone}`, className].filter(Boolean).join(" ")}
      role="img"
      aria-label={label}
    />
  );
}

export interface StatusTextProps {
  tone: StatusTone;
  /** The visible label next to the dot. */
  children: ReactNode;
  className?: string;
}

/** A dot followed by its label, both in the tone's color. */
export function StatusText({ tone, children, className }: StatusTextProps) {
  return (
    <span className={["or-status", `or-status--${tone}`, className].filter(Boolean).join(" ")}>
      <span className={`or-dot or-dot--${tone}`} aria-hidden="true" />
      {children}
    </span>
  );
}
