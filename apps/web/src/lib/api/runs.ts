import type { InboxQuestionKind, RunKind, RunOrigin, RunStatus } from "@omniralph/db";
import { z } from "zod";
import { isoDate } from "./schemas";

/** Wire formats of the unified run endpoints under `/api/ui/runs`. */

/** Client-safe copies of the run read model's values (`run-index.ts` in `@omniralph/db`). */
export const RUN_KINDS = [
  "epic",
  "request",
  "review",
  "triage",
  "ask",
] as const satisfies readonly RunKind[];
export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "stopped",
  "skipped",
] as const satisfies readonly RunStatus[];
export const RUN_ORIGINS = [
  "linear",
  "linear_mention",
  "chat",
  "pr_webhook",
  "pr_mention",
  "manual",
  "triage_label",
  "triage_mention",
] as const satisfies readonly RunOrigin[];

/** Default and largest page of `GET /api/ui/runs`. */
export const RUN_LIST_DEFAULT_LIMIT = 50;
export const RUN_LIST_MAX_LIMIT = 100;

const provider = z.enum(["github", "gitlab"]);

/** The organization a row belongs to, and the user's role there. */
export const organizationRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["admin", "member"]),
});
export const repositoryRefSchema = z.object({ id: z.string(), provider, fullPath: z.string() });
export const workItemRefSchema = z.object({
  tracker: z.literal("linear"),
  identifier: z.string(),
  url: z.string().nullable(),
});
export const pullRequestRefSchema = z.object({
  provider,
  number: z.number(),
  url: z.string().nullable(),
});
export const agentRefSchema = z.object({ id: z.string(), name: z.string() });

/** A row of the unified run list: kind, status, title and typed references. */
export const runRowSchema = z.object({
  id: z.string(),
  kind: z.enum(RUN_KINDS),
  status: z.enum(RUN_STATUSES),
  origin: z.enum(RUN_ORIGINS),
  organization: organizationRefSchema,
  title: z.string(),
  workItem: workItemRefSchema.nullable(),
  repository: repositoryRefSchema.nullable(),
  branch: z.string().nullable(),
  pullRequest: pullRequestRefSchema.nullable(),
  agent: agentRefSchema.nullable(),
  /** Steps done of all; null for single-step runs. */
  progress: z.object({ done: z.number(), total: z.number() }).nullable(),
  tokens: z.object({ in: z.number(), out: z.number() }),
  createdAt: isoDate,
  startedAt: isoDate.nullable(),
  finishedAt: isoDate.nullable(),
  updatedAt: isoDate,
});
export type RunRow = z.infer<typeof runRowSchema>;

/**
 * `GET /api/ui/runs?kind=&status=&repository=&origin=&agent=&organization=&cursor=&limit=`:
 * a page of runs, newest first. `nextCursor` is null on the last page.
 */
export const runListSchema = z.object({
  runs: z.array(runRowSchema),
  nextCursor: z.string().nullable(),
});
export type RunList = z.infer<typeof runListSchema>;

/** `GET /api/ui/runs/filter-options`'s query: the organization scope. */
export const runFilterOptionsQuerySchema = z.object({
  organization: z
    .union([z.literal("all"), z.uuid()], { error: "Unknown organization." })
    .optional(),
});

/**
 * `GET /api/ui/runs/filter-options?organization=`: the Repo filter's repositories in scope,
 * by full path, each with its organization.
 */
export const runFilterOptionsSchema = z.object({
  repositories: z.array(repositoryRefSchema.extend({ organization: organizationRefSchema })),
});
export type RunFilterOptions = z.infer<typeof runFilterOptionsSchema>;

// ── Run detail ───────────────────────────────────────────────────────────────

/** `jobs.status`: an attempt's status. */
export const ATTEMPT_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
  "expired",
  "skipped",
] as const;

const tokens = z.object({ in: z.number(), out: z.number() });

/** One attempt (job) of a run. `type` is the raw job type, for filtering only. */
export const runAttemptSchema = z.object({
  id: z.string(),
  /** What it did, in plain language (`describeAttempt`). */
  label: z.string(),
  type: z.string(),
  status: z.enum(ATTEMPT_STATUSES),
  agent: agentRefSchema.nullable(),
  /** How often it was handed to an agent. */
  deliveries: z.number(),
  /** Stop asked a running attempt to cancel; its agent hasn't confirmed yet. */
  cancelRequested: z.boolean(),
  createdAt: isoDate,
  startedAt: isoDate.nullable(),
  finishedAt: isoDate.nullable(),
  tokens,
  error: z.string().nullable(),
  /** The `id` of the step it belongs to; null for work outside the steps (e.g. the PR step). */
  step: z.string().nullable(),
  /** Its transcript's length (`GET …/attempts/{id}/transcript`). */
  transcriptEvents: z.number(),
});
export type RunAttempt = z.infer<typeof runAttemptSchema>;

