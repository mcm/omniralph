import type {
  ChatPlatform,
  InboxQuestionKind,
  RunIterationStatus,
  RunIterationVerdict,
  RunKind,
  RunLoopOutcome,
  RunOrigin,
  RunStatus,
} from "@omniralph/db";
import { FEEDBACK_REASONS } from "@omniralph/shared";
import { z } from "zod";
import { isoDate } from "./schemas";
import { WORK_ITEM_TRACKERS } from "./work-item-matches";

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
  "tracker",
  "tracker_mention",
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
/** A code host. */
export const scmProviderSchema = provider;

/** The organization a row belongs to, and the user's role there. */
export const organizationRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["admin", "member"]),
});
export const repositoryRefSchema = z.object({ id: z.string(), provider, fullPath: z.string() });
export const workItemRefSchema = z.object({
  tracker: z.enum(WORK_ITEM_TRACKERS),
  identifier: z.string(),
  url: z.string().nullable(),
});
/** A run's work item: its reference plus its URL ID (`<tracker>-<issue id>`, the Backlog's). */
export const runWorkItemRefSchema = workItemRefSchema.extend({ id: z.string() });
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
  /**
   * The tracker an epic, request or triage run works in, known before its work item is;
   * null for reviews and asks.
   */
  tracker: z.enum(WORK_ITEM_TRACKERS).nullable(),
  /** The work item it builds or triages; null for a run without one (chat, review, ask). */
  workItem: runWorkItemRefSchema.nullable(),
  repository: repositoryRefSchema.nullable(),
  branch: z.string().nullable(),
  pullRequest: pullRequestRefSchema.nullable(),
  agent: agentRefSchema.nullable(),
  /** Steps done of all; null for single-step runs. */
  /** An epic's `current`: its running story's position in execution order, null when none runs. */
  progress: z
    .object({ done: z.number(), total: z.number(), current: z.number().nullable().optional() })
    .nullable(),
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

/**
 * What tokens would cost at Anthropic's API list prices (not what was billed), in US dollars;
 * null when they can't all be priced exactly.
 */
const costUsd = z.number().nonnegative().nullable();

/** How the task verifier checked a story attempt (`RalphTaskVerification` in `@omniralph/db`). */
export const VERIFICATION_STATUSES = ["running", "accepted", "rejected", "failed"] as const;

/**
 * The task verifier's check of a story attempt: `running` until it answers, then `accepted`
 * (the story is done), `rejected` (the attempt failed, with the reasons as feedback) or
 * `failed` (it couldn't check; the story counts as done).
 */
export const attemptVerificationSchema = z.object({
  status: z.enum(VERIFICATION_STATUSES),
  /** A verdict per acceptance criterion; empty until it answers, or when it failed. */
  criteria: z.array(
    z.object({
      criterion: z.string(),
      accepted: z.boolean(),
      /** The evidence it was accepted on, or why it was sent back. */
      reason: z.string(),
    }),
  ),
  summary: z.string().nullable(),
  /** Why it couldn't check (`failed`). */
  error: z.string().nullable(),
  /** The verifier's own attempt (`attempts[].id`). */
  verifierAttemptId: z.string(),
});
export type AttemptVerification = z.infer<typeof attemptVerificationSchema>;

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
  /** Its tokens' list price; null without one (every model it used must be priced). */
  costUsd,
  error: z.string().nullable(),
  /** The `id` of the step it belongs to; null for work outside the steps (e.g. the PR step). */
  step: z.string().nullable(),
  /** Its transcript's length (`GET …/attempts/{id}/transcript`). */
  transcriptEvents: z.number(),
  /** A story attempt's check by the task verifier; null for any other attempt, or before it. */
  verification: attemptVerificationSchema.nullable(),
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

/** Where an epic audit is (`RalphEpicAudit` in `@omniralph/db`). */
export const AUDIT_STATUSES = ["running", "passed", "gaps", "failed", "skipped"] as const;

