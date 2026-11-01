/**
 * Ralph: building a delegated epic (a work item in the tracker) story by story.
 * The control panel orchestrates the run; agents run its jobs. Stories,
 * requests and PR/MR descriptions are coding and query runs of the
 * repository's tasks, whose `jobs.type` names the run step:
 *
 * - `ralph.story`: a coding run of one attempt at one story in the epic's
 *   branch worktree (Claude session, quality gates, commit, push).
 * - `ralph.describe-pr`: a query run that writes the PR/MR title and body.
 * - `ralph.request`: a coding run doing what a request from the tracker
 *   thread asks (a mention, or a reply no story took) in a lane's branch worktree.
 * - `ralph.push`: a coding run with no session that pushes a lane's branch.
 *
 * The agent's ralph capability still runs two legacy jobs (`RALPH_JOB_TYPES`):
 *
 * - `ralph.prepare`: runs the approved `cyralph-prepare` commands of a manual story
 *   (legacy: the control panel now runs them as the `worktree.exec` system RPC,
 *   with the same payload and result).
 * - `ralph.cleanup`: removes a merged lane's branch worktree and local branch,
 *   and carries out the answers to the questions about its leftovers
 *   (legacy: the control panel now runs it as the `worktree.cleanup` system
 *   RPC, with the same payload and result).
 */
import { z } from "zod";
import { RalphRunInvoker } from "./correlation.js";
import { JobRepository } from "./protocol.js";
import { JobTrackerProvider } from "./run-tracker.js";
import { CommitSha } from "./review-job.js";
import { RALPH_HISTORY_REWRITE_POLICIES } from "./settings.js";
import { TokenUsage } from "./usage.js";

export const RALPH_STORY_JOB_TYPE = "ralph.story";
export const RALPH_DESCRIBE_PR_JOB_TYPE = "ralph.describe-pr";
export const RALPH_PREPARE_JOB_TYPE = "ralph.prepare";
export const RALPH_REQUEST_JOB_TYPE = "ralph.request";
export const RALPH_CLEANUP_JOB_TYPE = "ralph.cleanup";
/**
 * A coding run with no session that pushes a lane's branch once before its
 * PR/MR is described, when the story task pushes only at the end (`pushTiming:
 * end`).
 */
export const RALPH_PUSH_JOB_TYPE = "ralph.push";
/** The legacy job types the agent's ralph capability runs. */
export const RALPH_JOB_TYPES = [RALPH_PREPARE_JOB_TYPE, RALPH_CLEANUP_JOB_TYPE] as const;

/** Attempts (not queue deliveries) a story gets before it is marked exhausted. */
export const MAX_ATTEMPTS_PER_STORY = 3;
/**
 * Rounds (blocked results that file follow-ups, as a review loop does) a
 * story gets before it is marked exhausted. Rounds don't use attempts.
 */
export const MAX_ROUNDS_PER_STORY = 8;
/** Rounds in a row a story's reported metric may fail to beat its best before the story is set aside. */
export const STALL_ROUNDS = 3;

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

/**
 * What a ralph job runs with besides its run spec: the repo's coding instructions, and (for
 * agents that predate playbook coding settings, and the `worktree.exec` and `worktree.cleanup`
 * RPCs, which have no run spec) its story or request playbook's model and worktree setup command.
 */
export const RalphJobSettings = z.object({
  /** The playbook's model; null uses the Claude Code default model. */
  model: z.string().min(1).max(200).nullable(),
  /** The playbook's `worktreeSetupCommand`: run once in a fresh branch worktree (e.g. `pnpm install`). */
  setupCommand: z.string().min(1).max(4000).nullable(),
  /** The playbook's fallback model, used when `model` is overloaded; null for none. */
  fallbackModel: z.string().min(1).max(200).nullable().default(null),
  /** The repo's coding instructions, appended to every story and request prompt; null for none. */
  appendInstruction: z.string().min(1).max(10_000).nullable().default(null),
  /** Always null: a playbook's tools set the session's tools. Kept for older agents. */
  allowedTools: z.array(z.string().min(1).max(500)).max(100).nullable().default(null),
  /** Always null: a playbook's tools set the session's tools. Kept for older agents. */
  disallowedTools: z.array(z.string().min(1).max(500)).max(100).nullable().default(null),
});
export type RalphJobSettings = z.infer<typeof RalphJobSettings>;

