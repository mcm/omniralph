/**
 * How a ralph run's stories, requests, pushes and PR/MR descriptions run:
 * coding and query runs of the repository's story and request tasks (and the
 * story task's PR description task), the ralph payloads as their trigger
 * context, and the limits the loop reads from those tasks.
 */
import type { Job, RalphMessage, RalphMessageTrigger, RalphRun, Repository } from "@omniralph/db";
import {
  auditEpicTemplateContext,
  describePrTemplateContext,
  fitPullRequestDescription,
  readPullRequestDescription,
  verifyTaskTemplateContext,
} from "@omniralph/ralph";
import type {
  RalphAuditEpicPayload,
  RalphDescribePrPayload,
  RalphVerifyTaskPayload,
} from "@omniralph/shared";
import {
  MAX_ATTEMPTS_PER_STORY,
  MAX_ROUNDS_PER_STORY,
  QueryRunResult,
  RalphAuditEpicTriggerContext,
  RalphDescribePrTriggerContext,
  RalphEpicAuditResult,
  RalphPushResult,
  RalphTaskVerdict,
  RalphVerifyTaskTriggerContext,
  RunSpecJobPayload,
  STALL_ROUNDS,
  type RalphPushPayload,
  type RalphRequestPayload,
  type RalphStoryPayload,
} from "@omniralph/shared";
import {
  CODING_DEFAULTS,
  DEFAULT_MAX_AUDIT_ROUNDS,
  playbookRunSpec,
  type PushTiming,
  type TaskDefinition,
  type TriggerKind,
} from "@omniralph/tasks";
import type { runSpecJobInput } from "@/lib/runs/job";
import { getPlaybookTask, taskJobInput, type PlaybookSource } from "@/lib/playbooks";

/** Story attempts a run makes before it stops and asks (cyralph's `maxIterationsPerRun`). */
export const MAX_ITERATIONS_PER_RUN = 50;

type CodingRepository = Pick<Repository, "storyPlaybookId" | "requestPlaybookId">;

/** The coding task `id`, or null when it's unknown or of another task type. */
export async function codingTask(
  id: string,
  definitions: PlaybookSource,
): Promise<TaskDefinition | null> {
  const task = await getPlaybookTask(definitions, id);
  return task?.taskType === "coding" ? task : null;
}

/** The coding task a story attempt runs: the repository's `story_task_id`. */
export function storyTaskFor(repository: Pick<Repository, "storyPlaybookId">): string {
  return repository.storyPlaybookId;
}

/**
 * The coding task a lane's requests run: the run's own `coding_task_id` (a
 * chat run's "start work" task) when set, else the repository's
 * `request_task_id`.
 */
export function requestTaskFor(
  run: Pick<RalphRun, "codingTaskId">,
  repository: Pick<Repository, "requestPlaybookId">,
): string {
  return run.codingTaskId ?? repository.requestPlaybookId;
}

/**
 * A request run's trigger kind: that of its oldest request (requests from
 * before the column existed count as tracker mentions).
 */
export function requestTrigger(
  requests: readonly Partial<Pick<RalphMessage, "trigger">>[],
): RalphMessageTrigger {
  return requests[0]?.trigger ?? "tracker.mention";
}

/** How a run's story attempts are capped. */
export interface StoryLimits {
  maxAttemptsPerStory: number;
  /** Rounds (blocked results that file follow-ups) a story gets. */
  maxRoundsPerStory: number;
  /** Rounds in a row a story's metric may fail to beat its best. */
  stallRounds: number;
  maxIterationsPerRun: number;
}

/** The caps of a story's attempts and rounds. */
export type StoryCaps = Pick<
  StoryLimits,
  "maxAttemptsPerStory" | "maxRoundsPerStory" | "stallRounds"
>;

/** The story caps of a coding task that sets none. */
const DEFAULT_STORY_CAPS: StoryCaps = {
  maxAttemptsPerStory: MAX_ATTEMPTS_PER_STORY,
  maxRoundsPerStory: MAX_ROUNDS_PER_STORY,
  stallRounds: STALL_ROUNDS,
};

