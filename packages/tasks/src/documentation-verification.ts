/**
 * Which tasks a documentation check can invoke as the verifier of its
 * iterations' updates: the review run applies the verification's output, so
 * its shape is fixed.
 */
import { VERIFY_DOCS_PLAYBOOK } from "./builtin/verify-docs.js";
import type { FindingVerifierTaskFields } from "./finding-verification.js";
import { outputSchemaProblem, type JsonSchema } from "./output-schema.js";

/**
 * The output a documentation check reads from its verifier (`builtin:verify-docs`'s
 * output schema; `DocumentationVerificationOutput` in `@omniralph/shared`).
 */
export const DOCUMENTATION_VERIFICATION_OUTPUT_SCHEMA: JsonSchema =
  VERIFY_DOCS_PLAYBOOK.outputSchema!;

/**
 * Why a documentation check can't invoke `task` as its verifier, or null when
 * it can: it must be a query task accepting `run.invoked` whose output schema
 * fits the fixed verification output (`DOCUMENTATION_VERIFICATION_OUTPUT_SCHEMA`).
 */
export function documentationVerifierProblem(task: FindingVerifierTaskFields): string | null {
  if (task.taskType !== "query" || !task.triggers.includes("run.invoked")) {
    return `${task.id} isn't a query task started by run.invoked.`;
  }
  if (task.outputSchema === undefined) {
    return `${task.id} has no output schema: a documentation verifier outputs { verdicts, summary }.`;
  }
  const problem = outputSchemaProblem(task.outputSchema, DOCUMENTATION_VERIFICATION_OUTPUT_SCHEMA);
  return (
    problem &&
    `${task.id} doesn't output the { verdicts, summary } of a documentation verifier: ${problem}`
  );
}
