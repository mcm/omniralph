/**
 * Which tasks a repository can pick as its review runs' correlation task: the
 * review run applies the correlation's output, so its shape is fixed.
 */
import { CORRELATE_FINDINGS_TASK } from "./builtin/correlate-findings.js";
import type { TaskDefinition } from "./definitions.js";
import { outputSchemaProblem, type JsonSchema } from "./output-schema.js";

/**
 * The output a review run reads from its correlation task (`builtin:correlate-findings`'s
 * output schema; `CorrelationOutput` in `@omniralph/shared`).
 */
export const CORRELATION_OUTPUT_SCHEMA: JsonSchema = CORRELATE_FINDINGS_TASK.outputSchema!;

/** A task a review run may invoke as its correlation, as `correlationProblem` sees it. */
export type CorrelationTaskFields = Pick<
  TaskDefinition,
  "id" | "taskType" | "triggers" | "outputSchema"
>;

/**
 * Why a review run can't invoke `task` as its correlation, or null when it
 * can: it must be a query task accepting `run.invoked` whose output schema
 * fits the fixed correlation output (`CORRELATION_OUTPUT_SCHEMA`).
 */
export function correlationProblem(task: CorrelationTaskFields): string | null {
  if (task.taskType !== "query" || !task.triggers.includes("run.invoked")) {
    return `${task.id} isn't a query task started by run.invoked.`;
  }
  if (task.outputSchema === undefined) {
    return `${task.id} has no output schema: a correlation task outputs { findings, summary }.`;
  }
  const problem = outputSchemaProblem(task.outputSchema, CORRELATION_OUTPUT_SCHEMA);
  return problem && `${task.id} doesn't output the correlation's { findings, summary }: ${problem}`;
}