/**
 * An epic's audit round against its requirements, before its PR/MR opens: `running`, then
 * `passed` (every requirement met), `gaps` (each gap filed as a task, or listed in the PR/MR
 * on the last round), `failed` (it couldn't audit) or `skipped` (the epic lists none).
 */
export const auditStepSchema = z.object({
  kind: z.literal("audit"),
  /** `audit-{n}`: the run's n-th audit. */
  id: z.string(),
  /** The audit round (rounds that judged the epic count). */
  round: z.number(),
  status: z.enum(AUDIT_STATUSES),
  /** What it found per requirement; empty until it finishes, or when it failed. */
  requirements: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      status: z.enum(["met", "gap"]),
      /** The file or test that shows it's met, or where the audit looked. */
      evidence: z.string(),
      /** For a gap: what is missing. */
      missing: z.string(),
    }),
  ),
  summary: z.string().nullable(),
  /** Why it couldn't audit (`failed`). */
  error: z.string().nullable(),
  /** The tasks it filed for its gaps. */
  filed: z.array(workItemRefSchema),
  durationMs: z.number().nullable(),
});

export const runStepSchema = z.discriminatedUnion("kind", [
  storyStepSchema,
  reviewPassStepSchema,
  correlationStepSchema,
  attemptStepSchema,
  auditStepSchema,
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
  /** The token-bearing attempts' list price; null unless every one of them is priced. */
  costUsd,
  attemptCount: z.number(),
  pullRequest: runPullRequestSchema.nullable(),
  /** Every lane of an epic or request (more than one for a multi-repo epic). */
  lanes: z.array(runLaneSchema),
  /** Why it failed or stopped. */
  error: z.string().nullable(),
  /** What a waiting epic waits for. */
  waitingOn: z
    .object({
      blockers: z.array(workItemRefSchema),
      manual: z.array(workItemRefSchema),
      /** Each relation that breaks the dependency rules (its message), while the epic waits on them. */
      relations: z.array(z.string()),
    })
    .nullable(),
  /** The open question a person can answer (the most urgent, when there are several). */
  question: runQuestionSchema.nullable(),
  actions: runActionsSchema,
});
export type RunDetails = z.infer<typeof runDetailsSchema>;

/** Client-safe copy of the chat platforms (`ChatPlatform` in `@omniralph/db`). */
export const CHAT_PLATFORMS = [
  "slack",
  "discord",
  "web",
] as const satisfies readonly ChatPlatform[];

/**
 * The chat an ask run, or a run started from a chat, came from. `href` opens it in Ask
 * (`/ask/{threadId}`) for the member who started a web chat; null for anyone else's web chat
 * and for Slack and Discord threads.
 */
export const runChatSchema = z.object({
  threadId: z.string(),
  platform: z.enum(CHAT_PLATFORMS),
  href: z.string().nullable(),
});
export type RunChat = z.infer<typeof runChatSchema>;

/** Where a reason's problem is fixed (an in-app path), shown after the reason's sentence. */
export const reasonLinkSchema = z.object({ label: z.string(), href: z.string() });
export type ReasonLink = z.infer<typeof reasonLinkSchema>;

/**
 * One iteration of a looped run (`run_iterations`): a worker session then a verifier
 * session. `verdict` is null until the verifier answered (and for a failed iteration);
 * `outcome` is set on the run's last iteration, saying why its loop stopped.
 */
