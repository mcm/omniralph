/**
 * The per-repository switch between the legacy `ralph.story`/`ralph.request`
 * jobs and coding runs (`repositories.coding_path`). Both paths enqueue the
 * same payloads (on the `tasks` path as the run's trigger context), share all
 * run state and have their outcomes applied by the same `advanceRun` code;
 * only the jobs' routing and the limits the loop reads differ.
 */
import type { Job, RalphMessage, RalphMessageTrigger, RalphRun, Repository } from "@omniralph/db";
import {
  MAX_ATTEMPTS_PER_STORY,
  RunSpecJobPayload,
  legacyJobRouting,
  parseRalphSettings,
  type RalphRequestPayload,
  type RalphStoryPayload,
} from "@omniralph/shared";
import type { TaskDefinition, TriggerKind } from "@omniralph/tasks";
import { runSpecJobInput } from "@/lib/runs/job";
import { BUILTIN_DEFINITIONS, type DefinitionSource } from "@/lib/runs/resolve";

/** Story attempts a run makes before it stops and asks (cyralph's `maxIterationsPerRun`). */
export const MAX_ITERATIONS_PER_RUN = 50;

type CodingRepository = Pick<Repository, "codingPath" | "storyTaskId" | "requestTaskId">;

/** Whether the repository's ralph runs enqueue coding runs (the `tasks` path). */
export function usesCodingTasks(repository: Pick<Repository, "codingPath">): boolean {
  return repository.codingPath === "tasks";
}

/** The coding task `id`, or null when it's unknown or of another task type. */
export function codingTask(
  id: string,
  definitions: DefinitionSource = BUILTIN_DEFINITIONS,
): TaskDefinition | null {
  const task = definitions.getTask(id);
  return task?.taskType === "coding" ? task : null;
}

/** The coding task a story attempt runs: the repository's `story_task_id`. */
export function storyTaskFor(repository: Pick<Repository, "storyTaskId">): string {
  return repository.storyTaskId;
}

/**
 * The coding task a lane's requests run: the repository's `request_task_id`.
 * (A chat-origin run's own coding task overrides it here once runs carry one.)
 */
export function requestTaskFor(
  _run: Pick<RalphRun, "id">,
  repository: Pick<Repository, "requestTaskId">,
): string {
  return repository.requestTaskId;
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
  maxIterationsPerRun: number;
}

const LEGACY_STORY_LIMITS: StoryLimits = {
  maxAttemptsPerStory: MAX_ATTEMPTS_PER_STORY,
  maxIterationsPerRun: MAX_ITERATIONS_PER_RUN,
};

/**
 * The story caps of a repository's runs: on the `tasks` path its story
 * task's `maxAttemptsPerStory`/`maxIterationsPerRun`, otherwise (or without
 * a repository) the legacy loop's.
 */
export function storyLimits(
  repository: CodingRepository | null | undefined,
  definitions: DefinitionSource = BUILTIN_DEFINITIONS,
): StoryLimits {
  if (!repository || !usesCodingTasks(repository)) return LEGACY_STORY_LIMITS;
  const task = codingTask(storyTaskFor(repository), definitions);
  return {
    maxAttemptsPerStory: task?.maxAttemptsPerStory ?? MAX_ATTEMPTS_PER_STORY,
    maxIterationsPerRun: task?.maxIterationsPerRun ?? MAX_ITERATIONS_PER_RUN,
  };
}

/** The attempts a story gets, by the job that ran its last attempt (its coding task's, else the legacy cap). */
export function jobMaxAttempts(
  job: Pick<Job, "taskId"> | null,
  definitions: DefinitionSource = BUILTIN_DEFINITIONS,
): number {
  const task = job?.taskId ? codingTask(job.taskId, definitions) : null;
  return task?.maxAttemptsPerStory ?? MAX_ATTEMPTS_PER_STORY;
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
export function roundLimits(
  run: Pick<RalphRun, "id">,
  repository: CodingRepository & { ralphSettings: unknown },
  definitions: DefinitionSource = BUILTIN_DEFINITIONS,
): RoundLimits {
  const settings = parseRalphSettings(repository.ralphSettings);
  const limits = { maxReviewRounds: settings.maxReviewRounds, maxFixRounds: settings.maxFixRounds };
  if (!usesCodingTasks(repository)) return limits;
  const task = codingTask(requestTaskFor(run, repository), definitions);
  return {
    maxReviewRounds: Math.min(limits.maxReviewRounds, task?.maxReviewRounds ?? Infinity),
    maxFixRounds: Math.min(limits.maxFixRounds, task?.maxFixRounds ?? Infinity),
  };
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
export function ralphJobInput(
  type: string,
  repository: Pick<Repository, "codingPath">,
  coding: { taskId: string; trigger: TriggerKind },
  payload: RalphStoryPayload | RalphRequestPayload,
  definitions: DefinitionSource = BUILTIN_DEFINITIONS,
): RalphJobInput | null {
  if (!usesCodingTasks(repository)) return { ...legacyJobRouting(type), payload };
  const task = codingTask(coding.taskId, definitions);
  if (!task || !task.triggers.includes(coding.trigger)) return null;
  return runSpecJobInput(task, {
    trigger: { kind: coding.trigger, context: payload },
    repositoryId: payload.repositoryId,
  });
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
