/**
 * Run specs: everything a harness needs to run a task, resolved by the
 * control panel when the job is claimed (the agent and task built from the
 * job's playbook, trigger context, repository, tools, model, budget and
 * tokens), so the harness has no per-task code or lookups.
 */
import {
  HARNESS_VERSION_BY_TASK_TYPE,
  HARNESS_VERSION_FOR_COMMANDS,
  RunSpecAgent,
  TaskDefinition,
  TaskTypeSchema,
  TriggerKindSchema,
} from "@omniralph/tasks";
import { z } from "zod";
import { JobRepository, JobToken } from "./job-basics.js";
import { POOLS } from "./pools.js";

/**
 * The first harness release that runs query tasks through the fixed
 * lifecycle; query runs that need it carry it as their
 * `min_harness_version`, so older harnesses leave them queued.
 */
export const QUERY_TASKS_MIN_HARNESS_VERSION = HARNESS_VERSION_BY_TASK_TYPE.query;

/**
 * The first harness release that runs a task's setup and teardown commands;
 * runs of tasks that declare any carry it as their `min_harness_version`.
 */
export const SETUP_COMMANDS_MIN_HARNESS_VERSION = HARNESS_VERSION_FOR_COMMANDS;

/**
 * The first harness release that runs review tasks (`builtin:review-pr`)
 * through the review lifecycle; review runs carry it as their
 * `min_harness_version`.
 */
export const REVIEW_TASKS_MIN_HARNESS_VERSION = HARNESS_VERSION_BY_TASK_TYPE.review;

/**
 * The first harness release that runs coding tasks (`builtin:implement-story`,
 * `builtin:handle-request` and their push runs) through the coding lifecycle,
 * including a coding task's own setup and teardown commands; coding runs carry
 * it as their `min_harness_version`, so older harnesses (which would fail them
 * as an unsupported task type) leave them queued.
 */
export const CODING_TASKS_MIN_HARNESS_VERSION = HARNESS_VERSION_BY_TASK_TYPE.coding;

/** The event that started a run, with the values its prompt template renders. */
export const RunTrigger = z.object({
  kind: TriggerKindSchema,
  context: z.record(z.string(), z.unknown()),
});
export type RunTrigger = z.infer<typeof RunTrigger>;

/** The stored payload of a run-spec job (a job with a `task_id`). */
export const RunSpecJobPayload = z.object({
  trigger: RunTrigger,
  /** The repository the run works in; defaults to the job's `repository_id`. */
  repositoryId: z.uuid().optional(),
  /** Commit or branch to check out. */
  ref: z.string().min(1).max(255).optional(),
  /** Finish without a session when there's no `ref` to check out. */
  requireCheckout: z.boolean().optional(),
});
export type RunSpecJobPayload = z.infer<typeof RunSpecJobPayload>;

/** A repository's tool settings: rules that only narrow what a session may use (empty for none). */
export const RunToolRestrictions = z.object({
  allowedTools: z.array(z.string().min(1).max(500)).max(100),
  disallowedTools: z.array(z.string().min(1).max(500)).max(100),
});
export type RunToolRestrictions = z.infer<typeof RunToolRestrictions>;

export const RunSpec = z.object({
  jobId: z.uuid(),
  taskType: TaskTypeSchema,
  /** `poolForTaskType(taskType)`. */
  pool: z.enum(POOLS),
  /** The playbook's persona (`playbookRunSpec`), its tools already narrowed by the repository's settings. */
  agent: RunSpecAgent,
  task: TaskDefinition,
  trigger: RunTrigger,
  repository: JobRepository.nullable(),
  /**
   * The ID of `repository` (null with none), keying the harness's installable
   * caches; absent from control panels before it was added.
   */
  repositoryId: z.uuid().nullable().optional(),
  /** Commit or branch to check out; null for none. */
  ref: z.string().min(1).nullable(),
  /** Finish without a session when `ref` is missing. */
  requireCheckout: z.boolean(),
  /** Always empty: a playbook's tools are its runs' tools. Kept for agents that still read it. */
  tools: RunToolRestrictions,
  /**
   * A review run's depth model. Any other run's: the playbook's; null for the
   * Claude Code default.
   */
  model: z.string().min(1).nullable(),
  /** The playbook's fallback model; null for none. */
  fallbackModel: z.string().min(1).nullable(),
  /**
   * Token cap of the run: a review run's depth cap; any other run's playbook's
   * fixed `tokens`. Null means "No limit".
   */
  tokenBudget: z.int().min(1).nullable(),
  /** Most files a review run covers (its review depth's `maxFiles`); null or absent for other runs. */
  maxFiles: z.int().min(1).nullable().optional(),
  tokens: z.object({ lifecycle: JobToken, session: JobToken }),
});
export type RunSpec = z.infer<typeof RunSpec>;

/** The tool a permission rule is about: `Bash` for `Bash(pnpm test:*)`. */
export function ruleTool(rule: string): string {
  const paren = rule.indexOf("(");
  return (paren === -1 ? rule : rule.slice(0, paren)).trim();
}
