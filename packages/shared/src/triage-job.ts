/**
 * Triage: turning a Linear issue into a PRD ralph can build,
 * unattended. The control panel loads the issue and applies the result to
 * Linear (agents hold no Linear token); agents run its job:
 *
 * - `triage.run`: one read-only Claude session over the issue (and, when one is
 *   routed, a checkout of the repository's default branch) that returns the
 *   rewritten issue, its size and its open questions.
 */
import { z } from "zod";
import { JobRepository } from "./protocol.js";
import { GitBranch } from "./ralph-job.js";

export const TRIAGE_RUN_JOB_TYPE = "triage.run";
export const TRIAGE_JOB_TYPES = [TRIAGE_RUN_JOB_TYPE] as const;

/** Longest issue description or PRD passed to or returned by a triage job. */
const MAX_DOCUMENT_LENGTH = 200_000;
const MAX_TEXT_LENGTH = 20_000;

const TokenUsage = z.object({ inputTokens: z.int().min(0), outputTokens: z.int().min(0) });

/** Linear workflow state types (`WorkflowState.type`). */
export const LINEAR_STATE_TYPES = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
] as const;
const LinearStateType = z.enum(LINEAR_STATE_TYPES);

/** The `linear-prd` t-shirt sizes; L and larger become epics with sub-issues. */
export const TRIAGE_SIZES = ["XS", "S", "M", "L", "XL"] as const;
export type TriageSize = (typeof TRIAGE_SIZES)[number];

const LinearId = z.string().min(1).max(64);
/** Linear identifier, e.g. `TOOL-83`. */
const LinearIdentifier = z.string().min(1).max(64);

/** A Linear user, as named in the prompt. */
const TriageUser = z.object({
  id: LinearId,
  name: z.string().min(1).max(200),
});

/** The issue being triaged (untrusted text; quoted into the prompt). */
export const TriageIssue = z.object({
  id: LinearId,
  identifier: LinearIdentifier,
  title: z.string().max(1000),
  description: z.string().max(MAX_DOCUMENT_LENGTH),
  stateType: LinearStateType,
  /** Who created it; null when Linear doesn't say (e.g. an integration). */
  creator: TriageUser.nullable(),
  url: z.url().nullable().default(null),
});
export type TriageIssue = z.infer<typeof TriageIssue>;

/** A comment on the issue, oldest first. */
export const TriageComment = z.object({
  /** Null for a comment by an integration or a deleted user. */
  author: z.string().min(1).max(200).nullable(),
  body: z.string().max(MAX_TEXT_LENGTH),
  /** When it was posted (ISO 8601). */
  createdAt: z.string().max(64),
});
export type TriageComment = z.infer<typeof TriageComment>;

/** A sub-issue of the issue, in sub-issue order. */
export const TriageChild = z.object({
  id: LinearId,
  identifier: LinearIdentifier,
  title: z.string().max(1000),
  description: z.string().max(MAX_DOCUMENT_LENGTH),
  stateType: LinearStateType,
  /** Linear priority: 0 No priority, 1 Urgent … 4 Low. */
  priority: z.int().min(0).max(4),
});
export type TriageChild = z.infer<typeof TriageChild>;

/** An issue blocking the issue (or one of its sub-issues). */
export const TriageBlocker = z.object({
  identifier: LinearIdentifier,
  title: z.string().max(1000),
  stateType: LinearStateType,
  /** The issue it blocks (the triaged issue or one of its sub-issues). */
  blocks: LinearIdentifier,
});
export type TriageBlocker = z.infer<typeof TriageBlocker>;

/** The repository the issue routes to, read (never written) at its default branch. */
export const TriageRepository = z.object({
  repositoryId: z.uuid(),
  repository: JobRepository,
  defaultBranch: GitBranch,
});
export type TriageRepository = z.infer<typeof TriageRepository>;

/** What a triage session did: wrote a new PRD, reformatted an already-planned issue, or left it as is. */
export const TRIAGE_OUTCOME_KINDS = ["prd", "reformat", "unchanged"] as const;
export type TriageOutcomeKind = (typeof TRIAGE_OUTCOME_KINDS)[number];