/** A coding task's story caps, the defaults where it has none. */
function taskStoryCaps(task: TaskDefinition | null | undefined): StoryCaps {
  return {
    maxAttemptsPerStory: task?.maxAttemptsPerStory ?? MAX_ATTEMPTS_PER_STORY,
    maxRoundsPerStory: task?.maxRoundsPerStory ?? MAX_ROUNDS_PER_STORY,
    stallRounds: task?.stallRounds ?? STALL_ROUNDS,
  };
}

/**
 * The story caps of a repository's runs: its story task's
 * `maxAttemptsPerStory`/`maxRoundsPerStory`/`stallRounds`/
 * `maxIterationsPerRun` (the defaults where it sets none, or without a repository).
 */
export async function storyLimits(
  repository: CodingRepository | null | undefined,
  definitions: PlaybookSource,
): Promise<StoryLimits> {
  const task = repository ? await codingTask(storyTaskFor(repository), definitions) : null;
  return {
    ...taskStoryCaps(task),
    maxIterationsPerRun: task?.maxIterationsPerRun ?? MAX_ITERATIONS_PER_RUN,
  };
}

/** The attempts and rounds a story gets, by the job that ran its last attempt (its coding task's, else the defaults). */
export async function jobStoryCaps(
  job: Pick<Job, "taskId"> | null,
  definitions: PlaybookSource,
): Promise<StoryCaps> {
  const task = job?.taskId ? await codingTask(job.taskId, definitions) : null;
  return task ? taskStoryCaps(task) : DEFAULT_STORY_CAPS;
}

/**
 * The coding settings of a story or request playbook, which its runs (and the run they
 * belong to) work with: its own, `CODING_DEFAULTS` where it sets none (or when it isn't a
 * coding playbook).
 */
export interface CodingSettings {
  /** The playbook's model; null for the Claude Code default. */
  model: string | null;
  fallbackModel: string | null;
  /** Run once in a fresh branch worktree; null for none. */
  worktreeSetupCommand: string | null;
  runPrdQualityGates: boolean;
  /** Offer to run a manual story's preparation commands. */
  allowPreparation: boolean;
  /** The state the epic moves to when every story is complete; null leaves it. */
  epicCompletedState: string | null;
  /** Remove the worktree and local branch after the PR/MR merges. */
  cleanupMergedWorktrees: boolean;
  unmergedBranchTimeoutMinutes: number;
  /** Review rounds a lane's PR/MR gets. */
  maxReviewRounds: number;
  /** CI fix rounds a lane's PR/MR gets. */
  maxFixRounds: number;
}

/** The coding settings of a playbook that sets none. */
export const DEFAULT_CODING_SETTINGS: CodingSettings = {
  model: null,
  fallbackModel: null,
  worktreeSetupCommand: CODING_DEFAULTS.worktreeSetupCommand,
  runPrdQualityGates: CODING_DEFAULTS.runPrdQualityGates,
  allowPreparation: CODING_DEFAULTS.allowPreparation,
  epicCompletedState: CODING_DEFAULTS.epicCompletedState,
  cleanupMergedWorktrees: CODING_DEFAULTS.cleanupMergedWorktrees,
  unmergedBranchTimeoutMinutes: CODING_DEFAULTS.unmergedBranchTimeoutMinutes,
  maxReviewRounds: CODING_DEFAULTS.maxReviewRounds,
  maxFixRounds: CODING_DEFAULTS.maxFixRounds,
};

