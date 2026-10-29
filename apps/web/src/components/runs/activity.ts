import type { RunDetail } from "@/lib/api/runs";

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

/** How the run started, by origin: "Epic started from Linear". */
function startSentence(detail: RunDetail): string {
  const kind = KIND_NAMES[detail.kind];
  switch (detail.origin) {
    case "linear":
      return `${kind} started from Linear`;
    case "linear_mention":
    case "triage_mention":
      return `${kind} started from a mention in Linear`;
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

/** Text compared without case or runs of whitespace. */
function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/**
 * The reason's line: a waiting run's whole reason, but only the event of a stopped or failed
 * one ("The run failed"), because the page's header already shows its error.
 */
function reasonSentence(detail: RunDetail, reason: string): string {
  switch (detail.status) {
    case "failed":
      return "The run failed";
    case "stopped":
      return `The ${KIND_NAMES[detail.kind].toLowerCase()} was stopped`;
    default:
      return reason;
  }
}

/**
 * A run's activity, newest first (Design rule 4: sentences, never job types): its start and
 * routing ("Routed by team `SOC` and label `product:portal` to customer-portal"), each
 * finished attempt's `label` at its finish (numbered "(attempt 2)" when the label repeats; a
 * failed one adds its error's first line unless the `reason` the header shows already says it),
 * and, for a waiting, stopped or failed run, the current `reason` (only its event for a stopped
 * or failed run). An error is shown once in the header and once where it happened, never
 * again here.
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
  const done = detail.attempts
    .filter((attempt) => attempt.finishedAt !== null)
    .sort((a, b) => Date.parse(a.finishedAt!) - Date.parse(b.finishedAt!));
  // A label that repeats ("Built FIX-107" three times) carries its attempt's number, so the
  // lines say which try each was (Design rule 4).
  const repeats = new Map<string, number>();
  for (const attempt of done) repeats.set(attempt.label, (repeats.get(attempt.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  const finished = done.map((attempt) => {
    const number = (seen.get(attempt.label) ?? 0) + 1;
    seen.set(attempt.label, number);
    const label =
      (repeats.get(attempt.label) ?? 0) > 1
        ? `${attempt.label} (attempt ${number})`
        : attempt.label;
    const line = attempt.status === "failed" ? firstLine(attempt.error) : null;
    const error = line && reason && normalized(reason).includes(normalized(line)) ? null : line;
    return {
      id: `attempt:${attempt.id}`,
      at: attempt.finishedAt!,
      text: error ? `${label}: ${error}` : label,
    };
  });
  entries.push(...finished);
  if (reason && REASON_STATUSES.includes(detail.status)) {
    entries.push({
      id: "reason",
      at: detail.finishedAt ?? detail.updatedAt,
      text: reasonSentence(detail, reason),
    });
  }
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => Date.parse(b.entry.at) - Date.parse(a.entry.at) || b.index - a.index)
    .map(({ entry }) => entry);
}
