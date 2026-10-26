"use client";

import { ActivityList, Card, type HeadingLevel } from "@omniralph/ui";
import type { ReactNode } from "react";
import type { RunDetail } from "@/lib/api/runs";
import { runActivity } from "./activity";

/** A sentence with its backtick spans as code: "Routed by team `SOC`". */
function sentence(text: string): ReactNode {
  const parts = text.split("`");
  if (parts.length < 3) return text;
  return parts.map((part, index) =>
    index % 2 === 1 && index < parts.length - 1 ? (
      <code key={index} className="or-mono">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

export interface RunActivityProps {
  run: RunDetail;
  /** Why a waiting, stopped or failed run is where it is. */
  reason: string | null;
  headingLevel?: HeadingLevel;
  className?: string;
}

/** A run's activity card: `runActivity`'s sentences, newest first, through `ActivityList`. */
export function RunActivity({ run, reason, headingLevel, className }: RunActivityProps) {
  const entries = runActivity(run, reason).map((entry) => ({
    ...entry,
    text: sentence(entry.text),
  }));
  return (
    <Card title="Activity" headingLevel={headingLevel} className={className}>
      <ActivityList entries={entries} aria-label="Run activity" />
    </Card>
  );
}
