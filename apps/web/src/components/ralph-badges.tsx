"use client";

import { Badge } from "@iamthemcmaster/ui";
import type { RalphRunRow, RalphStoryView } from "@/lib/ralph/display";
import { RALPH_RUN_STATUS_VARIANTS, RALPH_STORY_STATUS_VARIANTS } from "@/lib/state-variants";

export function RalphRunStatusBadge({ status }: { status: RalphRunRow["status"] }) {
  return (
    <Badge variant={RALPH_RUN_STATUS_VARIANTS[status]} dot live={status === "running"}>
      {status}
    </Badge>
  );
}

export function RalphStoryStatusBadge({ status }: { status: RalphStoryView["status"] }) {
  return (
    <Badge variant={RALPH_STORY_STATUS_VARIANTS[status]} size="sm" live={status === "running"}>
      {status}
    </Badge>
  );
}