/** Prefix of the hidden refs runs keep their unpushed story commits on (see `ralphHiddenRef`). */
export const RALPH_HIDDEN_REF_PREFIX = "refs/omniralph/runs/";

/** A run's hidden ref (`ralphHiddenRef`). */
const RalphHiddenRef = z
  .string()
  .max(255)
  .regex(/^refs\/omniralph\/runs\/[0-9a-f-]{36}$/);

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

/** The tracker the run's work items live in. */
const RalphTrackerProvider = JobTrackerProvider.default("linear");
/**
 * The tracker's display name, which prompts name it by (`tracker.name`). The control panel
 * fills it from the provider; it defaults to the default provider's.
 */
const RalphTrackerName = z.string().min(1).max(100).default("Linear");

/** A work item as the agent sees it (untrusted text; quoted into prompts). */
const RalphIssue = z.object({
  /** The tracker's identifier, e.g. `TOOL-83`. */
  identifier: z.string().min(1).max(64),
  title: z.string().max(1000),
});

export const RALPH_EPIC_KINDS = ["children", "prd", "single"] as const;
export const RALPH_STORY_LIST_STATUSES = ["open", "in_progress", "completed", "cancelled"] as const;
/** A task's kind: a Fix (a bug, by the tracker's fix labels) or a Story (new work). */
export const RALPH_STORY_KINDS = ["fix", "story"] as const;
export type RalphStoryKind = (typeof RALPH_STORY_KINDS)[number];

/** Longest tracker attachment a ralph job downloads. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Attachments a ralph job downloads at most (not counting those its agent has cached). */
export const MAX_ATTACHMENT_DOWNLOADS_PER_JOB = 20;

/** An attachment ID: hex, derived from the upload URL. */
export const RalphAttachmentId = z.string().regex(/^[0-9a-f]{32}$/);

/**
 * A file uploaded to the tracker (a pasted screenshot, a mockup, a PDF) that the
 * job may download through `GET /api/agent/jobs/{id}/attachments/{attachmentId}`.
 */
export const RalphAttachment = z.object({
  id: RalphAttachmentId,
  /** The name the tracker stores with the upload (e.g. `mockup.png`), when known. */
  title: z.string().min(1).max(500).nullable(),
  /** Where it was referenced, e.g. `TOOL-83 description`, `comment on TOOL-84 by Ana`, `<tracker> thread` (the tracker's name). */
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

/** Trigger context of a `ralph.story` coding run: one attempt at one story. */
export const RalphStoryPayload = RalphJobBase.extend({
  /** The tracker the epic and its stories live in. */
  trackerProvider: RalphTrackerProvider,
  trackerName: RalphTrackerName,
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
    /** The work item's ID in the tracker. */
    trackerIssueId: z.string().min(1).max(64),
    url: z.url().nullable().default(null),
    description: z.string().max(MAX_DOCUMENT_LENGTH),
    /** `fix` when the work item has one of the tracker's fix labels, else `story`. */
    kind: z.enum(RALPH_STORY_KINDS).default("story"),
  }),
  /** Every story of the epic in order (the prompt lists them); may be empty. */
  stories: z.array(RalphStoryListItem).max(500).default([]),
  /** The commit message, e.g. `feat(TOOL-83): <title>` (or `TOOL-83: <title>` for a single issue). */
  commitMessage: z.string().min(1).max(2000),
  /**
   * The story's quality gates, run by the job after the session: the lane
   * repository's checks, then (with `runPrdQualityGates`) the PRD's.
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
  /** The tracker attachments in the story's scope: its own, and those of the epic and thread. */
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

/** Most recommendations kept per story. */
export const MAX_RALPH_RECOMMENDATIONS = 20;

/**
 * Most recommendations in one story result (the agent keeps as many from a session), so one attempt
 * can't push every earlier attempt's out of the story's list.
 */
export const MAX_RALPH_RESULT_RECOMMENDATIONS = 10;

/**
 * Advice the session gave for another project or repository (e.g. an upstream fix that would let a
 * workaround go): shown in the run, never filed as an issue, and it doesn't hold the story up.
 */
export const RalphRecommendation = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().max(20_000),
});
export type RalphRecommendation = z.infer<typeof RalphRecommendation>;

export const RALPH_METRIC_DIRECTIONS = ["higher", "lower"] as const;
export type RalphMetricDirection = (typeof RALPH_METRIC_DIRECTIONS)[number];

