"use client";

import { activityDate, AgentBadge, Button, ConfirmDialog, IconButton } from "@omniralph/ui";
import { IconPlayerStop } from "@tabler/icons-react";
import { useState } from "react";
import type { RunAttempt } from "@/lib/api/runs";
import { agentHref } from "@/lib/runs/hrefs";
import { useClock } from "@/screens/clock";
import { AttemptOutcome } from "./attempt-outcome";
import { tokensText } from "./details";
import { formatDuration } from "./progress";
import { isLiveAttempt } from "./step-attempts";
import { useAttemptCancel } from "./use-run-actions";
import "./step-panel.css";

/** Shown on an attempt whose cancel its agent hasn't confirmed yet. */
export const CANCEL_REQUESTED = "Cancel requested";

/** How long the attempt ran (so far, while it runs); null before it started. */
export function attemptDuration(
  attempt: Pick<RunAttempt, "startedAt" | "finishedAt">,
  now: number,
): string | null {
  if (!attempt.startedAt) return null;
  const end = attempt.finishedAt ? Date.parse(attempt.finishedAt) : now;
  return formatDuration(Math.max(0, end - Date.parse(attempt.startedAt)));
}

export interface AttemptListProps {
  runId: string;
  /** The step's attempts, newest first. */
  attempts: readonly RunAttempt[];
  /** The attempt whose transcript shows. */
  selectedAttemptId: string | undefined;
  /** Shows the attempt's transcript. */
  onSelect: (attemptId: string) => void;
}

/**
 * A step's attempts, newest first: each one's outcome (`AttemptOutcome`), agent, start time,
 * duration and tokens, and a button that shows its transcript. A queued or running attempt
 * has a "Cancel attempt" icon button that asks to confirm; the attempt reads "Cancel
 * requested" before the server answers, and until its agent confirms (the attempt ends).
 */
export function AttemptList({ runId, attempts, selectedAttemptId, onSelect }: AttemptListProps) {
  const now = useClock();
  const cancel = useAttemptCancel(runId);
  const [confirming, setConfirming] = useState<string | null>(null);

  if (attempts.length === 0) return <p className="or-step-panel__empty">No attempts yet.</p>;
  return (
    <>
      <ol className="or-attempts" aria-label="Attempts">
        {attempts.map((attempt) => {
          const selected = attempt.id === selectedAttemptId;
          const duration = attemptDuration(attempt, now);
          const started = attempt.startedAt ?? attempt.createdAt;
          // The flag stays on a job its agent canceled: only a live attempt still waits.
          const cancelPending = attempt.cancelRequested && isLiveAttempt(attempt);
          return (
            <li
              key={attempt.id}
              className={["or-attempt", selected ? "or-attempt--selected" : undefined]
                .filter(Boolean)
                .join(" ")}
              aria-current={selected ? "true" : undefined}
            >
              <div className="or-attempt__main">
                <AttemptOutcome attempt={attempt} />
                <div className="or-attempt__meta">
                  {attempt.agent ? (
                    <AgentBadge name={attempt.agent.name} href={agentHref(attempt.agent.id)} />
                  ) : null}
                  <time className="or-mono" dateTime={started}>
                    {activityDate(started)}
                  </time>
                  {duration ? <span className="or-mono">{duration}</span> : null}
                  <span className="or-mono">{tokensText(attempt.tokens)}</span>
                  {cancelPending ? (
                    <span className="or-attempt__cancel-requested">{CANCEL_REQUESTED}</span>
                  ) : null}
                </div>
              </div>
              <div className="or-attempt__actions">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-pressed={selected}
                  onClick={() => onSelect(attempt.id)}
                >
                  Show transcript
                </Button>
                {isLiveAttempt(attempt) && !attempt.cancelRequested ? (
                  <IconButton
                    label="Cancel attempt"
                    icon={IconPlayerStop}
                    size="sm"
                    onClick={() => setConfirming(attempt.id)}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title="Cancel this attempt?"
        description="Om stops working on it. A running attempt stops with its agent's next heartbeat."
        confirmLabel="Cancel attempt"
        cancelLabel="Keep it running"
        destructive
        onConfirm={() => {
          if (confirming) cancel.mutate({ attemptId: confirming });
        }}
      />
    </>
  );
}
