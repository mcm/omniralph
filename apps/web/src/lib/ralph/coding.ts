/**
 * The per-repository switch between the legacy `ralph.story`/`ralph.request`
 * jobs and coding runs (`repositories.coding_path`). Both paths enqueue the
 * same payloads (on the `tasks` path as the run's trigger context), share all
 * run state and have their outcomes applied by the same `advanceRun` code;
 * only the jobs' routing and the limits the loop reads differ.
 */
import type { Job, RalphMessage, RalphMessageTrigger, RalphRun, Repository } from "@omniralph/db";
import {
  describePrTemplateContext,
  fitPullRequestDescription,
  readPullRequestDescription,
} from "@omniralph/ralph";
import {
  MAX_ATTEMPTS_PER_STORY,
  MAX_ROUNDS_PER_STORY,
  QueryRunResult,
  RALPH_DESCRIBE_PR_JOB_TYPE,
  RalphDescribePrPayload,
  RalphDescribePrResult,
  RalphDescribePrTriggerContext,
  RalphPushResult,
  RunSpecJobPayload,
  STALL_ROUNDS,
  legacyJobRouting,
  parseRalphSettings,
  type RalphPushPayload,
  type RalphRequestPayload,
  type RalphStoryPayload,
} from "@omniralph/shared";
import {
  CODING_DEFAULTS,
  type PushTiming,
  type TaskDefinition,
  type TriggerKind,
} from "@omniralph/tasks";
import type { runSpecJobInput } from "@/lib/runs/job";
import { taskJobInput, type DefinitionSource } from "@/lib/definitions";

/** Story attempts a run makes before it stops and asks (cyralph's `maxIterationsPerRun`). */
export const MAX_ITERATIONS_PER_RUN = 50;

type CodingRepository = Pick<Repository, "codingPath" | "storyTaskId" | "requestTaskId">;

/** Whether the repository's ralph runs enqueue coding runs (the `tasks` path). */
export function usesCodingTasks(repository: Pick<Repository, "codingPath">): boolean {
  return repository.codingPath === "tasks";
}

/** The coding task `id`, or null when it's unknown or of another task type. */
export async function codingTask(
  id: string,
  definitions: DefinitionSource,
): Promise<TaskDefinition | null> {
  const task = await definitions.getTask(id);
  return task?.taskType === "coding" ? task : null;
}

/** The coding task a story attempt runs: the repository's `story_task_id`. */
export function storyTaskFor(repository: Pick<Repository, "storyTaskId">): string {
  return repository.storyTaskId;
}

/**
 * The coding task a lane's requests run: the run's own `coding_task_id` (a
 * chat run's "start work" task) when set, else the repository's
 * `request_task_id`.
 */
export function requestTaskFor(
  run: Pick<RalphRun, "codingTaskId">,
  repository: Pick<Repository, "requestTaskId">,
): string {
  return run.codingTaskId ?? repository.requestTaskId;
}

/**
 * A request run's trigger kind: that of its oldest request (requests from
 * before the column existed count as Linear mentions).
 */