/** A progress metric a story reports each round of a review loop (e.g. a critique score). */
export const RalphStoryMetric = z.object({
  name: z.string().trim().min(1).max(200),
  value: z.number(),
  /** Whether a higher or a lower value is better. */
  direction: z.enum(RALPH_METRIC_DIRECTIONS),
  /** The value the story aims for, when it has one (shown, not acted on). */
  target: z.number().optional(),
});
export type RalphStoryMetric = z.infer<typeof RalphStoryMetric>;

/** Outcome of a `ralph.story` coding run (`/api/agent/jobs/{id}/result`). */
export const RalphStoryResult = z.object({
  status: z.enum(RALPH_STORY_STATUSES),
  /** What was done, or what is in the way; posted to the tracker. */
  summary: z.string().max(20_000),
  /** The pushed story commit; absent when nothing was committed. */
  commitSha: CommitSha.optional(),
  /**
   * A run that pushes only at the end (`pushTiming: end`): the hidden ref
   * (`ralphHiddenRef`) HEAD was pushed to instead of the branch, and the SHA
   * pushed. Absent when the branch was pushed, or nothing was.
   */
  hiddenRef: z.object({ ref: z.string().min(1).max(255), sha: CommitSha }).optional(),
  followUps: z.array(RalphFollowUp).max(MAX_FOLLOW_UPS),
  /** Advice for other projects (older agents never send any). */
  recommendations: z.array(RalphRecommendation).max(MAX_RALPH_RESULT_RECOMMENDATIONS).optional(),
  /** The story's progress metric this round, when it reports one (older agents never do). */
  metric: RalphStoryMetric.optional(),
  /** Why the attempt didn't complete (e.g. failed gate output), for the next attempt; null when complete. */
  feedback: z.string().max(20_000).nullable(),
  /** The whole progress log after the session, when the session changed it (replaces the run's). */
  progress: z.string().max(MAX_DOCUMENT_LENGTH).optional(),
  usage: TokenUsage,
  durationMs: z.int().min(0),
});
export type RalphStoryResult = z.infer<typeof RalphStoryResult>;

/** What a `ralph.describe-pr` query run describes: every story is done; describe the branch. */
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

/**
 * The `run.invoked` trigger context of a coding run's PR/MR description (a
 * query run of its story task's `prDescriptionTaskId`): the invoking ralph
 * run, the `ralph.describe-pr` payload as `payload`, and the values the
 * task's template renders (`describePrTemplateContext` in `@omniralph/ralph`).
 */
export const RalphDescribePrTriggerContext = z.looseObject({
  invoker: RalphRunInvoker,
  payload: RalphDescribePrPayload,
});
export type RalphDescribePrTriggerContext = z.infer<typeof RalphDescribePrTriggerContext>;

/** Longest PR/MR title a `ralph.describe-pr` run returns. */
export const MAX_PULL_REQUEST_TITLE_LENGTH = 72;

/** A PR/MR description a `ralph.describe-pr` run writes: the PR/MR the control panel opens or updates. */
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

/** Payload of a `worktree.exec` system RPC: the same as a `ralph.prepare` job's. */
export const WorktreeExecPayload = RalphPreparePayload;
export type WorktreeExecPayload = RalphPreparePayload;
/** Result of a `worktree.exec` system RPC: the same as a `ralph.prepare` job's. */
export const WorktreeExecResult = RalphPrepareResult;
export type WorktreeExecResult = RalphPrepareResult;

/** Where a run's requests come from: the tracker (an agent session or the work item's comments) or a chat thread. */
export const RALPH_REQUEST_SOURCES = ["tracker", "chat"] as const;
export type RalphRequestSource = (typeof RALPH_REQUEST_SOURCES)[number];

