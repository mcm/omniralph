/**
 * How a ralph run's stories, requests, pushes and PR/MR descriptions run:
 * coding and query runs of the repository's story and request tasks (and the
 * story task's PR description task), the ralph payloads as their trigger
 * context, and the limits the loop reads from those tasks.
 */
import type { Job, RalphMessage, RalphMessageTrigger, RalphRun, Repository } from "@omniralph/db";
import {
  describePrTemplateContext,
  fitPullRequestDescription,
  readPullRequestDescription,
} from "@omniralph/ralph";
import type { RalphDescribePrPayload } from "@omniralph/shared";
import {
  MAX_ATTEMPTS_PER_STORY,
  MAX_ROUNDS_PER_STORY,
  QueryRunResult,
  RalphDescribePrTriggerContext,
  RalphPushResult,
  RunSpecJobPayload,
  STALL_ROUNDS,
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

type CodingRepository = Pick<Repository, "storyTaskId" | "requestTaskId">;

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
  definitions: DefinitionSource,
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
  definitions: DefinitionSource,
): Promise<StoryCaps> {
  const task = job?.taskId ? await codingTask(job.taskId, definitions) : null;
  return task ? taskStoryCaps(task) : DEFAULT_STORY_CAPS;
}

/** How many review and CI fix rounds a lane's PR/MR gets. */
export interface RoundLimits {
  maxReviewRounds: number;
  maxFixRounds: number;
}

/**
 * The repository's `maxReviewRounds`/`maxFixRounds`, capped by those of the
 * run's request task (which runs the rounds).
 */
export async function roundLimits(
  run: Pick<RalphRun, "codingTaskId">,
  repository: CodingRepository & { ralphSettings: unknown },
  definitions: DefinitionSource,
): Promise<RoundLimits> {
  const settings = parseRalphSettings(repository.ralphSettings);
  const limits = { maxReviewRounds: settings.maxReviewRounds, maxFixRounds: settings.maxFixRounds };
  const task = await codingTask(requestTaskFor(run, repository), definitions);
  return {
    maxReviewRounds: Math.min(limits.maxReviewRounds, task?.maxReviewRounds ?? Infinity),
    maxFixRounds: Math.min(limits.maxFixRounds, task?.maxFixRounds ?? Infinity),
  };
}

/**
 * When a repository's runs push their story commits: its story task's
 * `pushTiming` (`end` keeps them on the run's hidden ref until the lane is
 * published), after each story when it sets none.
 */
export async function pushTimingFor(
  repository: Pick<Repository, "storyTaskId">,
  definitions: DefinitionSource,
): Promise<PushTiming> {
  return (await codingTask(storyTaskFor(repository), definitions))?.pushTiming ?? "per-story";
}

/**
 * Whether a repository's lanes get a draft PR/MR as soon as a story is pushed
 * (`openEarlyPullRequest`) rather than when the lane is published: its story
 * task's `draftPullRequest` when set, else the repository's
 * `openPullRequestEarly`. A story task that pushes only at the end never
 * opens one early (there's no branch to open it for until then).
 */
export async function opensPullRequestEarly(
  repository: Pick<Repository, "storyTaskId"> & { ralphSettings: unknown },
  definitions: DefinitionSource,
): Promise<boolean> {
  const early = parseRalphSettings(repository.ralphSettings).openPullRequestEarly;
  const task = await codingTask(storyTaskFor(repository), definitions);
  if (task?.pushTiming === "end") return false;
  return task?.draftPullRequest ? task.draftPullRequest === "early" : early;
}

/**
 * The routing and payload of a story or request job, spread into
 * `createAndPublish`'s input: a coding run of `taskId` whose trigger context
 * is `payload` (null when that task isn't a coding task that accepts `trigger`).
 */
export async function codingJobInput(
  coding: { taskId: string; trigger: TriggerKind },
  payload: RalphStoryPayload | RalphRequestPayload,
  definitions: DefinitionSource,
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

/**
 * A lane's describe job's routing and payload, spread into
 * `createAndPublish`'s input: a query run of the story task's
 * `prDescriptionTaskId` (trigger `run.invoked`, `payload` in its trigger
 * context) in a disposable checkout of the lane's branch. A string says why
 * there is none: that task isn't a query task taking `run.invoked`.
 */
export async function describePrJobInput(
  repository: Pick<Repository, "storyTaskId">,
  payload: RalphDescribePrPayload,
  definitions: DefinitionSource,
): Promise<ReturnType<typeof runSpecJobInput> | string> {
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