/** The coding settings of the playbook `id` (`DEFAULT_CODING_SETTINGS` where it sets none). */
export async function codingSettings(
  id: string,
  definitions: PlaybookSource,
): Promise<CodingSettings> {
  const playbook = await definitions.getPlaybook(id);
  const task = playbook ? playbookRunSpec(playbook).task : null;
  if (!playbook || task?.taskType !== "coding") return DEFAULT_CODING_SETTINGS;
  const d = DEFAULT_CODING_SETTINGS;
  return {
    model: playbook.model,
    fallbackModel: playbook.fallbackModel,
    worktreeSetupCommand: task.worktreeSetupCommand ?? d.worktreeSetupCommand,
    runPrdQualityGates: task.runPrdQualityGates ?? d.runPrdQualityGates,
    allowPreparation: task.allowPreparation ?? d.allowPreparation,
    epicCompletedState: task.epicCompletedState ?? d.epicCompletedState,
    cleanupMergedWorktrees: task.cleanupMergedWorktrees ?? d.cleanupMergedWorktrees,
    unmergedBranchTimeoutMinutes:
      task.unmergedBranchTimeoutMinutes ?? d.unmergedBranchTimeoutMinutes,
    maxReviewRounds: task.maxReviewRounds ?? d.maxReviewRounds,
    maxFixRounds: task.maxFixRounds ?? d.maxFixRounds,
  };
}

/** The coding settings of a repository's story playbook, which apply to its runs as a whole. */
export function storyCodingSettings(
  repository: Pick<Repository, "storyPlaybookId">,
  definitions: PlaybookSource,
): Promise<CodingSettings> {
  return codingSettings(storyTaskFor(repository), definitions);
}

/** The coding settings of the playbook a lane's requests run (`requestTaskFor`). */
export function requestCodingSettings(
  run: Pick<RalphRun, "codingTaskId">,
  repository: Pick<Repository, "requestPlaybookId">,
  definitions: PlaybookSource,
): Promise<CodingSettings> {
  return codingSettings(requestTaskFor(run, repository), definitions);
}

/** How many review and CI fix rounds a lane's PR/MR gets. */
export type RoundLimits = Pick<CodingSettings, "maxReviewRounds" | "maxFixRounds">;

/** The `maxReviewRounds`/`maxFixRounds` of the run's request playbook (which runs the rounds). */
export async function roundLimits(
  run: Pick<RalphRun, "codingTaskId">,
  repository: Pick<Repository, "requestPlaybookId">,
  definitions: PlaybookSource,
): Promise<RoundLimits> {
  const { maxReviewRounds, maxFixRounds } = await requestCodingSettings(
    run,
    repository,
    definitions,
  );
  return { maxReviewRounds, maxFixRounds };
}

/**
 * When a repository's runs push their story commits: its story task's
 * `pushTiming` (`end` keeps them on the run's hidden ref until the lane is
 * published), after each story when it sets none.
 */
export async function pushTimingFor(
  repository: Pick<Repository, "storyPlaybookId">,
  definitions: PlaybookSource,
): Promise<PushTiming> {
  return (await codingTask(storyTaskFor(repository), definitions))?.pushTiming ?? "per-story";
}

/**
 * Whether a repository's lanes get a draft PR/MR as soon as a story is pushed
 * (`openEarlyPullRequest`) rather than when the lane is published: the
 * repository's `openPullRequestEarly`. A story playbook that pushes only at
 * the end never opens one early (there's no branch to open it for until then).
 */
export async function opensPullRequestEarly(
  repository: Pick<Repository, "storyPlaybookId" | "openPullRequestEarly">,
  definitions: PlaybookSource,
): Promise<boolean> {
  if (!repository.openPullRequestEarly) return false;
  const task = await codingTask(storyTaskFor(repository), definitions);
  return task?.pushTiming !== "end";
}

/**
 * The routing and payload of a story or request job, spread into
 * `createAndPublish`'s input: a coding run of `taskId` whose trigger context
 * is `payload` (null when that task isn't a coding task that accepts `trigger`).
 */
export async function codingJobInput(
  coding: { taskId: string; trigger: TriggerKind },
  payload: RalphStoryPayload | RalphRequestPayload,
  definitions: PlaybookSource,
): Promise<ReturnType<typeof runSpecJobInput> | null> {
  const task = await codingTask(coding.taskId, definitions);
  if (!task || !task.triggers.includes(coding.trigger)) return null;
  return taskJobInput(definitions, task, {
    trigger: { kind: coding.trigger, context: payload },
    repositoryId: payload.repositoryId,
  });
}

