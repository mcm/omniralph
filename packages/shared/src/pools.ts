/**
 * Concurrency pools. A job's pool follows from its task type: nobody picks
 * one, and no job can end up in the wrong one.
 */
import type { JobTaskType } from "./protocol.js";

/** The concurrency pools a job's slot comes from: `short` (query, review) and `long` (coding). */
export const POOLS = ["short", "long"] as const;
export type PoolName = (typeof POOLS)[number];

/** The pools every agent claims from, each capped by its local `poolLimits`. */
export const DEFAULT_POOLS: readonly PoolName[] = POOLS;

/**
 * The pool whose slots a job of `taskType` takes: `long` for coding runs
 * (hours-long stories), `short` for query and review runs, and none for
 * `system` jobs (they take a slot, but no pool's).
 */
export function poolForTaskType(taskType: Exclude<JobTaskType, "system">): PoolName;
export function poolForTaskType(taskType: JobTaskType): PoolName | null;
export function poolForTaskType(taskType: JobTaskType): PoolName | null {
  switch (taskType) {
    case "coding":
      return "long";
    case "query":
    case "review":
      return "short";
    case "system":
      return null;
  }
}
