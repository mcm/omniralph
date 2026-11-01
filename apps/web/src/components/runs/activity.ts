import type { RunDetail } from "@/lib/api/runs";
import { trackerLabel } from "@/lib/api/trackers";

export interface RunActivityEntry {
  id: string;
  at: string;
  /** A sentence (Design rule 4). Backticks mark code (a team key, a label). */
  text: string;
}

/** How each kind of run is named in a sentence. */
const KIND_NAMES: Record<RunDetail["kind"], string> = {
  epic: "Epic",
  request: "Request",
  review: "Review",
  triage: "Triage",
  ask: "Ask",
};

function changeRequest(detail: RunDetail): string {
  const provider = detail.pullRequest?.provider ?? detail.repository?.provider;
  return provider === "gitlab" ? "merge request" : "pull request";
}

/** The name of the tracker the run started from, else "its tracker". */
function trackerName(detail: RunDetail): string {
  const tracker = detail.tracker ?? detail.workItem?.tracker;
  return tracker ? trackerLabel(tracker) : "its tracker";
}

/** How the run started, by origin: "Epic started from <tracker>" (the run's, by name). */
function startSentence(detail: RunDetail): string {
  const kind = KIND_NAMES[detail.kind];
  switch (detail.origin) {
    case "tracker":
      return `${kind} started from ${trackerName(detail)}`;
    case "tracker_mention":
    case "triage_mention":
      return `${kind} started from a mention in ${trackerName(detail)}`;
    case "chat":
      return `${kind} started from a chat`;
    case "pr_webhook":
      return `${kind} started by a change to the ${changeRequest(detail)}`;
    case "pr_mention":
      return `${kind} started from a mention on the ${changeRequest(detail)}`;
    case "triage_label":
      return `${kind} started by the triage label`;
    case "manual":
      return `${kind} started by hand`;
  }
}

/** The repo's name without its owner: "customer-portal". */
function repoName(fullPath: string): string {
  return fullPath.slice(fullPath.lastIndexOf("/") + 1);
}

/** An error's first non-empty line. */
function firstLine(error: string | null): string | null {
  const line = error
    ?.split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  return line ?? null;
}

const REASON_STATUSES: readonly RunDetail["status"][] = ["waiting", "stopped", "failed"];

/**
 * A run's activity, newest first (Design rule 4: sentences, never job types): its start and
 * routing ("Routed by team `SOC` and label `product:portal` to customer-portal"), each
 * finished attempt's `label` at its finish (a failed one adds its error's first line), and,
 * for a waiting, stopped or failed run, the current `reason`.
 */
export function runActivity(detail: RunDetail, reason: string | null): RunActivityEntry[] {
  // Oldest first; reversed at the end, so equal times keep the later entry on top.
  const entries: RunActivityEntry[] = [
    { id: "created", at: detail.createdAt, text: startSentence(detail) },
  ];
  const repository = detail.details.repository ?? detail.repository;
  if (detail.details.routedBy && repository) {
    entries.push({
      id: "routed",
      at: detail.createdAt,
      text: `Routed by ${detail.details.routedBy} to ${repoName(repository.fullPath)}`,
    });
  }
  const finished = detail.attempts
    .filter((attempt) => attempt.finishedAt !== null)
    .map((attempt) => {
      const error = attempt.status === "failed" ? firstLine(attempt.error) : null;
      return {
        id: `attempt:${attempt.id}`,
        at: attempt.finishedAt!,
        text: error ? `${attempt.label}: ${error}` : attempt.label,
      };
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  entries.push(...finished);
  if (reason && REASON_STATUSES.includes(detail.status)) {
    entries.push({ id: "reason", at: detail.finishedAt ?? detail.updatedAt, text: reason });
  }
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => Date.parse(b.entry.at) - Date.parse(a.entry.at) || b.index - a.index)
    .map(({ entry }) => entry);
}