/**
 * The routing and payload of a lane's push run (`ralph.push`), a coding run
 * of the repository's story task with no session (trigger `tracker.delegated`,
 * `payload` as its context); null when the story task isn't a coding task
 * taking that trigger.
 */
export async function pushJobInput(
  repository: Pick<Repository, "storyPlaybookId">,
  payload: RalphPushPayload,
  definitions: PlaybookSource,
): Promise<ReturnType<typeof runSpecJobInput> | null> {
  const task = await codingTask(storyTaskFor(repository), definitions);
  if (!task || !task.triggers.includes("tracker.delegated")) return null;
  return taskJobInput(definitions, task, {
    trigger: { kind: "tracker.delegated", context: payload },
    repositoryId: payload.repositoryId,
  });
}

/** What a completed push run pushed; null for an invalid result. */
export function pushResult(job: Pick<Job, "result">): RalphPushResult | null {
  const parsed = RalphPushResult.safeParse(job.result);
  return parsed.success ? parsed.data : null;
}

/** A ralph job's own payload: its coding run's trigger context. */
export function ralphJobPayload(job: Pick<Job, "payload">): unknown {
  const parsed = RunSpecJobPayload.safeParse(job.payload);
  return parsed.success ? parsed.data.trigger.context : null;
}

/**
 * The query task that writes a repository's PR/MR descriptions: its story
 * task's `prDescriptionTaskId` (the default's when the story task isn't a
 * coding task).
 */
export async function prDescriptionTaskFor(
  repository: Pick<Repository, "storyPlaybookId">,
  definitions: PlaybookSource,
): Promise<string> {
  return (
    (await codingTask(storyTaskFor(repository), definitions))?.prDescriptionTaskId ??
    CODING_DEFAULTS.prDescriptionTaskId
  );
}

/** The `run.invoked` trigger context of a lane's PR/MR description query run. */
export function describePrTriggerContext(
  payload: RalphDescribePrPayload,
): RalphDescribePrTriggerContext {
  return RalphDescribePrTriggerContext.parse({
    ...describePrTemplateContext({
      epic: {
        kind: "children",
        issueId: "",
        identifier: payload.epic.identifier,
        title: payload.epic.title,
        description: payload.epic.prd,
        branchName: payload.branch,
        qualityGates: payload.qualityGates,
        stories: [],
      },
      branch: payload.branch,
      baseBranch: payload.baseBranch,
      prTerm: payload.repository.provider === "gitlab" ? "merge request" : "pull request",
      progress: payload.progress,
      stories: payload.stories,
    }),
    invoker: { kind: "ralph-run", id: payload.runId },
    payload,
  });
}

/**
 * A lane's describe job's routing and payload, spread into
 * `createAndPublish`'s input: a query run of the story task's
 * `prDescriptionTaskId` (trigger `run.invoked`, `payload` in its trigger
 * context) in a disposable checkout of the lane's branch. A string says why
 * there is none: that task isn't a query task taking `run.invoked`.
 */
export async function describePrJobInput(
  repository: Pick<Repository, "storyPlaybookId">,
  payload: RalphDescribePrPayload,
  definitions: PlaybookSource,
): Promise<ReturnType<typeof runSpecJobInput> | string> {
  const taskId = await prDescriptionTaskFor(repository, definitions);
  const task = await getPlaybookTask(definitions, taskId);
  if (task?.taskType !== "query" || !task.triggers.includes("run.invoked")) {
    return `${taskId} isn't a query task started by run.invoked`;
  }
  return taskJobInput(definitions, task, {
    trigger: { kind: "run.invoked", context: describePrTriggerContext(payload) },
    repositoryId: payload.repositoryId,
    ref: payload.branch,
    requireCheckout: true,
  });
}