/** Linear priority of a story: 1 Urgent, 2 High, 3 Medium, 4 Low. */
const StoryPriority = z.int().min(1).max(4);

/** A story sub-issue to create for a new epic, in story order. */
export const TriageStory = z.object({
  title: z.string().trim().min(1).max(255),
  /** User story sentence, optional context, then `## Acceptance Criteria`. */
  body: z.string().trim().min(1).max(MAX_DOCUMENT_LENGTH),
  priority: StoryPriority,
  /** Indexes (0-based) of the earlier stories it is blocked by. */
  dependsOn: z.array(z.int().min(0)).max(100).default([]),
  /** A step for a person: created with the manual label. */
  manual: z.boolean().default(false),
});
export type TriageStory = z.infer<typeof TriageStory>;

/** An existing sub-issue rewritten in the PRD format (only Backlog/Todo ones are ever applied). */
export const TriageSubIssueUpdate = z.object({
  /** The sub-issue's Linear id. */
  id: LinearId,
  title: z.string().trim().min(1).max(255),
  body: z.string().trim().min(1).max(MAX_DOCUMENT_LENGTH),
  priority: StoryPriority,
  /** Linear ids of the sibling sub-issues it is blocked by. */
  blockedBy: z.array(LinearId).max(100).default([]),
});
export type TriageSubIssueUpdate = z.infer<typeof TriageSubIssueUpdate>;

/** What a triage session decided: the issue as it should read in Linear. */
export const TriageOutcome = z.object({
  outcome: z.enum(TRIAGE_OUTCOME_KINDS),
  size: z.enum(TRIAGE_SIZES),
  title: z.string().trim().min(1).max(255),
  /** The PRD, without the `## Open Questions` section (the control panel adds it from `openQuestions`). */
  description: z.string().trim().min(1).max(MAX_DOCUMENT_LENGTH),
  /** What it couldn't decide; empty when the issue is ready for Todo. */
  openQuestions: z.array(z.string().trim().min(1).max(4000)).max(50),
  /** Sub-issues to create (`prd` epics, L or larger, only). */
  stories: z.array(TriageStory).max(100).default([]),
  /** Existing sub-issues reformatted to the PRD format (`reformat` only). */
  subIssueUpdates: z.array(TriageSubIssueUpdate).max(500).default([]),
});
export type TriageOutcome = z.infer<typeof TriageOutcome>;

/** Payload of a `triage.run` job. */
export const TriageRunPayload = z.object({
  /** The `triage_runs` row. */
  triageRunId: z.uuid(),
  issue: TriageIssue,
  comments: z.array(TriageComment).max(500).default([]),
  children: z.array(TriageChild).max(500).default([]),
  blockers: z.array(TriageBlocker).max(500).default([]),
  /** The routed repository; null runs without a checkout. */
  repository: TriageRepository.nullable().default(null),
  /** A reply from the agent session (e.g. answers to open questions); null on the first run. */
  reply: z.string().max(MAX_TEXT_LENGTH).nullable().default(null),
  /** What the session's previous triage decided, when this run follows a reply. */
  previousResult: TriageOutcome.nullable().default(null),
});
export type TriageRunPayload = z.infer<typeof TriageRunPayload>;

/** Result of a `triage.run` job (`/api/harness/jobs/{id}/result`). */
export const TriageRunResult = z
  .object({
    /** For the Linear session: what triage decided, or why it couldn't (`error`). */
    summary: z.string().max(MAX_TEXT_LENGTH),
    /** Set when the session failed or ended without a valid structured result. */
    error: z.string().max(MAX_TEXT_LENGTH).nullable().default(null),
    /** Null exactly when `error` is set. */
    outcome: TriageOutcome.nullable(),
    usage: TokenUsage,
    durationMs: z.int().min(0),
  })
  .refine((r) => (r.error === null) === (r.outcome !== null), {
    message: "a triage result has either an outcome or an error",
    path: ["outcome"],
  });
export type TriageRunResult = z.infer<typeof TriageRunResult>;
