/**
 * The `ralph` capability: building a delegated Linear epic story by story.
 * The control panel orchestrates the run; agents run its jobs:
 *
 * - `ralph.story`: one attempt at one story in the epic's branch worktree
 *   (Claude session, quality gates, commit, push).
 * - `ralph.describe-pr`: a read-only session that writes the PR/MR title and body.
 * - `ralph.prepare`: runs the approved `cyralph-prepare` commands of a manual story.
 */
import { z } from "zod";
import { JobRepository } from "./protocol.js";
import { CommitSha } from "./review-job.js";

export const RALPH_CAPABILITY = "ralph";
export const RALPH_STORY_JOB_TYPE = "ralph.story";
export const RALPH_DESCRIBE_PR_JOB_TYPE = "ralph.describe-pr";
export const RALPH_PREPARE_JOB_TYPE = "ralph.prepare";
export const RALPH_JOB_TYPES = [
  RALPH_STORY_JOB_TYPE,
  RALPH_DESCRIBE_PR_JOB_TYPE,
  RALPH_PREPARE_JOB_TYPE,
] as const;

/** Attempts (not queue deliveries) a story gets before it is marked exhausted. */
export const MAX_ATTEMPTS_PER_STORY = 3;

/** Longest PRD, progress log or story description passed to an agent. */
const MAX_DOCUMENT_LENGTH = 200_000;
const MAX_FOLLOW_UPS = 50;

/** A git branch name (no `..`, `//`, `@{`, leading `-`/`/` or trailing `/`, `.` or `.lock`). */
export const GitBranch = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine(
    (b) =>
      !b.startsWith("-") &&
      !b.startsWith("/") &&
      !b.endsWith("/") &&
      !b.endsWith(".") &&
      !b.endsWith(".lock") &&
      !b.includes("..") &&
      !b.includes("//") &&
      b.split("/").every((segment) => !segment.startsWith(".")),
    { message: "invalid branch name" },
  );

const TokenUsage = z.object({ inputTokens: z.int().min(0), outputTokens: z.int().min(0) });

/** Repository settings a ralph job runs with (`repositories.ralph_settings`). */
export const RalphJobSettings = z.object({
  /** Null uses the Claude Code default model. */
  model: z.string().min(1).max(200).nullable(),
  /** Run once in a fresh branch worktree (e.g. `pnpm install`). */
  setupCommand: z.string().min(1).max(4000).nullable(),
  /** Used when `model` is overloaded; null for none. */
  fallbackModel: z.string().min(1).max(200).nullable().default(null),
  /** Appended to every story and request prompt; null for none. */
  appendInstruction: z.string().min(1).max(10_000).nullable().default(null),
  /** Agent SDK tools (or rules) the sessions are narrowed to; null: ralph's whole policy. */
  allowedTools: z.array(z.string().min(1).max(500)).max(100).nullable().default(null),
  /** Agent SDK tools (or rules) denied on top of ralph's policy; null for none. */
  disallowedTools: z.array(z.string().min(1).max(500)).max(100).nullable().default(null),
});
export type RalphJobSettings = z.infer<typeof RalphJobSettings>;

/** What every ralph job needs: its run, repository and the epic's branch. */
const RalphJobBase = z.object({
  runId: z.uuid(),
  repositoryId: z.uuid(),
  repository: JobRepository,
  /** The epic's branch; its worktree is reused across the run's jobs. */
  branch: GitBranch,
  /** The repository's default branch, which `branch` starts from and the PR/MR targets. */
  baseBranch: GitBranch,
  settings: RalphJobSettings,
});

/** A Linear issue as the agent sees it (untrusted text; quoted into prompts). */
const RalphIssue = z.object({
  /** Linear identifier, e.g. `TOOL-83`. */
  identifier: z.string().min(1).max(64),
  title: z.string().max(1000),
});