/** A describe job's `ralph.describe-pr` payload, in its query run's trigger context; null when it has none. */
export function describePrPayload(job: Pick<Job, "payload">): RalphDescribePrPayload | null {
  const spec = RunSpecJobPayload.safeParse(job.payload);
  const context = spec.success
    ? RalphDescribePrTriggerContext.safeParse(spec.data.trigger.context)
    : null;
  return context?.success ? context.data.payload : null;
}

/**
 * The PR/MR title and body a completed describe job wrote: its answered
 * query run's `{title, body}` output, the title fitted (`fitTitle`). Null for
 * an invalid result.
 */
export function describePrText(job: Pick<Job, "result">): { title: string; body: string } | null {
  const parsed = QueryRunResult.safeParse(job.result);
  if (!parsed.success || parsed.data.outcome !== "answered") return null;
  const text = readPullRequestDescription(parsed.data.structured);
  return text ? fitPullRequestDescription(text) : null;
}

/**
 * The query task that verifies the attempts of a story job (`job.taskId`, the story
 * playbook it ran): that task's `verifierTaskId`. Null when the job didn't run a story
 * playbook (only story runs verify their tasks).
 */
export async function verifierTaskFor(
  job: Pick<Job, "taskId">,
  definitions: PlaybookSource,
): Promise<string | null> {
  const task = job.taskId ? await codingTask(job.taskId, definitions) : null;
  return task?.verifierTaskId ?? null;
}

/** The `run.invoked` trigger context of a task verifier's query run. */
export function verifyTaskTriggerContext(
  payload: RalphVerifyTaskPayload,
): RalphVerifyTaskTriggerContext {
  return RalphVerifyTaskTriggerContext.parse({
    ...verifyTaskTemplateContext({
      branch: payload.branch,
      baseBranch: payload.baseBranch,
      epic: {
        identifier: payload.epic.identifier,
        title: payload.epic.title,
        description: payload.epic.prd,
      },
      story: payload.story,
      commitSha: payload.commitSha,
      qualityGates: payload.qualityGates,
    }),
    invoker: { kind: "ralph-run", id: payload.runId },
    payload,
  });
}

/**
 * A task verifier job's routing and payload, spread into `createAndPublish`'s input: a
 * query run of `taskId` (trigger `run.invoked`, `payload` in its trigger context) in a
 * disposable checkout of the attempt's commit (the lane's branch when it committed
 * nothing). A string says why there is none: that task isn't a query task taking
 * `run.invoked`.
 */
export async function verifyTaskJobInput(
  taskId: string,
  payload: RalphVerifyTaskPayload,
  definitions: PlaybookSource,
): Promise<ReturnType<typeof runSpecJobInput> | string> {
  const task = await getPlaybookTask(definitions, taskId);
  if (task?.taskType !== "query" || !task.triggers.includes("run.invoked")) {
    return `${taskId} isn't a query task started by run.invoked`;
  }
  return taskJobInput(definitions, task, {
    trigger: { kind: "run.invoked", context: verifyTaskTriggerContext(payload) },
    repositoryId: payload.repositoryId,
    ref: payload.commitSha ?? payload.branch,
    requireCheckout: true,
  });
}

/** What a finished task verifier job said about its attempt (`taskVerdictOf`). */
export type TaskVerdictOutcome =
  | { kind: "verdict"; verdict: RalphTaskVerdict }
  /** The verifier couldn't check the attempt: why. */
  | { kind: "failed"; error: string };

/**
 * The verdict of a completed task verifier job: its answered query run's
 * `{ criteria, summary }`. A run that answered nothing usable, or found nothing to
 * check out, failed rather than rejected.
 */
export function taskVerdictOf(job: Pick<Job, "result">): TaskVerdictOutcome {
  const parsed = QueryRunResult.safeParse(job.result);
  if (!parsed.success) return { kind: "failed", error: "the verifier sent an invalid result" };
  if (parsed.data.outcome !== "answered") {
    return {
      kind: "failed",
      error:
        parsed.data.outcome === "no_checkout"
          ? "the verifier couldn't check out the change"
          : "the verifier ran out of its token budget",
    };
  }
  const verdict = RalphTaskVerdict.safeParse(parsed.data.structured);
  if (!verdict.success) {
    return { kind: "failed", error: "the verifier's answer isn't a verdict per criterion" };
  }
  return { kind: "verdict", verdict: verdict.data };
}

