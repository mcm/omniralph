"use client";

import { Badge } from "@iamthemcmaster/ui";
import type { RalphRunRow, RalphStoryView } from "@/lib/ralph/display";

type Variant = "success" | "warning" | "info" | "danger" | "neutral" | "emphasis" | "outline";

/** One mapping for every page that shows ralph run statuses. */
export const RALPH_RUN_STATUS_BADGES: Record<RalphRunRow["status"], Variant> = {
  pending: "neutral",
  running: "info",
  waiting: "warning",
  completed: "success",
  failed: "danger",
  stopped: "outline",
};

/** One mapping for every page that shows ralph story statuses. */
export const RALPH_STORY_STATUS_BADGES: Record<RalphStoryView["status"], Variant> = {
  pending: "neutral",
  running: "info",
  completed: "success",
  blocked: "warning",
  exhausted: "danger",
  manual: "emphasis",
  canceled: "outline",
};

export function RalphRunStatusBadge({ status }: { status: RalphRunRow["status"] }) {
  return (
    <Badge variant={RALPH_RUN_STATUS_BADGES[status]} dot live={status === "running"}>
      {status}
    </Badge>
  );
}

export function RalphStoryStatusBadge({ status }: { status: RalphStoryView["status"] }) {
  return (
    <Badge variant={RALPH_STORY_STATUS_BADGES[status]} size="sm" live={status === "running"}>
      {status}
    </Badge>
  );
}
