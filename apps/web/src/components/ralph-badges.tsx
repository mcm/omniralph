"use client";

import { Badge } from "@iamthemcmaster/ui";
import type { JobRow } from "@/lib/agents/rows";
import type { RalphRunRow, RalphStoryView } from "@/lib/ralph/display";
import {
  JOB_STATUS_VARIANTS,
  RALPH_RUN_STATUS_VARIANTS,
  RALPH_STORY_STATUS_VARIANTS,
  stateLabel,
} from "@/lib/state-variants";

// Run, story and job states share one shape: default size, a dot, live while running.

export function RalphRunStatusBadge({ status }: { status: RalphRunRow["status"] }) {
  return (
    <Badge variant={RALPH_RUN_STATUS_VARIANTS[status]} dot live={status === "running"}>
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
  // A running job asked to cancel stops after its agent's next heartbeat, which confirms it.
  if (job.status === "running" && job.cancelRequested) {
    return (
      <Badge
        variant={JOB_STATUS_VARIANTS.running}
        dot
        live
        title="Still running: it stops when its agent confirms with its next heartbeat."
      >
        Cancel requested
      </Badge>
    );
  }
  return (
    <Badge variant={JOB_STATUS_VARIANTS[job.status]} dot live={job.status === "running"}>
      {stateLabel(job.status)}
    </Badge>
  );
}