export const runIterationSchema = z.object({
  id: z.string(),
  number: z.number(),
  status: z.enum([
    "working",
    "verifying",
    "done",
    "failed",
  ] as const satisfies readonly RunIterationStatus[]),
  verdict: z
    .enum(["converged", "continue"] as const satisfies readonly RunIterationVerdict[])
    .nullable(),
  /** The verifier's summary of the iteration. */
  summary: z.string().nullable(),
  /** What the verifier sent back for the next iteration. */
  findings: z.array(z.string()),
  metric: z
    .object({
      name: z.string(),
      value: z.number(),
      direction: z.enum(["higher", "lower"]),
      target: z.number().optional(),
    })
    .nullable(),
  error: z.string().nullable(),
  outcome: z
    .enum([
      "converged",
      "max-iterations",
      "stalled",
      "failed",
    ] as const satisfies readonly RunLoopOutcome[])
    .nullable(),
  maxIterations: z.number(),
  /** The iteration's worker and verifier attempts (`attempts[].id`); null before each started. */
  workerAttemptId: z.string().nullable(),
  verifierAttemptId: z.string().nullable(),
  createdAt: isoDate,
  verifyingAt: isoDate.nullable(),
  finishedAt: isoDate.nullable(),
});
export type RunIterationView = z.infer<typeof runIterationSchema>;

/**
 * `GET /api/ui/runs/{id}`: a run of any kind, as its list row plus its reason, steps (in
 * order), attempts (newest first) and details.
 */
