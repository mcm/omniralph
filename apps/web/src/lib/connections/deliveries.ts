/**
 * Webhook deliveries in plain words (Design rule 4): what each event was ("Pull request ·
 * updated", "CI · failed", "Work item delegated") and what it did ("Review started",
 * "Ignored: reviews are off for this repo"). The log stores the provider's own names
 * (`pull_request.synchronize`, `Merge Request Hook.update`, `AgentSessionEvent.created`):
 * none of them is ever shown.
 */
import type { DeliveryRow } from "@/lib/api/deliveries";
import { formatDateTimeInYear } from "@/lib/format-date";

/** The label of an event this module doesn't know. */
export const OTHER_EVENT = "Other event";

type DeliveryProvider = DeliveryRow["provider"];

/** An event's subject and how each of its actions reads (`null`: the subject alone). */
interface EventWords {
  subject: string;
  actions?: Record<string, string | null>;
}

/** A pull or merge request's actions, shared by GitHub and GitLab. */
const CHANGE_REQUEST_ACTIONS: Record<string, string | null> = {
  // GitHub
  opened: "opened",
  reopened: "reopened",
  synchronize: "updated",
  edited: "edited",
  closed: "closed",
  ready_for_review: "ready for review",
  converted_to_draft: "converted to draft",
  review_requested: "review requested",
  review_request_removed: "review request removed",
  assigned: "assigned",
  unassigned: "unassigned",
  labeled: "labeled",
  unlabeled: "unlabeled",
  locked: "locked",
  unlocked: "unlocked",
  milestoned: "milestone set",
  demilestoned: "milestone removed",
  auto_merge_enabled: "auto-merge on",
  auto_merge_disabled: "auto-merge off",
  enqueued: "queued to merge",
  dequeued: "removed from the merge queue",
  // GitLab
  open: "opened",
  reopen: "reopened",
  update: "updated",
  close: "closed",
  merge: "merged",
  approved: "approved",
  approval: "approved",
  unapproved: "approval removed",
  unapproval: "approval removed",
};

/** How a CI run, check or pipeline went (GitHub conclusions, GitLab statuses) or where it is. */
const CI_RESULTS: Record<string, string> = {
  success: "passed",
  failure: "failed",
  failed: "failed",
  cancelled: "canceled",
  canceled: "canceled",
  timed_out: "timed out",
  skipped: "skipped",
  action_required: "needs approval",
  neutral: "finished",
  stale: "finished",
  startup_failure: "failed",
  running: "running",
  pending: "queued",
  created: "queued",
  waiting_for_resource: "queued",
  preparing: "queued",
  scheduled: "queued",
  manual: "waiting",
};

/** A CI event's action before its result is known. */
const CI_ACTIONS: Record<string, string | null> = {
  requested: "started",
  in_progress: "running",
  completed: "finished",
  rerequested: "rerun requested",
  requested_action: "rerun requested",
  created: "started",
};

const CI: EventWords = { subject: "CI", actions: CI_ACTIONS };

const COMMENT_ACTIONS: Record<string, string | null> = {
  created: null,
  create: null,
  edited: "edited",
  update: "edited",
  deleted: "deleted",
  remove: "deleted",
};

/** Every GitHub event the App subscribes to (docs/github-app.md), and those it may send. */
const GITHUB_EVENTS: Record<string, EventWords> = {
  pull_request: { subject: "Pull request", actions: CHANGE_REQUEST_ACTIONS },
  pull_request_review: {
    subject: "Review",
    actions: { submitted: "submitted", edited: "edited", dismissed: "dismissed" },
  },
  pull_request_review_comment: { subject: "Review comment", actions: COMMENT_ACTIONS },
  pull_request_review_thread: {
    subject: "Review thread",
    actions: { resolved: "resolved", unresolved: "reopened" },
  },
  issue_comment: { subject: "Comment", actions: COMMENT_ACTIONS },
  push: { subject: "Push" },
  workflow_run: CI,
  workflow_job: CI,
  check_suite: CI,
  check_run: CI,
  status: { subject: "CI" },
  ping: { subject: "Test delivery" },
};

/** Every GitLab hook a connection's project webhook sends, or may. */
const GITLAB_EVENTS: Record<string, EventWords> = {
  "Merge Request Hook": { subject: "Merge request", actions: CHANGE_REQUEST_ACTIONS },
  "Push Hook": { subject: "Push" },
  "Tag Push Hook": { subject: "Tag push" },
  "Note Hook": { subject: "Comment", actions: COMMENT_ACTIONS },
  "Pipeline Hook": CI,
  "Job Hook": CI,
};

