import type { InboxItemKind, InboxQuestionKind, InboxReviewState } from "@omniralph/db";
import { z } from "zod";
import {
  agentRefSchema,
  findingCountsSchema,
  organizationRefSchema,
  pullRequestRefSchema,
  repositoryRefSchema,
  RUN_KINDS,
  RUN_STATUSES,
  workItemRefSchema,
} from "./runs";
import { isoDate } from "./schemas";

/** Wire formats of the Inbox endpoints under `/api/ui/inbox`. */

/** The Inbox's tabs, as the `tab` query parameter names them. */
export const INBOX_TABS = ["needs-you", "problems", "running"] as const;
export type InboxTabParam = (typeof INBOX_TABS)[number];

/** Client-safe copy of the item kinds (`INBOX_ITEM_KINDS` in `@omniralph/db`). */
export const INBOX_ITEM_KINDS = [
  "manual_story",
  "blocked_epic",
  "question",
  "stopped_epic",
  "prd_ready",
  "pr_waiting",
  "failed_run",
  "failed_system",
  "agent_offline",
  "agent_update_failed",
  "run",
] as const satisfies readonly InboxItemKind[];

/**
 * What a person can do with an item: `done` (a manual story: its work item is done; any
 * other item: dismissed), `skip` (a manual story is done without work), `snooze`,
 * `answer` (the run's question), `start_anyway` (an epic waiting on outside blockers),
 * `resume` (a stopped run) and `retry` (a failed run or system attempt).
 */
export const INBOX_ACTIONS = [
  "answer",
  "start_anyway",
  "resume",
  "retry",
  "done",
  "skip",
  "snooze",
] as const;
export type InboxAction = (typeof INBOX_ACTIONS)[number];

export const INBOX_QUESTION_KINDS = [
  "repository",
  "preparation",
  "cleanup",
  "permission",
] as const satisfies readonly InboxQuestionKind[];
export const PR_REVIEW_STATES = [
  "none",
  "review_requested",
  "commented",
  "changes_requested",
  "approved",
] as const satisfies readonly InboxReviewState[];

/** `GET /api/ui/inbox`'s query: a tab (Needs you by default) and the organization scope. */
export const inboxQuerySchema = z.object({
  tab: z.enum(INBOX_TABS, { error: "Unknown Inbox tab." }).default("needs-you"),
  organization: z
    .union([z.literal("all"), z.uuid()], { error: "Unknown organization." })
    .optional(),
});

/** `GET /api/ui/inbox/counts`'s query. */
export const inboxCountsQuerySchema = inboxQuerySchema.pick({ organization: true });

/** One Inbox item: what it is about, why it is here and what a person can do. */
export const inboxItemSchema = z.object({
  /** Stable while nothing new happens; Done and Snooze are by key. */
  key: z.string(),
  tab: z.enum(INBOX_TABS),
  kind: z.enum(INBOX_ITEM_KINDS),
  organization: organizationRefSchema,
  title: z.string(),
  /** The run it is about; null for an agent, or system work outside a run. */
  run: z
    .object({ id: z.string(), kind: z.enum(RUN_KINDS), status: z.enum(RUN_STATUSES) })
    .nullable(),
  workItem: workItemRefSchema.nullable(),
  repository: repositoryRefSchema.nullable(),
  pullRequest: pullRequestRefSchema.nullable(),
  agent: agentRefSchema.nullable(),
  /** Why it needs a person, in plain language. */
  reason: z.string(),
  /** When what it is about happened (a failure, a question, a stop). */
  since: isoDate,
  actions: z.array(z.enum(INBOX_ACTIONS)),
  /** `question`: what is asked. */
  question: z
    .object({
      kind: z.enum(INBOX_QUESTION_KINDS),
      askedAt: isoDate,
      /** When it is answered for the person (a tool call is denied, a branch deleted). */
      expiresAt: isoDate.nullable(),
    })
    .nullable(),
  /** `pr_waiting`: the PR/MR's human review state. */
  reviewState: z.enum(PR_REVIEW_STATES).nullable(),
  /** `pr_waiting`: the latest AI review of the PR/MR; null when it has none. */
  review: z
    .object({
      runId: z.string(),
      status: z.enum(RUN_STATUSES),
      openFindings: findingCountsSchema,
    })
    .nullable(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;

/** `GET /api/ui/inbox?tab=&organization=`: the tab's items, newest first. */
export const inboxFeedSchema = z.object({ items: z.array(inboxItemSchema) });
export type InboxFeed = z.infer<typeof inboxFeedSchema>;

/** `GET /api/ui/inbox/counts?organization=`: each tab's item count (the sidebar badge). */
export const inboxCountsSchema = z.object({
  needsYou: z.number(),
  problems: z.number(),
  running: z.number(),
});
export type InboxCountsResponse = z.infer<typeof inboxCountsSchema>;

/**
 * What `POST /api/ui/inbox/items/{key}` does: `done` (a manual story: its work item is done
 * and the run goes on; any other item: dismissed for the user), `skip` (a manual story is
 * done without work), `snooze` (hidden for the user until `until`), `restore` (undoes the
 * user's Done or Snooze), `start_anyway` (an epic waiting on outside blockers),
 * `resume` (a stopped run) and `retry` (a failed run or system attempt). Answers are
 * `POST /api/ui/runs/{id}/answer`'s.
 */
export const INBOX_ITEM_ACTIONS = [
  "done",
  "skip",
  "snooze",
  "restore",
  "start_anyway",
  "resume",
  "retry",
] as const;
export type InboxItemAction = (typeof INBOX_ITEM_ACTIONS)[number];

/** A snooze is at least this far ahead… */
export const INBOX_SNOOZE_MIN_MS = 5 * 60_000;
/** …and at most this far. */
export const INBOX_SNOOZE_MAX_MS = 30 * 86_400_000;

/** `POST /api/ui/inbox/items/{key}`'s body. */
export const inboxItemActionRequestSchema = z.object({
  action: z.enum(INBOX_ITEM_ACTIONS, { error: "Unknown action." }),
  /** `snooze`: until when (5 minutes to 30 days ahead). */
  until: z.iso.datetime({ offset: true, error: "Snooze until a date and time." }).optional(),
});
export type InboxItemActionRequest = z.infer<typeof inboxItemActionRequestSchema>;

/** `POST /api/ui/inbox/items/{key}`'s answer: what was done, and the user's state of the item. */
export const inboxItemActionResultSchema = z.object({
  key: z.string(),
  action: z.enum(INBOX_ITEM_ACTIONS),
  /** The user's own state of the item afterwards (Done, Snooze); null: none. */
  state: z.enum(["done", "snoozed"]).nullable(),
  snoozedUntil: isoDate.nullable(),
  /** The run the action moved (a story's epic, a retried run: a review's retry is a new run). */
  runId: z.string().nullable(),
  /** Set when the action did nothing new (the same work is already queued or running). */
  warning: z.string().nullable(),
});
export type InboxItemActionResult = z.infer<typeof inboxItemActionResultSchema>;
