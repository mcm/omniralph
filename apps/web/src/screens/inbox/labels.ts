import type { StatusTone } from "@omniralph/ui";
import { RUN_KIND_LABELS } from "@/components/runs/run-kind";
import { RUN_STATUS_TONES } from "@/components/runs/run-status";
import type { InboxItem, PR_REVIEW_STATES } from "@/lib/api/inbox";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function elapsed(since: string, now: number): number {
  return Math.max(0, now - new Date(since).getTime());
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** The age of `since` in a row's time column: "now", "42m", "1h", "15d". */
export function compactAge(since: string, now: number): string {
  const ms = elapsed(since, now);
  if (ms < MINUTE) return "now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

/** How long since `since`, in words: "less than a minute", "42 minutes", "1 hour", "15 days". */
export function durationSince(since: string, now: number): string {
  const ms = elapsed(since, now);
  if (ms < MINUTE) return "less than a minute";
  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), "minute");
  if (ms < DAY) return plural(Math.floor(ms / HOUR), "hour");
  return plural(Math.floor(ms / DAY), "day");
}

/** When `since` was, relative to now: "just now", "5 minutes ago", "3 days ago". */
export function relativeSince(since: string, now: number): string {
  const ms = elapsed(since, now);
  return ms < MINUTE ? "just now" : `${durationSince(since, now)} ago`;
}

/** When `at` will be, relative to now: "in 2 hours", "in less than a minute" (also once past). */
export function relativeUntil(at: string, now: number): string {
  return `in ${durationSince(new Date(now).toISOString(), new Date(at).getTime())}`;
}

export interface InboxItemLabel {
  /** The row's kind and state (Design rule 8), e.g. "Epic · manual story"; it also names the dot. */
  rowLabel: string;
  /** The row dot's and status line's tone. */
  tone: StatusTone;
  /** The status line, e.g. "Waiting on you for 15 days". */
  statusLine: string;
}

function kindOf(item: InboxItem): string {
  return item.run ? RUN_KIND_LABELS[item.run.kind] : "Run";
}

/** Whether the item's code host is GitLab (merge requests) rather than GitHub (pull requests). */
export function isGitLab(item: Pick<InboxItem, "pullRequest" | "repository">): boolean {
  return (item.pullRequest?.provider ?? item.repository?.provider) === "gitlab";
}

/** A PR/MR's human review state as its row label's state word. */
export const REVIEW_STATE_WORDS: Readonly<Record<(typeof PR_REVIEW_STATES)[number], string>> = {
  none: "waiting for review",
  review_requested: "review requested",
  commented: "commented",
  changes_requested: "changes requested",
  approved: "approved",
};

/**
 * An Inbox item's row label, tone and status line (the epic's "Inbox behavior" table): what
 * waits on a person is lavender ("Waiting on you for …"), failures and offline agents are
 * coral, running runs are mint. `now` is the current time in ms.
 */
export function inboxItemLabel(item: InboxItem, now: number): InboxItemLabel {
  const waiting = (rowLabel: string): InboxItemLabel => ({
    rowLabel,
    tone: "need",
    statusLine: `Waiting on you for ${durationSince(item.since, now)}`,
  });
  const failed = (rowLabel: string, statusLine: string): InboxItemLabel => ({
    rowLabel,
    tone: "fail",
    statusLine,
  });
  switch (item.kind) {
    case "manual_story":
      return waiting("Epic · manual story");
    case "blocked_epic":
      return waiting("Epic · blocked");
    case "question":
      return waiting(`${kindOf(item)} · question`);
    case "stopped_epic":
      return waiting(`${kindOf(item)} · stopped`);
    case "prd_ready":
      return waiting("Triage · PRD ready");
    case "pr_waiting":
      return waiting(
        `${isGitLab(item) ? "Merge request" : "Pull request"} · ${REVIEW_STATE_WORDS[item.reviewState ?? "none"]}`,
      );
    case "failed_run":
      return failed(`${kindOf(item)} · failed`, `Failed ${relativeSince(item.since, now)}`);
    case "failed_system":
      return failed("Background work · failed", `Failed ${relativeSince(item.since, now)}`);
    case "agent_offline":
      return failed("Agent · offline", `Offline for ${durationSince(item.since, now)}`);
    case "agent_update_failed":
      return failed(
        "Agent · update failed",
        item.version
          ? `Update to ${item.version} failed ${relativeSince(item.since, now)}`
          : `Update failed ${relativeSince(item.since, now)}`,
      );
    case "run":
      // The Running tab has queued runs too (waiting for an agent): say so, not "running".
      return item.run?.status === "queued"
        ? {
            rowLabel: `${kindOf(item)} · queued`,
            tone: RUN_STATUS_TONES.queued,
            statusLine: `Queued for ${durationSince(item.since, now)}`,
          }
        : {
            rowLabel: `${kindOf(item)} · running`,
            tone: "run",
            statusLine: `Running for ${durationSince(item.since, now)}`,
          };
  }
}