export function requestTrigger(
  requests: readonly Partial<Pick<RalphMessage, "trigger">>[],
): RalphMessageTrigger {
  return requests[0]?.trigger ?? "linear.mention";
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

const LEGACY_STORY_CAPS: StoryCaps = {
  maxAttemptsPerStory: MAX_ATTEMPTS_PER_STORY,
  maxRoundsPerStory: MAX_ROUNDS_PER_STORY,
  stallRounds: STALL_ROUNDS,
};

const LEGACY_STORY_LIMITS: StoryLimits = {
  ...LEGACY_STORY_CAPS,
  maxIterationsPerRun: MAX_ITERATIONS_PER_RUN,
};

/** A coding task's story caps, the legacy loop's where it has none. */
function taskStoryCaps(task: TaskDefinition | null | undefined): StoryCaps {
  return {
    maxAttemptsPerStory: task?.maxAttemptsPerStory ?? MAX_ATTEMPTS_PER_STORY,
    maxRoundsPerStory: task?.maxRoundsPerStory ?? MAX_ROUNDS_PER_STORY,
    stallRounds: task?.stallRounds ?? STALL_ROUNDS,
  };
}

/**
 * The story caps of a repository's runs: on the `tasks` path its story
 * task's `maxAttemptsPerStory`/`maxRoundsPerStory`/`stallRounds`/
 * `maxIterationsPerRun`, otherwise (or without a repository) the legacy loop's.
 */
export async function storyLimits(
  repository: CodingRepository | null | undefined,
  definitions: DefinitionSource,
): Promise<StoryLimits> {
  if (!repository || !usesCodingTasks(repository)) return LEGACY_STORY_LIMITS;
  const task = await codingTask(storyTaskFor(repository), definitions);
  return {
    ...taskStoryCaps(task),
    maxIterationsPerRun: task?.maxIterationsPerRun ?? MAX_ITERATIONS_PER_RUN,
  };
}

/** The attempts and rounds a story gets, by the job that ran its last attempt (its coding task's, else the legacy caps). */
export async function jobStoryCaps(
  job: Pick<Job, "taskId"> | null,
  definitions: DefinitionSource,
): Promise<StoryCaps> {
  const task = job?.taskId ? await codingTask(job.taskId, definitions) : null;
  return task ? taskStoryCaps(task) : LEGACY_STORY_CAPS;
}

/** How many review and CI fix rounds a lane's PR/MR gets. */
export interface RoundLimits {
  maxReviewRounds: number;
  maxFixRounds: number;
}

/**
 * The repository's `maxReviewRounds`/`maxFixRounds`, on the `tasks` path
 * capped by those of the run's request task (which runs the rounds).
 */
export async function roundLimits(
  run: Pick<RalphRun, "codingTaskId">,
  repository: CodingRepository & { ralphSettings: unknown },
  definitions: DefinitionSource,
): Promise<RoundLimits> {
  const settings = parseRalphSettings(repository.ralphSettings);
  const limits = { maxReviewRounds: settings.maxReviewRounds, maxFixRounds: settings.maxFixRounds };
  if (!usesCodingTasks(repository)) return limits;
  const task = await codingTask(requestTaskFor(run, repository), definitions);
  return {
    maxReviewRounds: Math.min(limits.maxReviewRounds, task?.maxReviewRounds ?? Infinity),
    maxFixRounds: Math.min(limits.maxFixRounds, task?.maxFixRounds ?? Infinity),
  };
}

/**
 * When a repository's runs push their story commits: on the `tasks` path its
 * story task's `pushTiming` (`end` keeps them on the run's hidden ref until
 * the lane is published), otherwise after each story.
 */
export async function pushTimingFor(
  repository: Pick<Repository, "codingPath" | "storyTaskId">,
  definitions: DefinitionSource,
): Promise<PushTiming> {
  if (!usesCodingTasks(repository)) return "per-story";
  return (await codingTask(storyTaskFor(repository), definitions))?.pushTiming ?? "per-story";
}

/**
 * Whether a repository's lanes get a draft PR/MR as soon as a story is pushed
 * (`openEarlyPullRequest`) rather than when the lane is published: on the
 * `tasks` path its story task's `draftPullRequest` when set; unset, or on the
 * legacy path, the repository's `openPullRequestEarly`. A story task that
 * pushes only at the end never opens one early (there's no branch to open it
 * for until then).
 */
export async function opensPullRequestEarly(
  repository: Pick<Repository, "codingPath" | "storyTaskId"> & { ralphSettings: unknown },
  definitions: DefinitionSource,
): Promise<boolean> {
  const early = parseRalphSettings(repository.ralphSettings).openPullRequestEarly;
  if (!usesCodingTasks(repository)) return early;
  const task = await codingTask(storyTaskFor(repository), definitions);
  if (task?.pushTiming === "end") return false;
  return task?.draftPullRequest ? task.draftPullRequest === "early" : early;
}

/** The routing and payload of a story or request job, spread into `createAndPublish`'s input. */
export type RalphJobInput =
  | ReturnType<typeof runSpecJobInput>
  | (ReturnType<typeof legacyJobRouting> & { payload: RalphStoryPayload | RalphRequestPayload });

/**
 * A ralph job's routing and payload on the repository's path: a legacy job
 * (`payload` as is), or a coding run of `taskId` whose trigger context is
 * `payload` (null when that task isn't a coding task that accepts `trigger`).
 */
export async function ralphJobInput(
  type: string,
  repository: Pick<Repository, "codingPath">,
  coding: { taskId: string; trigger: TriggerKind },
  payload: RalphStoryPayload | RalphRequestPayload,
  definitions: DefinitionSource,
): Promise<RalphJobInput | null> {
  if (!usesCodingTasks(repository)) return { ...legacyJobRouting(type), payload };
  const task = await codingTask(coding.taskId, definitions);
  if (!task || !task.triggers.includes(coding.trigger)) return null;
  return taskJobInput(definitions, task, {
    trigger: { kind: coding.trigger, context: payload },
    repositoryId: payload.repositoryId,
  });
}

/**
 * The routing and payload of a lane's push run (`ralph.push`), a coding run
 * of the repository's story task with no session (trigger `linear.delegated`,
 * `payload` as its context); null when the story task isn't a coding task
 * taking that trigger.
 */
export async function pushJobInput(
  repository: Pick<Repository, "storyTaskId">,
  payload: RalphPushPayload,
  definitions: DefinitionSource,
): Promise<ReturnType<typeof runSpecJobInput> | null> {
  const task = await codingTask(storyTaskFor(repository), definitions);
  if (!task || !task.triggers.includes("linear.delegated")) return null;
  return taskJobInput(definitions, task, {
    trigger: { kind: "linear.delegated", context: payload },
    repositoryId: payload.repositoryId,
  });
}

/** What a completed push run pushed; null for an invalid result. */
export function pushResult(job: Pick<Job, "result">): RalphPushResult | null {
  const parsed = RalphPushResult.safeParse(job.result);
  return parsed.success ? parsed.data : null;
}

/**
 * A ralph job's own payload: a legacy job's `payload`, a coding run's trigger
 * context (the same payload).
 */
export function ralphJobPayload(job: Pick<Job, "taskId" | "payload">): unknown {
  if (job.taskId === null) return job.payload;
  const parsed = RunSpecJobPayload.safeParse(job.payload);
  return parsed.success ? parsed.data.trigger.context : null;
}

/**
 * The query task that writes a repository's PR/MR descriptions on the
 * `tasks` path: its story task's `prDescriptionTaskId` (the default's when
 * the story task isn't a coding task).
 */
export async function prDescriptionTaskFor(
  repository: Pick<Repository, "storyTaskId">,
  definitions: DefinitionSource,
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

/** The routing and payload of a lane's describe job, spread into `createAndPublish`'s input. */
export type DescribePrJobInput =
  | ReturnType<typeof runSpecJobInput>
  | (ReturnType<typeof legacyJobRouting> & { payload: RalphDescribePrPayload });

/**
 * A lane's describe job's routing and payload on the repository's path: a
 * legacy `ralph.describe-pr` job (`payload` as is), or a query run of the
 * story task's `prDescriptionTaskId` (trigger `run.invoked`, `payload` in its
 * trigger context) in a disposable checkout of the lane's branch. A string
 * says why there is none: that task isn't a query task taking `run.invoked`.
 */
export async function describePrJobInput(
  repository: Pick<Repository, "codingPath" | "storyTaskId">,
  payload: RalphDescribePrPayload,
  definitions: DefinitionSource,
): Promise<DescribePrJobInput | string> {
  if (!usesCodingTasks(repository)) {
    return { ...legacyJobRouting(RALPH_DESCRIBE_PR_JOB_TYPE), payload };
  }
  const taskId = await prDescriptionTaskFor(repository, definitions);
  const task = await definitions.getTask(taskId);
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

/** A describe job's `ralph.describe-pr` payload (a query run's is in its trigger context); null when it has none. */
export function describePrPayload(
  job: Pick<Job, "taskId" | "payload">,
): RalphDescribePrPayload | null {
  if (job.taskId === null) {
    const parsed = RalphDescribePrPayload.safeParse(job.payload);
    return parsed.success ? parsed.data : null;
  }
  const spec = RunSpecJobPayload.safeParse(job.payload);
  const context = spec.success
    ? RalphDescribePrTriggerContext.safeParse(spec.data.trigger.context)
    : null;
  return context?.success ? context.data.payload : null;
}

/**
 * The PR/MR title and body a completed describe job wrote: a
 * `ralph.describe-pr` job's `RalphDescribePrResult`, or an answered query
 * run's `{title, body}` output, its title fitted (`fitTitle`) as the harness
 * fits a legacy job's. Null for an invalid result.
 */
export function describePrText(
  job: Pick<Job, "taskId" | "result">,
): { title: string; body: string } | null {
  if (job.taskId === null) {
    const parsed = RalphDescribePrResult.safeParse(job.result);
    return parsed.success ? { title: parsed.data.title, body: parsed.data.body } : null;
  }
  const parsed = QueryRunResult.safeParse(job.result);
  if (!parsed.success || parsed.data.outcome !== "answered") return null;
  const text = readPullRequestDescription(parsed.data.structured);
  return text ? fitPullRequestDescription(text) : null;
}