/** Every Linear webhook type the app subscribes to (Agent session events and Issues), and comments. */
const LINEAR_EVENTS: Record<string, EventWords> = {
  AgentSessionEvent: {
    subject: "Agent session",
    actions: { created: "Work item delegated", prompted: "Reply in the session" },
  },
  Issue: {
    subject: "Work item",
    actions: { create: "created", update: "updated", remove: "removed" },
  },
  Comment: { subject: "Comment", actions: COMMENT_ACTIONS },
};

const EVENTS: Record<DeliveryProvider, Record<string, EventWords>> = {
  github: GITHUB_EVENTS,
  gitlab: GITLAB_EVENTS,
  linear: LINEAR_EVENTS,
};

/**
 * The delivery's event in plain words: the subject and what happened, "Pull request ·
 * updated", "Merge request · opened", "Push", "Comment", "CI · failed", "Work item
 * delegated", "Reply in the session", "Work item · updated". GitHub says "pull request",
 * GitLab "merge request". An event this doesn't know is "Other event"; a known event with an
 * unknown action is its subject alone.
 */
export function deliveryEventLabel(provider: DeliveryProvider, event: string): string {
  const [name = "", action, result] = event.split(".");
  const words = Object.hasOwn(EVENTS[provider], name) ? EVENTS[provider][name] : undefined;
  if (!words) return OTHER_EVENT;
  if (words === CI) {
    // `workflow_run.completed.failure`, `Pipeline Hook.failed` (a pipeline has no action).
    const outcome = result ?? (provider === "gitlab" ? action : undefined);
    const ciWord =
      (outcome && Object.hasOwn(CI_RESULTS, outcome) ? CI_RESULTS[outcome] : undefined) ??
      (action && Object.hasOwn(CI_ACTIONS, action) ? CI_ACTIONS[action] : undefined) ??
      (outcome && Object.hasOwn(CI_ACTIONS, outcome) ? CI_ACTIONS[outcome] : undefined);
    return ciWord ? `CI · ${ciWord}` : "CI";
  }
  const word =
    action && words.actions && Object.hasOwn(words.actions, action) ? words.actions[action] : null;
  if (!word) return words.subject;
  // Linear's agent session events read as sentences of their own.
  if (words.subject === "Agent session") return word;
  return `${words.subject} · ${word}`;
}

/** A run kind as a noun ("review", "epic"), for the outcome sentences. */
const RUN_KIND_NOUNS: Record<NonNullable<DeliveryRow["run"]>["kind"], string> = {
  review: "review",
  epic: "epic",
  request: "request",
  triage: "triage",
  ask: "question",
};

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Words that keep their capital after "Ignored: " and "Failed: " (names). */
const PROPER_WORDS = new Set(["Om", "Om's", "Omniralph", "Omniralph's", "Linear", "I"]);

/** A reason sentence continued after a colon: lower-case its first word unless it's a name. */
function continued(reason: string): string {
  const text = reason.trim().replace(/\.$/, "");
  const first = text.split(/\s/, 1)[0] ?? "";
  if (PROPER_WORDS.has(first) || /[A-Z]/.test(first.slice(1))) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * What the delivery did, as a sentence: "Review started" (by run kind), "Sent to the
 * running epic", "Ignored: <reason>", "Failed: <reason>", "Already handled", with
 * "Replayed by <name>: " before a replay's.
 */
export function deliveryOutcomeText(
  delivery: Pick<DeliveryRow, "outcome" | "reason" | "run" | "replayOfId" | "replayedBy">,
): string {
  const kind = delivery.run ? RUN_KIND_NOUNS[delivery.run.kind] : null;
  const reason = delivery.reason?.trim() ? continued(delivery.reason) : null;
  let text: string;
  switch (delivery.outcome) {
    case "started_run":
      text = kind ? `${capitalized(kind)} started` : "Run started";
      break;
    case "updated_run":
      text = kind ? `Sent to the running ${kind}` : "Sent to its run";
      break;
    case "ignored":
      text = reason ? `Ignored: ${reason}` : "Ignored";
      break;
    case "failed":
      text = reason ? `Failed: ${reason}` : "Failed";
      break;
    case "duplicate":
      text = "Already handled";
      break;
  }
  if (!delivery.replayOfId) return text;
  return `Replayed by ${delivery.replayedBy?.name ?? "someone"}: ${text}`;
}

/**
 * When a delivery came in: the time today ("3:04 PM"), with the date on another day
 * ("Oct 26, 3:04 PM"; the year too when it isn't this one).
 */
export function deliveryReceivedText(iso: string, now: Date): string {
  const date = new Date(iso);
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { timeStyle: "short" });
  }
  return formatDateTimeInYear(iso, now.getFullYear());
}
