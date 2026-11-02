/**
 * Which tasks a review run can invoke as the verifier of its passes'
 * findings: the review run applies the verification's output, so its shape is
 * fixed.
 */
import { VERIFY_FINDINGS_PLAYBOOK } from "./builtin/verify-findings.js";
import type { TaskDefinition } from "./definitions.js";
import { outputSchemaProblem, type JsonSchema } from "./output-schema.js";

/**
 * The output a review run reads from its finding verifier (`builtin:verify-findings`'s
 * output schema; `FindingVerificationOutput` in `@omniralph/shared`).
 */
export const FINDING_VERIFICATION_OUTPUT_SCHEMA: JsonSchema =
  VERIFY_FINDINGS_PLAYBOOK.outputSchema!;

/** A task a review run may invoke as its finding verifier, as `findingVerifierProblem` sees it. */
export type FindingVerifierTaskFields = Pick<
  TaskDefinition,
  "id" | "taskType" | "triggers" | "outputSchema"
>;

/**
 * Why a review run can't invoke `task` as its finding verifier, or null when
 * it can: it must be a query task accepting `run.invoked` whose output schema
 * fits the fixed verification output (`FINDING_VERIFICATION_OUTPUT_SCHEMA`).
 */
export function findingVerifierProblem(task: FindingVerifierTaskFields): string | null {
  if (task.taskType !== "query" || !task.triggers.includes("run.invoked")) {
    return `${task.id} isn't a query task started by run.invoked.`;
  }
  if (task.outputSchema === undefined) {
    return `${task.id} has no output schema: a finding verifier outputs { verdicts, unreached, summary }.`;
  }
  const problem = outputSchemaProblem(task.outputSchema, FINDING_VERIFICATION_OUTPUT_SCHEMA);
  return (
    problem &&
    `${task.id} doesn't output the { verdicts, unreached, summary } of a finding verifier: ${problem}`
  );
}