export const runDetailSchema = runRowSchema.extend({
  /**
   * Why a waiting, stopped or failed run is where it is, or why a queued one waits for an
   * agent, in a plain-language sentence (as its Inbox item says it); null otherwise.
   */
  reason: z.string().nullable(),
  /** Where the reason's problem is fixed ("Open Fleet" for a missing host tool); null: none. */
  reasonLink: reasonLinkSchema.nullable(),
  steps: z.array(runStepSchema),
  attempts: z.array(runAttemptSchema),
  /** A looped review or triage run's iterations, first first; empty for any other run. */
  iterations: z.array(runIterationSchema),
  details: runDetailsSchema,
  /** The chat it came from; null for a run that didn't come from one. */
  chat: runChatSchema.nullable(),
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

/** How a commit changed a file (`CommitFileStatus` in `@omniralph/scm`). */
export const COMMIT_FILE_STATUSES = ["added", "modified", "removed", "renamed"] as const;

export const commitDiffFileSchema = z.object({
  path: z.string(),
  /** The path before a rename; null otherwise. */
  previousPath: z.string().nullable(),
  status: z.enum(COMMIT_FILE_STATUSES),
  additions: z.number(),
  deletions: z.number(),
  /** Unified diff hunks, at most 2,000 lines; null when the code host shows none. */
  patch: z.string().nullable(),
  /** The patch was cut short or left out for its size. */
  truncated: z.boolean(),
});
export type CommitDiffFileView = z.infer<typeof commitDiffFileSchema>;

/** `GET /api/ui/runs/{id}/steps/{stepId}/diff`: an epic story's commit. */
export const storyDiffSchema = z.object({
  sha: z.string(),
  /** The commit on the code host. */
  url: z.string(),
  provider,
  /** At most 100 files. */
  files: z.array(commitDiffFileSchema),
  /** More files changed than are listed. */
  truncated: z.boolean(),
});
export type StoryDiff = z.infer<typeof storyDiffSchema>;

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

/** Longest answer to one of a triage's open questions `POST /api/ui/runs/{id}/triage/answers` takes. */
export const TRIAGE_ANSWER_MAX_LENGTH = 4000;

/** Longest open question the answers repeat (a question longer than any PRD holds is refused). */
const TRIAGE_QUESTION_MAX_LENGTH = 20_000;

/** One answered open question: its index in the summary's `openQuestions`, its text as shown. */
export const triageAnswerSchema = z.object({
  index: z
    .number({ error: "Say which question this answers." })
    .int("Say which question this answers.")
    .min(0, "That question doesn't exist."),
  /** The question as the user read it: answers to questions that changed since are refused. */
  question: z
    .string({ error: "Say which question this answers." })
    .max(TRIAGE_QUESTION_MAX_LENGTH, "That question doesn't exist."),
  answer: z
    .string({ error: "Write an answer." })
    .trim()
    .min(1, "Write an answer.")
    .max(
      TRIAGE_ANSWER_MAX_LENGTH,
      `Keep each answer under ${TRIAGE_ANSWER_MAX_LENGTH} characters.`,
    ),
});
export type TriageAnswer = z.infer<typeof triageAnswerSchema>;

/**
 * `POST /api/ui/runs/{id}/triage/answers` body: answers to some or all of a triage run's open
 * questions, each question at most once.
 */
export const runTriageAnswersRequestSchema = z.object({
  answers: z
    .array(triageAnswerSchema, { error: "Answer at least one question." })
    .min(1, "Answer at least one question.")
    .refine(
      (answers) => new Set(answers.map((a) => a.index)).size === answers.length,
      "Answer each question once.",
    ),
});
export type RunTriageAnswersRequest = z.input<typeof runTriageAnswersRequestSchema>;

/**
 * `POST /api/ui/runs/{id}/triage/answers` answer: the run triages again with the answers
 * (`retriage`), or will once its current job is over (`pending`).
 */
export const runTriageAnswersResultSchema = z.object({ kind: z.enum(["retriage", "pending"]) });
export type RunTriageAnswersResult = z.infer<typeof runTriageAnswersResultSchema>;

/**
 * Where a message for an attempt is: waiting for its agent's next heartbeat, delivered into
 * the live session, kept as guidance (its attempt rejected it, or ended before it was
 * delivered), or not delivered because the attempt ended (a request).
 */
export const RUN_MESSAGE_STATES = ["waiting", "delivered", "guidance", "undelivered"] as const;
export type RunMessageState = (typeof RUN_MESSAGE_STATES)[number];

/** A request not handled yet, with the repo it is for. */
export const runSessionRequestSchema = z.object({
  id: z.string(),
  text: z.string(),
  author: z.string().nullable(),
  createdAt: isoDate,
  repository: repositoryRefSchema.nullable(),
});

/** A message passed to one of the run's attempts while it worked. */
export const runSessionMessageSchema = z.object({
  id: z.string(),
  kind: z.enum(["guidance", "request"]),
  text: z.string(),
  author: z.string().nullable(),
  /** The attempt it was for, and its label (Design rule 4). */
  attempt: z.object({ id: z.string(), label: z.string() }),
  state: z.enum(RUN_MESSAGE_STATES),
  createdAt: isoDate,
  /** When it was delivered or settled; null while it waits. */
  settledAt: isoDate.nullable(),
});

/**
 * `GET /api/ui/runs/{id}/session?cursor=` (epics and requests): the pending requests (oldest
 * first), the messages (newest first, `RUN_SESSION_MESSAGE_LIMIT` a page; `cursor` asks for
 * the page after `nextCursor`), the guidance (newest first), the stories' recommendations and
 * the progress log.
 */
export const runSessionSchema = z.object({
  pendingRequests: z.array(runSessionRequestSchema),
  messages: z.array(runSessionMessageSchema),
  nextCursor: z.string().nullable(),
  /** `at`: ISO timestamps stored with the run (not checked as dates). */
  guidance: z.array(z.object({ text: z.string(), at: z.string() })),
  recommendations: z.array(
    z.object({
      story: z.object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        url: z.string().nullable(),
      }),
      title: z.string(),
      description: z.string(),
      at: z.string(),
    }),
  ),
  progressLog: z.string(),
});
export type RunSession = z.infer<typeof runSessionSchema>;
export type RunSessionMessageView = z.infer<typeof runSessionMessageSchema>;

/** A finding's severity, most severe first (`findingSeverity` in `@omniralph/db`). */
export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
/** Where a finding is (`findingStatus` in `@omniralph/db`). */
export const FINDING_STATUSES = ["open", "dismissed", "resolved", "superseded", "merged"] as const;

/** A dismissal of a finding (`@bot dismiss` in its thread, older ones from the control panel). */
export const findingFeedbackSchema = z.object({
  id: z.string(),
  /** `scm`: `@bot dismiss` on the PR/MR; `ui`: the control panel (history only). */
  source: z.enum(["ui", "scm"]),
  reason: z.enum(FEEDBACK_REASONS),
  note: z.string().nullable(),
  /** A control panel user, or a code-host login (`@name`). */
  actor: z.string(),
  createdAt: isoDate,
  restoredAt: isoDate.nullable(),
  restoredBy: z.string().nullable(),
});

