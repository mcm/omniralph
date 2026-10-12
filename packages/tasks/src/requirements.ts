import { z } from "zod";
import type { TaskDefinition } from "./definitions.js";
import type { TaskType } from "./kinds.js";
import { templateVariables } from "./template.js";
import { taskVariables, VARIABLES, type VariableDefinition } from "./variables.js";

/**
 * What a run of a task needs from the harness that claims it, derived from
 * the definition when it's saved and stored with it: the installables it
 * uses, the host tools it shells out to and the lowest harness version that
 * provides everything it uses (null for any).
 */
export const TaskRequirements = z.object({
  minHarnessVersion: z.string().min(1).nullable().default(null),
  installables: z.array(z.string().min(1)).default([]),
  hostTools: z.array(z.string().min(1)).default([]),
});
export type TaskRequirements = z.infer<typeof TaskRequirements>;
export type TaskRequirementsInput = z.input<typeof TaskRequirements>;

/**
 * The first harness release that runs each task type through its lifecycle
 * (and provides the type's variables). `@omniralph/shared` exports them as
 * `QUERY_TASKS_MIN_HARNESS_VERSION`, `REVIEW_TASKS_MIN_HARNESS_VERSION` and
 * `CODING_TASKS_MIN_HARNESS_VERSION`.
 */
export const HARNESS_VERSION_BY_TASK_TYPE: Record<TaskType, string> = {
  query: "0.9.0",
  review: "0.10.0",
  coding: "0.11.0",
};

/**
 * The first harness release that runs a task's setup and teardown commands
 * (`SETUP_COMMANDS_MIN_HARNESS_VERSION` in `@omniralph/shared`).
 */
export const HARNESS_VERSION_FOR_COMMANDS = "0.10.0";

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)/;

/** The higher of two `x.y.z` versions (`a` when they're equal or `b` doesn't parse). */
function higherVersion(a: string, b: string): string {
  const pa = VERSION.exec(a);
  const pb = VERSION.exec(b);
  if (!pb) return a;
  if (!pa) return b;
  for (let i = 1; i <= 3; i++) {
    const [x, y] = [Number(pa[i]), Number(pb[i])];
    if (x !== y) return x > y ? a : b;
  }
  return a;
}

type RequirementFields = Pick<
  TaskDefinition,
  "taskType" | "triggers" | "promptTemplate" | "setupCommands" | "teardownCommands"
>;

/**
 * What a run of `task` needs: the harness release that runs its task type,
 * its setup and teardown commands (if any) and every task-type variable its
 * template uses (`minHarnessVersion` in `catalog`), whichever is highest.
 * Definitions don't name installables or host tools yet, so those are empty.
 */
export function deriveTaskRequirements(
  task: RequirementFields,
  catalog: readonly VariableDefinition[] = VARIABLES,
): TaskRequirements {
  const entries = new Map(catalog.map((variable) => [variable.name, variable]));
  const versions = [HARNESS_VERSION_BY_TASK_TYPE[task.taskType]];
  if (task.setupCommands.length > 0 || task.teardownCommands.length > 0) {
    versions.push(HARNESS_VERSION_FOR_COMMANDS);
  }
  for (const name of templateVariables(task.promptTemplate, taskVariables(task, catalog))) {
    const entry = entries.get(name);
    if (entry?.source === "taskType" && entry.minHarnessVersion !== undefined) {
      versions.push(entry.minHarnessVersion);
    }
  }
  return {
    minHarnessVersion: versions.reduce(higherVersion),
    installables: [],
    hostTools: [],
  };
}