const laneRefSchema = z.object({
  id: z.string(),
  repository: repositoryRefSchema,
  branch: z.string(),
});

export const STORY_STATUSES = [
  "pending",
  "running",
  "completed",
  "blocked",
  "exhausted",
  "manual",
  "canceled",
] as const;
export const REVIEW_PASS_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "budget_exhausted",
  "skipped",
] as const;

/** An epic's story. */
export const storyStepSchema = z.object({
  kind: z.literal("story"),
  id: z.string(),
  workItem: workItemRefSchema,
  title: z.string(),
  status: z.enum(STORY_STATUSES),
  /** Finished attempts. */
  attempts: z.number(),
  /** Sum of its attempts' start → finish, in milliseconds. */
  durationMs: z.number(),
  /** The commit it was built in. */
  commit: z.string().nullable(),
  /** Why its last attempt didn't complete. */
  lastFeedback: z.string().nullable(),
  lane: laneRefSchema.nullable(),
});

export const findingCountsSchema = z.object({
  critical: z.number(),
  high: z.number(),
  medium: z.number(),
  low: z.number(),
  info: z.number(),
});

/** A review run's pass: one review task. */
export const reviewPassStepSchema = z.object({
  kind: z.literal("review_pass"),
  id: z.string(),
  taskName: z.string(),
  status: z.enum(REVIEW_PASS_STATUSES),
  tokens,
  durationMs: z.number().nullable(),
  /** Its findings still open, by severity. */
  openFindings: findingCountsSchema,
});

/** A review run's correlation: merging its passes' results (its attempt's ID). */
export const correlationStepSchema = z.object({
  kind: z.literal("correlation"),
  id: z.string(),
  label: z.string(),
  status: z.enum(ATTEMPT_STATUSES),
  tokens,
  durationMs: z.number().nullable(),
});

/** A request's, triage's or ask's step: one attempt (a turn), by the attempt's ID. */
export const attemptStepSchema = z.object({
  kind: z.literal("attempt"),
  id: z.string(),
  label: z.string(),
  status: z.enum(ATTEMPT_STATUSES),
  durationMs: z.number().nullable(),
});

export const runStepSchema = z.discriminatedUnion("kind", [
  storyStepSchema,
  reviewPassStepSchema,
  correlationStepSchema,
  attemptStepSchema,
]);
export type RunStep = z.infer<typeof runStepSchema>;

/** A PR/MR of the run, with what its code host last said about it. */
export const runPullRequestSchema = pullRequestRefSchema.extend({
  /** Null when unknown (a review of a PR/MR Om didn't open). */
  merged: z.boolean().nullable(),
  closed: z.boolean().nullable(),
});

/** A lane of an epic or request: one repo's branch and PR/MR. */
export const runLaneSchema = z.object({
  id: z.string(),
  repository: repositoryRefSchema,
  branch: z.string(),
  baseBranch: z.string(),
  pullRequest: runPullRequestSchema
    .extend({
      draft: z.boolean(),
      reviewState: z.enum([
        "none",
        "review_requested",
        "commented",
        "changes_requested",
        "approved",
      ]),
    })
    .nullable(),
});

/** What this user may do with the run (`POST …/retry` targets and `POST …/stop`). */
export const runActionsSchema = z.object({
  stop: z.boolean(),
  retry: z.object({
    /** `{kind: "run"}`. */
    run: z.boolean(),
    /** `{kind: "story", storyId}`. */
    storyIds: z.array(z.string()),
    /** `{kind: "attempt", attemptId}`. */
    attemptIds: z.array(z.string()),
  }),
});
export type RunActions = z.infer<typeof runActionsSchema>;
export type RunLane = z.infer<typeof runLaneSchema>;

/** The questions a run asks a person (client-safe copy of `InboxQuestionKind`). */
export const RUN_QUESTION_KINDS = [
  "repository",
  "preparation",
  "cleanup",
  "permission",
] as const satisfies readonly InboxQuestionKind[];

/**
 * A run's open question (the run detail's and the Inbox `question` item's): which repo to
 * use, whether to run a manual story's preparation, what to do with a merged PR/MR's
 * leftovers, or whether to allow a tool call. `POST /api/ui/runs/{id}/answer` answers it with
 * its `key` and one of its `options`.
 */