/** The audit a repository's story playbook runs on a finished epic, and its round cap. */
export interface EpicAuditSettings {
  taskId: string;
  maxRounds: number;
}

/**
 * The query task that audits an epic worked in `repository` (its story task's
 * `auditTaskId`) and the rounds it gets (`maxAuditRounds`). Null when the story task
 * isn't a story playbook (only story runs audit their epics).
 */
export async function epicAuditFor(
  repository: Pick<Repository, "storyPlaybookId">,
  definitions: PlaybookSource,
): Promise<EpicAuditSettings | null> {
  const task = await codingTask(storyTaskFor(repository), definitions);
  if (!task?.auditTaskId) return null;
  return { taskId: task.auditTaskId, maxRounds: task.maxAuditRounds ?? DEFAULT_MAX_AUDIT_ROUNDS };
}

/** The `run.invoked` trigger context of an epic audit's query run. */
export function auditEpicTriggerContext(
  payload: RalphAuditEpicPayload,
): RalphAuditEpicTriggerContext {
  return RalphAuditEpicTriggerContext.parse({
    ...auditEpicTemplateContext({
      branch: payload.branch,
      baseBranch: payload.baseBranch,
      epic: {
        identifier: payload.epic.identifier,
        title: payload.epic.title,
        description: payload.epic.prd,
      },
      requirements: payload.requirements,
      tasks: payload.tasks,
      commitSha: payload.commitSha,
      round: payload.round,
      maxRounds: payload.maxRounds,
      prTerm: payload.repository.provider === "gitlab" ? "merge request" : "pull request",
    }),
    invoker: { kind: "ralph-run", id: payload.runId },
    payload,
  });
}

/**
 * An epic audit job's routing and payload, spread into `createAndPublish`'s input: a
 * query run of `taskId` (trigger `run.invoked`, `payload` in its trigger context) in a
 * disposable checkout of the lane's head (its branch when `commitSha` is null). A string
 * says why there is none: that task isn't a query task taking `run.invoked`.
 */
export async function auditEpicJobInput(
  taskId: string,
  payload: RalphAuditEpicPayload,
  definitions: PlaybookSource,
): Promise<ReturnType<typeof runSpecJobInput> | string> {
  const task = await getPlaybookTask(definitions, taskId);
  if (task?.taskType !== "query" || !task.triggers.includes("run.invoked")) {
    return `${taskId} isn't a query task started by run.invoked`;
  }
  return taskJobInput(definitions, task, {
    trigger: { kind: "run.invoked", context: auditEpicTriggerContext(payload) },
    repositoryId: payload.repositoryId,
    ref: payload.commitSha ?? payload.branch,
    requireCheckout: true,
  });
}

/** What a finished epic audit job said (`epicAuditOf`). */
export type EpicAuditOutcome =
  | { kind: "result"; result: RalphEpicAuditResult }
  /** The audit couldn't check the epic: why. */
  | { kind: "failed"; error: string };

/**
 * The findings of a completed epic audit job: its answered query run's
 * `{ requirements, summary }`. A run that answered nothing usable, or found nothing to
 * check out, failed rather than found gaps.
 */
export function epicAuditOf(job: Pick<Job, "result">): EpicAuditOutcome {
  const parsed = QueryRunResult.safeParse(job.result);
  if (!parsed.success) return { kind: "failed", error: "the audit sent an invalid result" };
  if (parsed.data.outcome !== "answered") {
    return {
      kind: "failed",
      error:
        parsed.data.outcome === "no_checkout"
          ? "the audit couldn't check out the branch"
          : "the audit ran out of its token budget",
    };
  }
  const result = RalphEpicAuditResult.safeParse(parsed.data.structured);
  if (!result.success) {
    return { kind: "failed", error: "the audit's answer isn't a finding per requirement" };
  }
  return { kind: "result", result: result.data };
}