/** Trigger context of a `ralph.request` coding run: a lane's pending requests, done in one Claude session. */
export const RalphRequestPayload = RalphJobBase.extend({
  /** The tracker the epic lives in (a chat request's too, when it builds an epic). */
  trackerProvider: RalphTrackerProvider,
  trackerName: RalphTrackerName,
  /** Where the requests come from. */
  source: z.enum(RALPH_REQUEST_SOURCES),
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
  /** The lane repository's checks, then (with `runPrdQualityGates`) the PRD's gates. */
  qualityGates: z.array(z.string().min(1).max(4000)).max(100).default([]),
  /** Whether an explicit request may rebase and `--force-with-lease` the branch (the repo's). */
  historyRewrite: z.enum(RALPH_HISTORY_REWRITE_POLICIES).default("when-asked"),
  /**
   * The lane's last request session, resumed for a follow-up. Only set when
   * the job goes to the agent holding that session's files.
   */
  resumeSessionId: z.string().min(1).max(200).nullable().default(null),
  /** Every tracker attachment of the run (the epic, its stories and the thread). */
  attachments: RalphAttachments,
  /**
   * `/ship`: the session prepares one commit and describes it; the job
   * commits, pushes the branch, and opens the PR/MR when there is none.
   */
  ship: z.boolean().default(false),
  /**
   * The run's hidden ref when its story task pushes only at the end: the
   * worktree starts from the story commits kept there (the branch on
   * `origin` may not have them yet). Absent: the branch has them.
   */
  hiddenRef: RalphHiddenRef.optional(),
});
export type RalphRequestPayload = z.infer<typeof RalphRequestPayload>;

/**
 * Trigger context of a `ralph.push` coding run: push the lane's branch, with
 * the story commits kept on the run's hidden ref, before its PR/MR is
 * described. No session runs.
 */
export const RalphPushPayload = RalphJobBase.extend({
  hiddenRef: RalphHiddenRef,
});
export type RalphPushPayload = z.infer<typeof RalphPushPayload>;

/** Result of a `ralph.push` coding run: the branch's pushed head. */
export const RalphPushResult = z.object({
  pushed: z.object({ branch: GitBranch, sha: CommitSha }),
  durationMs: z.int().min(0),
});
export type RalphPushResult = z.infer<typeof RalphPushResult>;

export const RALPH_PULL_REQUEST_ACTIONS = ["open", "update", "ready"] as const;

/** A PR/MR change a request session asked for; the control panel makes it. */
export const RalphPullRequestAction = z.object({
  action: z.enum(RALPH_PULL_REQUEST_ACTIONS),
  title: z.string().trim().min(1).max(500).optional(),
  body: z.string().trim().min(1).max(60_000).optional(),
});
export type RalphPullRequestAction = z.infer<typeof RalphPullRequestAction>;

export const RALPH_FINDING_OUTCOMES = ["fixed", "skipped"] as const;

/** What a request session did with a review finding; the control panel replies in its thread. */
export const RalphFindingOutcome = z.object({
  findingId: z.uuid(),
  outcome: z.enum(RALPH_FINDING_OUTCOMES),
  comment: z.string().trim().min(1).max(2000),
});
export type RalphFindingOutcome = z.infer<typeof RalphFindingOutcome>;

/** Outcome of a `ralph.request` coding run. */
export const RalphRequestResult = z.object({
  /** For the tracker thread: what the session did, or why it couldn't (`error`). */
  summary: z.string().max(20_000),
  /** Set when the session failed or ended without a valid structured result. */
  error: z.string().max(20_000).nullable().default(null),
  /** The Claude session, resumed by the lane's next request on the same agent. */
  sessionId: z.string().min(1).max(200).nullable(),
  pullRequest: RalphPullRequestAction.optional(),
  /** The review findings the session fixed or skipped. */
  findings: z.array(RalphFindingOutcome).max(50).optional(),
  /** What the session left uncommitted, stashed. */
  stashSha: CommitSha.optional(),
  /** `/ship`: the commit the job made (absent when there was nothing to commit). */
  commitSha: CommitSha.optional(),
  /** `/ship`: whether the job pushed the branch. */
  pushed: z.boolean().optional(),
  usage: TokenUsage,
  durationMs: z.int().min(0),
});
export type RalphRequestResult = z.infer<typeof RalphRequestResult>;

/** Label prefix of every stash entry a run's jobs make (story, request and cleanup stashes). */
export function ralphStashPrefix(runId: string): string {
  return `omniralph ralph ${runId} `;
}

/**
 * The ref outside `refs/heads/` a run that pushes only at the end keeps its
 * story commits on, on `origin`: it starts no CI, and another agent picking
 * the run up starts from it.
 */