export const runQuestionSchema = z.object({
  /** Stable while the question is open; a new question gets a new key. */
  key: z.string(),
  kind: z.enum(RUN_QUESTION_KINDS),
  /** What is asked, in plain language. */
  prompt: z.string(),
  options: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      /** A repository option's code host (its label is the repo's full path). */
      provider: provider.optional(),
    }),
  ),
  askedAt: isoDate,
  /** When it is answered for the person (a tool call is denied, a branch deleted). */
  expiresAt: isoDate.nullable(),
});
export type RunQuestion = z.infer<typeof runQuestionSchema>;

export const runDetailsSchema = z.object({
  repository: repositoryRefSchema.nullable(),
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  /** How the repo was chosen, e.g. "team `ENG`". */
  routedBy: z.string().nullable(),
  agent: agentRefSchema.nullable(),
  tokens,
  attemptCount: z.number(),
  pullRequest: runPullRequestSchema.nullable(),
  /** Every lane of an epic or request (more than one for a multi-repo epic). */
  lanes: z.array(runLaneSchema),
  /** Why it failed or stopped. */
  error: z.string().nullable(),
  /** What a waiting epic waits for. */
  waitingOn: z
    .object({ blockers: z.array(workItemRefSchema), manual: z.array(workItemRefSchema) })
    .nullable(),
  /** The open question a person can answer (the most urgent, when there are several). */
  question: runQuestionSchema.nullable(),
  actions: runActionsSchema,
});
export type RunDetails = z.infer<typeof runDetailsSchema>;

/**
 * `GET /api/ui/runs/{id}`: a run of any kind, as its list row plus its steps (in order),
 * attempts (newest first) and details.
 */
export const runDetailSchema = runRowSchema.extend({
  steps: z.array(runStepSchema),
  attempts: z.array(runAttemptSchema),
  details: runDetailsSchema,
});
export type RunDetail = z.infer<typeof runDetailSchema>;

/** Default and largest page of `GET /api/ui/runs/{id}/attempts/{attemptId}/transcript`. */
export const TRANSCRIPT_DEFAULT_LIMIT = 200;
export const TRANSCRIPT_MAX_LIMIT = 500;

export const transcriptEventSchema = z.object({
  id: z.string(),
  /** Claude's text (`thought`) or a tool call (`action`). */
  type: z.enum(["thought", "action"]),
  /** A thought's text, or an action's name. */
  body: z.string(),
  /** An action's parameter (e.g. the command); null for thoughts. */
  parameter: z.string().nullable(),
  at: isoDate,
});

/** `GET /api/ui/runs/{id}/attempts/{attemptId}/transcript?cursor=&limit=`: oldest first. */
export const transcriptPageSchema = z.object({
  events: z.array(transcriptEventSchema),
  nextCursor: z.string().nullable(),
});
export type TranscriptPageView = z.infer<typeof transcriptPageSchema>;

/** What `POST /api/ui/runs/{id}/retry` retries (the run by default). */
export const runRetryTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run") }),
  z.object({ kind: z.literal("story"), storyId: z.uuid("Choose a story of this run.") }),
  z.object({ kind: z.literal("attempt"), attemptId: z.uuid("Choose an attempt of this run.") }),
]);
export type RunRetryTarget = z.infer<typeof runRetryTargetSchema>;

/** `POST /api/ui/runs/{id}/retry` body; an empty body retries the run. */
export const runRetryRequestSchema = z.object({
  target: runRetryTargetSchema.default({ kind: "run" }),
});
export type RunRetryRequest = z.input<typeof runRetryRequestSchema>;

/**
 * `POST /api/ui/runs/{id}/retry` answer: the retried run's detail (a review's: the review run of
 * the PR's current head) and a `warning` when nothing new started (that head's review is
 * already queued or running).
 */
export const runRetryResultSchema = runDetailSchema.extend({ warning: z.string().nullable() });
export type RunRetryResult = z.infer<typeof runRetryResultSchema>;

/** Longest question key and option ID `POST /api/ui/runs/{id}/answer` takes. */
const ANSWER_FIELD_MAX_LENGTH = 500;

/** `POST /api/ui/runs/{id}/answer` body: the open question's key and the chosen option. */
export const runAnswerRequestSchema = z.object({
  questionKey: z
    .string({ error: "Say which question this answers." })
    .min(1, "Say which question this answers.")
    .max(ANSWER_FIELD_MAX_LENGTH, "That question doesn't exist."),
  optionId: z
    .string({ error: "Choose one of the offered answers." })
    .min(1, "Choose one of the offered answers.")
    .max(ANSWER_FIELD_MAX_LENGTH, "Choose one of the offered answers."),
});
export type RunAnswerRequest = z.infer<typeof runAnswerRequestSchema>;