export const RALPH_EPIC_KINDS = ["children", "prd", "single"] as const;
export const RALPH_STORY_LIST_STATUSES = ["open", "in_progress", "completed", "cancelled"] as const;

/** One of the epic's stories, for the story list in the prompt. */
export const RalphStoryListItem = RalphIssue.extend({
  status: z.enum(RALPH_STORY_LIST_STATUSES),
  /** A step for a person, never for an agent. */
  manual: z.boolean().default(false),
  /** Identifiers of the issues it waits for. */
  dependsOn: z.array(z.string().min(1).max(64)).max(100).default([]),
});
export type RalphStoryListItem = z.infer<typeof RalphStoryListItem>;

/** Payload of a `ralph.story` job: one attempt at one story. */
export const RalphStoryPayload = RalphJobBase.extend({
  /** The `ralph_stories` row. */
  storyId: z.uuid(),
  /** 1 on the story's first attempt (queue redeliveries keep the attempt). */
  attempt: z.int().min(1),
  epic: RalphIssue.extend({
    /** `single`: the delegated issue is the only story (commit `<ID>: <title>`, no follow-ups). */
    kind: z.enum(RALPH_EPIC_KINDS).default("children"),
    url: z.url().nullable().default(null),
    /** The epic's PRD (its description); empty for a single issue. */
    prd: z.string().max(MAX_DOCUMENT_LENGTH),
  }),
  story: RalphIssue.extend({
    linearIssueId: z.string().min(1).max(64),
    url: z.url().nullable().default(null),
    description: z.string().max(MAX_DOCUMENT_LENGTH),
  }),
  /** Every story of the epic in order (the prompt lists them); may be empty. */
  stories: z.array(RalphStoryListItem).max(500).default([]),
  /** The commit message, e.g. `feat(TOOL-83): <title>` (or `TOOL-83: <title>` for a single issue). */
  commitMessage: z.string().min(1).max(2000),
  /**
   * The story's quality gates, run by the job after the session: the
   * repository's `verifyCommands`, then (with `runPrdQualityGates`) the PRD's.
   */
  qualityGates: z.array(z.string().min(1).max(4000)).max(100),
  /** The PRD's `## Quality Gates` commands, shown in the prompt (those the job runs aren't repeated). */
  prdQualityGates: z.array(z.string().min(1).max(4000)).max(50).default([]),
  /** The run's progress log so far. */
  progress: z.string().max(MAX_DOCUMENT_LENGTH),
  /** Why the previous attempt didn't complete; null on the first attempt. */
  lastFeedback: z.string().max(20_000).nullable(),
  /** Replies from the agent session, oldest first. */
  guidance: z.array(z.string().max(20_000)).max(100),
});
export type RalphStoryPayload = z.infer<typeof RalphStoryPayload>;

export const RALPH_STORY_STATUSES = ["complete", "incomplete", "blocked", "failed"] as const;
export type RalphStoryStatus = (typeof RALPH_STORY_STATUSES)[number];

/** Work the session found outside its story, filed as a new sub-issue. */
export const RalphFollowUp = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().max(20_000),
  /** Only a person can do it (access, outside settings, a decision). */
  manual: z.boolean(),
});
export type RalphFollowUp = z.infer<typeof RalphFollowUp>;

/** Result of a `ralph.story` job (`/api/agent/jobs/{id}/result`). */
export const RalphStoryResult = z.object({
  status: z.enum(RALPH_STORY_STATUSES),
  /** What was done, or what is in the way; posted to Linear. */
  summary: z.string().max(20_000),
  /** The pushed story commit; absent when nothing was committed. */
  commitSha: CommitSha.optional(),
  followUps: z.array(RalphFollowUp).max(MAX_FOLLOW_UPS),
  /** Why the attempt didn't complete (e.g. failed gate output), for the next attempt; null when complete. */
  feedback: z.string().max(20_000).nullable(),
  /** The whole progress log after the session, when the session changed it (replaces the run's). */
  progress: z.string().max(MAX_DOCUMENT_LENGTH).optional(),
  usage: TokenUsage,
  durationMs: z.int().min(0),
});
export type RalphStoryResult = z.infer<typeof RalphStoryResult>;