export const reviewFindingSchema = z.object({
  id: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  severity: z.enum(FINDING_SEVERITIES),
  category: z.string(),
  title: z.string(),
  body: z.string(),
  suggestion: z.string().nullable(),
  /** 0–1. */
  confidence: z.number(),
  status: z.enum(FINDING_STATUSES),
  /** The finding of a later pass that superseded this one: its run, pass (step) and ID. */
  supersededBy: z
    .object({ runId: z.string(), stepId: z.string(), findingId: z.string() })
    .nullable(),
  /** Oldest first. */
  feedback: z.array(findingFeedbackSchema),
});
export type ReviewFindingView = z.infer<typeof reviewFindingSchema>;

/** A pass's findings in one file, by start line. */
export const reviewFindingFileSchema = z.object({
  path: z.string(),
  findings: z.array(reviewFindingSchema),
});
export type ReviewFindingFile = z.infer<typeof reviewFindingFileSchema>;

/** One pass (a `review_pass` step, same ID) with its findings, grouped by file. */
export const reviewPassFindingsSchema = z.object({
  id: z.string(),
  status: z.enum(REVIEW_PASS_STATUSES),
  /** Files in the order of their first finding. */
  files: z.array(reviewFindingFileSchema),
  findingCount: z.number(),
  /** Files the pass didn't review, and why (e.g. "too_large"). */
  skippedFiles: z.array(z.object({ path: z.string(), reason: z.string() })),
});
export type ReviewPassFindings = z.infer<typeof reviewPassFindingsSchema>;

/** `GET /api/ui/runs/{id}/findings`: a review run's findings, per pass in step order. */
export const runFindingsSchema = z.object({ passes: z.array(reviewPassFindingsSchema) });
export type RunFindings = z.infer<typeof runFindingsSchema>;

// ── Triage summary (`GET /api/ui/runs/{id}/triage`) ─────────────────────────────────────────

/**
 * Where a triage run left its work item: still triaging (queued or running), Ready to start
 * (nothing left to answer), Needs answers (open questions left, so Needs refining), failed,
 * or stopped (the issue went in progress, or someone stopped it).
 */
export const TRIAGE_SUMMARY_OUTCOMES = [
  "triaging",
  "ready",
  "needs_answers",
  "failed",
  "stopped",
] as const;
export type TriageSummaryOutcome = (typeof TRIAGE_SUMMARY_OUTCOMES)[number];

/** What a triage did to the issue: wrote a PRD, reformatted a planned epic, or left it. */
export const TRIAGE_CHANGES = ["prd", "reformat", "unchanged"] as const;

/**
 * `GET /api/ui/runs/{id}/triage`: a triage run's outcome from its last result, and the issue
 * as it read before the run's first triage job (the job's input).
 */
export const runTriageSummarySchema = z.object({
  outcome: z.enum(TRIAGE_SUMMARY_OUTCOMES),
  /** What the last triage decided, in Om's words; null before a result. */
  summary: z.string().nullable(),
  /** Why the last triage job failed; null otherwise. */
  error: z.string().nullable(),
  change: z.enum(TRIAGE_CHANGES).nullable(),
  size: z.enum(["XS", "S", "M", "L", "XL"]).nullable(),
  /** Story sub-issues the last triage planned (a new epic's). */
  storyCount: z.number(),
  /** What the last triage couldn't decide: the PRD's `## Open Questions`. */
  openQuestions: z.array(z.string()),
  /**
   * Whether the user may answer the open questions (`POST /api/ui/runs/{id}/triage/answers`):
   * the run needs answers and the user has the `answer` role.
   */
  answerQuestions: z.boolean(),
  /** The issue before triage; null when its first job's input is gone. */
  originalIssue: z.object({ title: z.string(), description: z.string() }).nullable(),
});
export type RunTriageSummary = z.infer<typeof runTriageSummarySchema>;
