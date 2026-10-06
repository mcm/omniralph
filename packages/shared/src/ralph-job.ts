/**
 * The `ralph` capability: building a delegated Linear epic story by story.
 * The control panel orchestrates the run; agents run its jobs:
 *
 * - `ralph.story`: one attempt at one story in the epic's branch worktree
 *   (Claude session, quality gates, commit, push).
 * - `ralph.describe-pr`: a read-only session that writes the PR/MR title and body.
 * - `ralph.prepare`: runs the approved `cyralph-prepare` commands of a manual story.
 * - `ralph.request`: one Claude session doing what a request from the Linear
 *   thread asks (a mention, or a reply no story took) in a lane's branch worktree.
 * - `ralph.cleanup`: removes a merged lane's branch worktree and local branch,
 *   and carries out the answers to the questions about its leftovers.
 */
import { z } from "zod";
import { JobRepository } from "./protocol.js";
import { CommitSha } from "./review-job.js";
import { RALPH_HISTORY_REWRITE_POLICIES } from "./settings.js";

export const RALPH_CAPABILITY = "ralph";
export const RALPH_STORY_JOB_TYPE = "ralph.story";
export const RALPH_DESCRIBE_PR_JOB_TYPE = "ralph.describe-pr";
export const RALPH_PREPARE_JOB_TYPE = "ralph.prepare";
export const RALPH_REQUEST_JOB_TYPE = "ralph.request";
export const RALPH_CLEANUP_JOB_TYPE = "ralph.cleanup";
export const RALPH_JOB_TYPES = [
  RALPH_STORY_JOB_TYPE,
  RALPH_DESCRIBE_PR_JOB_TYPE,
  RALPH_PREPARE_JOB_TYPE,
  RALPH_REQUEST_JOB_TYPE,
  RALPH_CLEANUP_JOB_TYPE,
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

/** Longest Linear attachment a ralph job downloads. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Attachments a ralph job downloads at most (not counting those its agent has cached). */
export const MAX_ATTACHMENT_DOWNLOADS_PER_JOB = 20;

/** An attachment ID: hex, derived from the upload URL. */
export const RalphAttachmentId = z.string().regex(/^[0-9a-f]{32}$/);

/**
 * A file uploaded to Linear (a pasted screenshot, a mockup, a PDF) that the
 * job may download through `GET /api/agent/jobs/{id}/attachments/{attachmentId}`.
 */
export const RalphAttachment = z.object({
  id: RalphAttachmentId,
  /** The name Linear stores with the upload (e.g. `mockup.png`), when known. */
  title: z.string().min(1).max(500).nullable(),
  /** Where it was referenced, e.g. `TOOL-83 description`, `comment on TOOL-84 by Ana`, `Linear thread`. */
  sources: z.array(z.string().min(1).max(500)).min(1).max(50),
});
export type RalphAttachment = z.infer<typeof RalphAttachment>;

const RalphAttachments = z.array(RalphAttachment).max(200).default([]);

/** One of the epic's stories, for the story list in the prompt. */
export const RalphStoryListItem = RalphIssue.extend({
  status: z.enum(RALPH_STORY_LIST_STATUSES),
  /** A step for a person, never for an agent. */
  manual: z.boolean().default(false),
  /** Identifiers of the issues it waits for. */
  dependsOn: z.array(z.string().min(1).max(64)).max(100).default([]),
  /** The repository (full path) the story is worked in, when it isn't the epic's main one. */
  repository: z.string().min(1).max(500).nullable().default(null),
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
  /** The Linear attachments in the story's scope: its own, and those of the epic and thread. */
  attachments: RalphAttachments,
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

/** Payload of a `ralph.request` job: a lane's pending requests, done in one Claude session. */
export const RalphRequestPayload = RalphJobBase.extend({
  epic: RalphIssue.extend({
    kind: z.enum(RALPH_EPIC_KINDS).default("children"),
    url: z.url().nullable().default(null),
    /** The epic's PRD (its description); empty for a single issue. */
    prd: z.string().max(MAX_DOCUMENT_LENGTH),
  }),
  /** Every story of the epic in order, for the status in the prompt. */
  stories: z.array(RalphStoryListItem).max(500).default([]),
  /** The requests (`ralph_messages`), oldest first. */
  requests: z
    .array(z.object({ id: z.uuid(), text: z.string().min(1).max(20_000) }))
    .min(1)
    .max(50),
  /** The lane's open PR/MR, if any. */
  prUrl: z.url().nullable().default(null),
  /** The run's progress log so far. */
  progress: z.string().max(MAX_DOCUMENT_LENGTH),
  /** The repository's `verifyCommands`, then (with `runPrdQualityGates`) the PRD's gates. */
  qualityGates: z.array(z.string().min(1).max(4000)).max(100).default([]),
  /** Whether an explicit request may rebase and `--force-with-lease` the branch. */
  historyRewrite: z.enum(RALPH_HISTORY_REWRITE_POLICIES).default("when-asked"),
  /**
   * The lane's last request session, resumed for a follow-up. Only set when
   * the job goes to the agent holding that session's files.
   */
  resumeSessionId: z.string().min(1).max(200).nullable().default(null),
  /** Every Linear attachment of the run (the epic, its stories and the thread). */
  attachments: RalphAttachments,
});
export type RalphRequestPayload = z.infer<typeof RalphRequestPayload>;

export const RALPH_PULL_REQUEST_ACTIONS = ["open", "update", "ready"] as const;

/** A PR/MR change a request session asked for; the control panel makes it. */
export const RalphPullRequestAction = z.object({
  action: z.enum(RALPH_PULL_REQUEST_ACTIONS),
  title: z.string().trim().min(1).max(500).optional(),
  body: z.string().trim().min(1).max(60_000).optional(),
});
export type RalphPullRequestAction = z.infer<typeof RalphPullRequestAction>;

/** Result of a `ralph.request` job. */
export const RalphRequestResult = z.object({
  /** For the Linear thread: what the session did, or why it couldn't (`error`). */
  summary: z.string().max(20_000),
  /** Set when the session failed or ended without a valid structured result. */
  error: z.string().max(20_000).nullable().default(null),
  /** The Claude session, resumed by the lane's next request on the same agent. */
  sessionId: z.string().min(1).max(200).nullable(),
  pullRequest: RalphPullRequestAction.optional(),
  /** What the session left uncommitted, stashed. */
  stashSha: CommitSha.optional(),
  usage: TokenUsage,
  durationMs: z.int().min(0),
});
export type RalphRequestResult = z.infer<typeof RalphRequestResult>;

/** Label prefix of every stash entry a run's jobs make (story, request and cleanup stashes). */
export function ralphStashPrefix(runId: string): string {
  return `omniralph ralph ${runId} `;
}

/** Branch on `origin` that keeps an epic's leftover stash entries (cyralph's `cyralph/stash/<epic>`). */
export function ralphStashBranch(epicIdentifier: string): string {
  return `ralph/stash/${epicIdentifier.toLowerCase()}`;
}

/** What a `ralph.cleanup` job does. */
export const RalphCleanupAction = z.discriminatedUnion("kind", [
  /**
   * The lane's PR/MR merged: stash what the worktree has uncommitted, remove
   * the worktree, and delete the local branch unless it has commits the
   * merged head doesn't. Lists the run's stash entries still in the stash list.
   */
  z.object({
    kind: z.literal("cleanup"),
    /** The PR/MR head that was merged. */
    mergedSha: CommitSha,
    /** Stash entries recorded on the lane (e.g. by earlier runs of the issue). */
    stashes: z.array(CommitSha).max(200).default([]),
  }),
  /** Answer to the stash question: push them (one commit each) to `ralphStashBranch`, then drop them; or drop them. */
  z.object({
    kind: z.literal("stashes"),
    push: z.boolean(),
    shas: z.array(CommitSha).min(1).max(200),
  }),
  /** Answer to the branch question (or its timeout): push the local branch to `origin`, then delete it; or delete it. */
  z.object({ kind: z.literal("branch"), push: z.boolean() }),
]);
export type RalphCleanupAction = z.infer<typeof RalphCleanupAction>;

/** Payload of a `ralph.cleanup` job, on the run's sticky agent (it holds the worktree). */
export const RalphCleanupPayload = RalphJobBase.extend({
  /** The epic, which names the stash branch. */
  epic: RalphIssue.pick({ identifier: true }),
  action: RalphCleanupAction,
});
export type RalphCleanupPayload = z.infer<typeof RalphCleanupPayload>;

/** A stash entry the cleanup found. */
export const RalphCleanupStash = z.object({
  sha: CommitSha,
  /** The message it was stashed with. */
  label: z.string().max(2000),
  /** When it was stashed (ISO 8601). */
  date: z.string().max(64),
});
export type RalphCleanupStash = z.infer<typeof RalphCleanupStash>;

/** Result of a `ralph.cleanup` job. */
export const RalphCleanupResult = z.object({
  /** Set when the git work failed (the answer can be given again); the rest is then empty. */
  error: z.string().max(20_000).nullable().default(null),
  /** `cleanup`: the branch worktree was there and is removed now. */
  removedWorktree: z.boolean().default(false),
  /** `cleanup`: the local branch was there. */
  hadBranch: z.boolean().default(false),
  /** `cleanup`: the worktree's uncommitted changes, stashed before it was removed. */
  stashed: CommitSha.nullable().default(null),
  /** `cleanup`: commits on the kept local branch that the merged head doesn't have (0: deleted). */
  unmerged: z.int().min(0).default(0),
  /** `cleanup`: the run's stash entries (and the lane's) still in the stash list, newest first. */
  stashes: z.array(RalphCleanupStash).max(200).default([]),
  /** `stashes`: how many entries were pushed or dropped. */
  handled: z.int().min(0).default(0),
  durationMs: z.int().min(0),
});
export type RalphCleanupResult = z.infer<typeof RalphCleanupResult>;

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