/** Payload of a `ralph.describe-pr` job: every story is done; describe the branch. */
export const RalphDescribePrPayload = RalphJobBase.extend({
  epic: RalphIssue.extend({
    url: z.url().nullable(),
    prd: z.string().max(MAX_DOCUMENT_LENGTH),
  }),
  stories: z
    .array(
      RalphIssue.extend({
        status: z.string().min(1).max(32),
        commitSha: CommitSha.nullable(),
      }),
    )
    .max(500),
  progress: z.string().max(MAX_DOCUMENT_LENGTH),
  /** The quality gates every story passed (how the work was verified). */
  qualityGates: z.array(z.string().min(1).max(4000)).max(100).default([]),
});
export type RalphDescribePrPayload = z.infer<typeof RalphDescribePrPayload>;

/** Longest PR/MR title a `ralph.describe-pr` job returns. */
export const MAX_PULL_REQUEST_TITLE_LENGTH = 72;

/** Result of a `ralph.describe-pr` job: the PR/MR the control panel opens or updates. */
export const RalphDescribePrResult = z.object({
  title: z.string().trim().min(1).max(MAX_PULL_REQUEST_TITLE_LENGTH),
  body: z.string().trim().min(1).max(60_000),
  usage: TokenUsage,
});
export type RalphDescribePrResult = z.infer<typeof RalphDescribePrResult>;

/** Payload of a `ralph.prepare` job: the approved `cyralph-prepare` commands. */
export const RalphPreparePayload = RalphJobBase.extend({
  /** The manual story whose preparation was approved. */
  story: RalphIssue,
  commands: z.array(z.string().min(1).max(4000)).min(1).max(50),
  /** SHA-256 (hex) of the commands as approved. */
  commandsHash: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * The branch's HEAD (its last story commit) the approval is bound to; nothing
   * runs if the worktree HEAD differs. Null: no story was committed yet, so
   * HEAD must have no commits on top of `origin/<baseBranch>`.
   */
  approvedHeadSha: CommitSha.nullable(),
});
export type RalphPreparePayload = z.infer<typeof RalphPreparePayload>;

export const RALPH_PREPARE_STATUSES = [
  /** Every command exited 0. */
  "completed",
  /** A command failed; later ones didn't run. */
  "failed",
  /** HEAD or the commands changed since approval; nothing ran. */
  "stale",
] as const;

/** Result of a `ralph.prepare` job. */
export const RalphPrepareResult = z.object({
  status: z.enum(RALPH_PREPARE_STATUSES),
  /** The commands that ran, in order, with their (tail-truncated) output. */
  commands: z
    .array(
      z.object({
        command: z.string().min(1).max(4000),
        exitCode: z.int().nullable(),
        output: z.string().max(20_000),
      }),
    )
    .max(50),
  /** Worktree HEAD after the commands. */
  headSha: CommitSha,
  durationMs: z.int().min(0),
});
export type RalphPrepareResult = z.infer<typeof RalphPrepareResult>;

/**
 * An agent-session activity relayed by an agent (`POST /api/agent/jobs/{id}/activities`):
 * Claude's text as a `thought`, a tool call as an (ephemeral) `action`.
 */
export const RalphActivity = z.object({
  type: z.enum(["thought", "action"]),
  /** A thought's text, or an action's name (e.g. the tool). */
  body: z.string().trim().min(1).max(10_000),
  /** An action's parameter (e.g. the command or file); ignored for thoughts. */
  parameter: z.string().max(10_000).optional(),
  /** Replaced by the session's next activity in Linear. */
  ephemeral: z.boolean().default(false),
});
export type RalphActivity = z.infer<typeof RalphActivity>;