export function ralphHiddenRef(runId: string): string {
  return `${RALPH_HIDDEN_REF_PREFIX}${runId}`;
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
   * The keep-branch form (`keepBranch: true`, no `mergedSha`: the PR/MR closed
   * unmerged or the run stopped) only stashes and removes the worktree.
   */
  z
    .object({
      kind: z.literal("cleanup"),
      /** The PR/MR head that was merged. */
      mergedSha: CommitSha.optional(),
      /** Keep the local branch whatever it holds (a stopped run may resume from it). */
      keepBranch: z.literal(true).optional(),
      /** Stash entries recorded on the lane (e.g. by earlier runs of the issue). */
      stashes: z.array(CommitSha).max(200).default([]),
    })
    .refine((action) => !!action.mergedSha !== !!action.keepBranch, {
      message: "Give either mergedSha or keepBranch",
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

/** Most hidden refs one cleanup deletes. */
export const MAX_CLEANUP_HIDDEN_REFS = 50;

/**
 * Payload of a `ralph.cleanup` job (and a `worktree.cleanup` RPC), on the
 * run's sticky agent when it has an `action` (it holds the worktree).
 */
export const RalphCleanupPayload = RalphJobBase.extend({
  /** The epic, which names the stash branch. */
  epic: RalphIssue.pick({ identifier: true }),
  /** Absent: only `hiddenRefs` are deleted (on any agent). */
  action: RalphCleanupAction.optional(),
  /**
   * Hidden refs (`ralphHiddenRef`) of finished runs to delete on `origin`
   * after the action; nothing else may be listed (no branch is ever deleted).
   */
  hiddenRefs: z.array(RalphHiddenRef).max(MAX_CLEANUP_HIDDEN_REFS).optional(),
}).refine((payload) => !!payload.action || (payload.hiddenRefs?.length ?? 0) > 0, {
  message: "Give an action or hidden refs to delete",
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
  /** The payload's `hiddenRefs` no longer on `origin` (deleted now, or already gone). */
  deletedRefs: z.array(z.string().min(1).max(255)).max(MAX_CLEANUP_HIDDEN_REFS).default([]),
  durationMs: z.int().min(0),
});
export type RalphCleanupResult = z.infer<typeof RalphCleanupResult>;

/** Payload of a `worktree.cleanup` system RPC: the same as a `ralph.cleanup` job's. */
export const WorktreeCleanupPayload = RalphCleanupPayload;
export type WorktreeCleanupPayload = RalphCleanupPayload;
/** Result of a `worktree.cleanup` system RPC: the same as a `ralph.cleanup` job's. */
export const WorktreeCleanupResult = RalphCleanupResult;
export type WorktreeCleanupResult = RalphCleanupResult;

/**
 * An agent-session activity relayed by an agent (`POST /api/agent/jobs/{id}/activities`):
 * Claude's text as a `thought`, a tool call as an (ephemeral) `action`.
 */
/**
 * A tool call a running ralph job's session needs a person's approval for
 * (the repository's Claude Code settings `ask` about it):
 * `POST /api/agent/jobs/{id}/permissions`. The control panel asks in the
 * run's tracker session.
 */
export const RalphPermissionRequest = z.object({
  /** Chosen by the agent; the answer is read back with it. */
  requestId: z.uuid(),
  /** The tool, e.g. `Bash`. */
  tool: z.string().trim().min(1).max(200),
  /** What the call does, e.g. the command. */
  detail: z.string().max(4000).default(""),
  /** Why Claude Code asks (its decision reason), if it said. */
  reason: z.string().max(1000).optional(),
  /** How long the agent waits for an answer before it denies the call. */
  timeoutSeconds: z.int().min(1).max(86_400),
});
export type RalphPermissionRequest = z.infer<typeof RalphPermissionRequest>;

export const RALPH_PERMISSION_STATUSES = ["pending", "allowed", "denied", "expired"] as const;
export type RalphPermissionStatus = (typeof RALPH_PERMISSION_STATUSES)[number];

/** `GET /api/agent/jobs/{id}/permissions/{requestId}`: the answer so far. */
export const RalphPermissionAnswer = z.object({
  status: z.enum(RALPH_PERMISSION_STATUSES),
  /** Who answered in the tracker, when known. */
  answeredBy: z.string().nullable().default(null),
});
export type RalphPermissionAnswer = z.infer<typeof RalphPermissionAnswer>;

export const RalphActivity = z.object({
  type: z.enum(["thought", "action"]),
  /** A thought's text, or an action's name (e.g. the tool). */
  body: z.string().trim().min(1).max(10_000),
  /** An action's parameter (e.g. the command or file); ignored for thoughts. */
  parameter: z.string().max(10_000).optional(),
  /** Replaced by the session's next activity in the tracker. */
  ephemeral: z.boolean().default(false),
});
export type RalphActivity = z.infer<typeof RalphActivity>;
