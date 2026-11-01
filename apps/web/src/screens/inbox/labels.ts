import type { StatusTone } from "@omniralph/ui";
import type { InboxItem } from "@/lib/api/inbox";
import type { RUN_KINDS } from "@/lib/api/runs";

type RunKind = (typeof RUN_KINDS)[number];

/** Each run kind as a row label names it. */
export const RUN_KIND_LABELS: Readonly<Record<RunKind, string>> = {
  epic: "Epic",
  request: "Request",
  review: "Review",
  triage: "Triage",
  ask: "Ask",
};

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
  /**
   * The line above the row's title: why the item is here ("Question", "Failed", "Agent
   * offline"); null when the dot already says it (a running run). What the item is shows in
   * its avatar.
   */
  rowLabel: string | null;
  /** Names the row's dot: what the item is and its state, e.g. "Review, failed". */
  statusLabel: string;
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

/**
 * An Inbox item's row label (why it's here), its dot's name and tone, and its status line (the
 * epic's "Inbox behavior" table, Design rule 15): what waits on a person is lavender with a
 * halo ("Waiting on you for …"), except a stopped epic, which waits on you in amber (stopped,
 * not live); failures and offline agents are coral, running runs are lavender. `now` is the
 * current time in ms.
 */
export function inboxItemLabel(item: InboxItem, now: number): InboxItemLabel {
  const kind = kindOf(item);
  const waiting = (rowLabel: string, subject = kind): InboxItemLabel => ({
    rowLabel,
    statusLabel: `${subject}, waiting on you`,
    tone: "need",
    statusLine: `Waiting on you for ${durationSince(item.since, now)}`,
  });
  const failed = (rowLabel: string, statusLabel: string, statusLine: string): InboxItemLabel => ({
    rowLabel,
    statusLabel,
    tone: "fail",
    statusLine,
  });
  switch (item.kind) {
    case "manual_story":
      return waiting("Manual story", "Epic");
    case "blocked_epic":
      return waiting("Blocked", "Epic");
    case "broken_relations":
      return waiting("Relations to fix", "Epic");
    case "question":
      return waiting("Question");
    case "stopped_epic":
      return { ...waiting("Stopped"), statusLabel: `${kind}, stopped`, tone: "warn" };
    case "prd_ready":
      return waiting("PRD ready", "Triage");
    case "pr_waiting":
      return waiting(isGitLab(item) ? "MR ready for your review" : "PR ready for your review");
    case "failed_run":
      return failed("Failed", `${kind}, failed`, `Failed ${relativeSince(item.since, now)}`);
    case "failed_system":
      return failed(
        "Failed",
        "Background work, failed",
        `Failed ${relativeSince(item.since, now)}`,
      );
    case "agent_offline":
      return failed(
        "Agent offline",
        "Agent, offline",
        `Offline for ${durationSince(item.since, now)}`,
      );
    case "agent_update_failed":
      return failed(
        "Agent update failed",
        "Agent, update failed",
        item.version
          ? `Update to ${item.version} failed ${relativeSince(item.since, now)}`
          : `Update failed ${relativeSince(item.since, now)}`,
      );
    case "run":
      return {
        rowLabel: null,
        statusLabel: `${kind}, running`,
        tone: "run",
        statusLine: `Running for ${durationSince(item.since, now)}`,
      };
  }
}

/** The open findings of a PR/MR's latest AI review, all severities. */
export function openFindingsCount(item: Pick<InboxItem, "review">): number {
  const counts = item.review?.openFindings;
  return counts ? counts.critical + counts.high + counts.medium + counts.low + counts.info : 0;
}
