"use client";

import { StatusLine } from "@omniralph/ui";
import type { AskChatDetail } from "@/lib/api/ask";
import { fileCount, repoShortName } from "./format";
import "./ask-messages.css";

export interface AskActivityLineProps {
  activity: NonNullable<AskChatDetail["activity"]>;
}

/** The sentence for a chat's ask in flight. */
export function askActivityText(activity: AskActivityLineProps["activity"]): string {
  const repo = activity.repository ? repoShortName(activity.repository.fullPath) : "the code";
  if (activity.state === "queued") return `Waiting for an agent to read ${repo}`;
  const reading = `Om is reading ${repo}`;
  return activity.filesRead > 0 ? `${reading} · ${fileCount(activity.filesRead)}` : reading;
}

/**
 * The line a chat ends with while an ask runs: "Om is reading customer-portal · 3 files",
 * or "Waiting for an agent to read customer-portal" while no agent has taken it.
 */
export function AskActivityLine({ activity }: AskActivityLineProps) {
  return (
    <StatusLine tone="run" className="or-ask-activity">
      {askActivityText(activity)}
    </StatusLine>
  );
}
