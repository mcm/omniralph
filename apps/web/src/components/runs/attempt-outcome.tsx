"use client";

import { Button, StatusDot, type StatusTone } from "@omniralph/ui";
import { useState } from "react";
import type { RunAttempt } from "@/lib/api/runs";
import "./run-cards.css";

type AttemptStatus = RunAttempt["status"];

/** Each attempt status as its dot names it, and the dot's tone (Design rule 15). */
export const ATTEMPT_STATUS: Record<AttemptStatus, { label: string; tone: StatusTone }> = {
  queued: { label: "Queued", tone: "run" },
  running: { label: "Running", tone: "run" },
  completed: { label: "Finished", tone: "good" },
  failed: { label: "Failed", tone: "fail" },
  canceled: { label: "Canceled", tone: "neutral" },
  expired: { label: "Expired", tone: "fail" },
  skipped: { label: "Skipped", tone: "neutral" },
};

/** Error lines shown before "Show all". */
export const ERROR_PREVIEW_LINES = 20;

export interface AttemptOutcomeProps {
  /** An attempt, or what stands for one (a system attempt outside a run). */
  attempt: Pick<RunAttempt, "status" | "label" | "error">;
  className?: string;
}

/**
 * What an attempt came to: its status dot, its `label` (what it did, in plain language) and
 * its error in mono, the first 20 lines and then "Show all".
 */
export function AttemptOutcome({ attempt, className }: AttemptOutcomeProps) {
  const [expanded, setExpanded] = useState(false);
  const status = ATTEMPT_STATUS[attempt.status];
  const lines = attempt.error?.replace(/\s+$/, "").split("\n") ?? [];
  const truncated = !expanded && lines.length > ERROR_PREVIEW_LINES;
  const shown = truncated ? lines.slice(0, ERROR_PREVIEW_LINES) : lines;
  return (
    <div className={["or-attempt-outcome", className].filter(Boolean).join(" ")}>
      <p className="or-attempt-outcome__label">
        <StatusDot tone={status.tone} label={status.label} />
        <span>{attempt.label}</span>
      </p>
      {lines.length > 0 && lines.some(Boolean) ? (
        <pre className="or-attempt-outcome__error or-mono">{shown.join("\n")}</pre>
      ) : null}
      {truncated ? (
        <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
          Show all
        </Button>
      ) : null}
    </div>
  );
}
