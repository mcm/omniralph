"use client";

import { Badge } from "@iamthemcmaster/ui";
import type { JobRow } from "@/lib/harnesses/rows";
import type { RalphRunRow, RalphStoryView } from "@/lib/ralph/display";
import type { TriageRunStatus } from "@/lib/triage/display";
import {
  JOB_STATUS_VARIANTS,
  RALPH_RUN_STATUS_VARIANTS,
  RALPH_STORY_STATUS_VARIANTS,
  stateLabel,
  TRIAGE_RUN_STATUS_VARIANTS,
} from "@/lib/state-variants";

// Run, story and job states share one shape: default size, a dot, live while running.

export function RalphRunStatusBadge({ status }: { status: RalphRunRow["status"] }) {
  return (
    <Badge variant={RALPH_RUN_STATUS_VARIANTS[status]} dot live={status === "running"}>
      {stateLabel(status)}
    </Badge>
  );
}

export function TriageRunStatusBadge({ status }: { status: TriageRunStatus }) {
  return (
    <Badge variant={TRIAGE_RUN_STATUS_VARIANTS[status]} dot live={status === "running"}>
      {stateLabel(status)}
    </Badge>
  );
}

export function RalphStoryStatusBadge({ status }: { status: RalphStoryView["status"] }) {
  return (
    <Badge variant={RALPH_STORY_STATUS_VARIANTS[status]} dot live={status === "running"}>
      {stateLabel(status)}
    </Badge>
  );
}

export function JobStatusBadge({
  job,
}: {
  job: Pick<JobRow, "status"> & { cancelRequested?: boolean };
}) {
  return (
    <Badge variant={JOB_STATUS_VARIANTS[job.status]} dot live={job.status === "running"}>
      {stateLabel(job.status)}
      {job.status === "running" && job.cancelRequested ? " (canceling)" : ""}
    </Badge>
  );
}
