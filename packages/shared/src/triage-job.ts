/**
 * Triage: turning a work item into a PRD ralph can build,
 * unattended. The control panel loads the work item and applies the result to
 * the tracker (agents hold no tracker token); agents run its job:
 *
 * - `triage.run`: a run of the built-in query task `builtin:triage`, one
 *   read-only Claude session over the issue (and, when one is routed, a
 *   checkout of the repository's default branch) that returns the rewritten
 *   issue, its size and its open questions.
 */
import { z } from "zod";
import { JobRepository } from "./protocol.js";
import { GitBranch } from "./ralph-job.js";
import { JobTrackerProvider } from "./run-tracker.js";
import { TokenUsage } from "./usage.js";

export const TRIAGE_RUN_JOB_TYPE = "triage.run";
export const TRIAGE_JOB_TYPES = [TRIAGE_RUN_JOB_TYPE] as const;

/** Longest issue description or PRD passed to or returned by a triage job. */
const MAX_DOCUMENT_LENGTH = 200_000;
const MAX_TEXT_LENGTH = 20_000;

/** Tracker workflow state types (`WorkflowStateType` in `@omniralph/tracker`). */
export const TRACKER_STATE_TYPES = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
] as const;
const TrackerStateType = z.enum(TRACKER_STATE_TYPES);

/** The PRD t-shirt sizes; L and larger become epics with sub-issues. */
export const TRIAGE_SIZES = ["XS", "S", "M", "L", "XL"] as const;
export type TriageSize = (typeof TRIAGE_SIZES)[number];

/** A work item's ID in the tracker. */
const TrackerId = z.string().min(1).max(64);
/** A work item's identifier in the tracker, e.g. `TOOL-83`. */
const TrackerIdentifier = z.string().min(1).max(64);

/**
 * What a `triage.run` job's trigger context carries besides the issue it
 * renders into the prompt: its `triage_runs` row and the tracker the issue
 * lives in.
 */
export const TriageJobContext = z.object({
  /** The `triage_runs` row. */
  triageRunId: z.uuid(),
  trackerProvider: JobTrackerProvider.default("linear"),
});
export type TriageJobContext = z.infer<typeof TriageJobContext>;

/** An issue blocking the issue (or one of its sub-issues). */
export const TriageBlocker = z.object({
  identifier: TrackerIdentifier,
  title: z.string().max(1000),
  stateType: TrackerStateType,
  /** The issue it blocks (the triaged issue or one of its sub-issues). */
  blocks: TrackerIdentifier,
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

/** Tracker priority of a story: 1 Urgent, 2 High, 3 Medium, 4 Low. */
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
  /** The sub-issue's tracker ID. */
  id: TrackerId,
  title: z.string().trim().min(1).max(255),
  body: z.string().trim().min(1).max(MAX_DOCUMENT_LENGTH),
  priority: StoryPriority,
  /** Tracker IDs of the sibling sub-issues, and identifiers of work items outside the issue, it is blocked by. */
  blockedBy: z.array(TrackerId).max(100).default([]),
});
export type TriageSubIssueUpdate = z.infer<typeof TriageSubIssueUpdate>;

/** What a triage session decided: the issue as it should read in the tracker. */
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

/**
 * What a `triage.run` job produced, as a triage run keeps it (`triage_runs.last_result`):
 * the `triage` sink builds it from the run's `QueryRunResult` and its validated output.
 */
export const TriageRunResult = z
  .object({
    /** For the tracker session: what triage decided, or why it couldn't (`error`). */
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
