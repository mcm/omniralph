/**
 * Save-time checks of coding tasks beyond their schema: settings that don't
 * combine, the PR description task they name, and templates that count on an
 * epic where a request may have none.
 */
import type { TaskDefinition } from "./definitions.js";
import { REQUEST_TRIGGERS } from "./kinds.js";
import { outputSchemaProblem, type JsonSchema } from "./output-schema.js";
import { parseTemplate, type TemplateNode } from "./template.js";

/** Variables a request run may not have (it need not have an epic or a story). */
function needsEpic(name: string): boolean {
  return name === "epic.prd" || name === "story" || name.startsWith("story.");
}

/** Variables a template uses outside every section, which it renders unconditionally. */
function unconditionalVariables(template: string): string[] {
  const parsed = parseTemplate(template);
  if (!parsed.ok) return [];
  return parsed.nodes.flatMap((node: TemplateNode) =>
    node.type === "variable" ? [node.name] : [],
  );
}

/** The output a coding run reads from its PR description task: a title and a markdown body. */
export const PR_DESCRIPTION_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: { title: { type: "string" }, body: { type: "string" } },
  required: ["title", "body"],
};

/** A task a coding run may invoke for its PR description, as `prDescriptionProblem` sees it. */
export type PrDescriptionTaskFields = Pick<
  TaskDefinition,
  "id" | "taskType" | "triggers" | "outputSchema"
>;

/**
 * Why a coding run can't invoke `task` for its PR description, or null when it
 * can: it must be a query task accepting `run.invoked` whose output schema
 * guarantees `{ title, body }` (`PR_DESCRIPTION_OUTPUT_SCHEMA`).
 */
export function prDescriptionProblem(task: PrDescriptionTaskFields): string | null {
  if (task.taskType !== "query" || !task.triggers.includes("run.invoked")) {
    return `${task.id} isn't a query task started by run.invoked.`;
  }
  if (task.outputSchema === undefined) {
    return `${task.id} has no output schema: a PR description task outputs { title, body }.`;
  }
  const problem = outputSchemaProblem(task.outputSchema, PR_DESCRIPTION_OUTPUT_SCHEMA);
  return problem && `${task.id} doesn't output the { title, body } of a PR description: ${problem}`;
}

/**
 * The output a story run reads from its task verifier: a verdict per acceptance
 * criterion (`criterion`, `accepted`, `reason`) and a summary.
 */
export const TASK_VERIFIER_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterion: { type: "string" },
          accepted: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["criterion", "accepted", "reason"],
      },
    },
    summary: { type: "string" },
  },
  required: ["criteria", "summary"],
};

/**
 * Why a story run can't invoke `task` as its task verifier, or null when it can: it
 * must be a query task accepting `run.invoked` whose output schema guarantees the
 * verdicts of `TASK_VERIFIER_OUTPUT_SCHEMA`.
 */
export function taskVerifierProblem(task: PrDescriptionTaskFields): string | null {
  if (task.taskType !== "query" || !task.triggers.includes("run.invoked")) {
    return `${task.id} isn't a query task started by run.invoked.`;
  }
  if (task.outputSchema === undefined) {
    return `${task.id} has no output schema: a task verifier outputs { criteria, summary }.`;
  }
  const problem = outputSchemaProblem(task.outputSchema, TASK_VERIFIER_OUTPUT_SCHEMA);
  return (
    problem && `${task.id} doesn't output the { criteria, summary } of a task verifier: ${problem}`
  );
}

type CodingTaskFields = Pick<
  TaskDefinition,
  | "taskType"
  | "triggers"
  | "promptTemplate"
  | "pushTiming"
  | "draftPullRequest"
  | "prDescriptionTaskId"
  | "verifierTaskId"
>;

/**
 * Problems with a coding task, by field (empty when there are none, or the
 * task isn't a coding task): pushing only at the end with an early draft PR
 * (the draft would have nothing to show), a `prDescriptionTaskId` a coding
 * run can't invoke (`prDescriptionProblem`), a `verifierTaskId` it can't invoke as its
 * task verifier (`taskVerifierProblem`) (`getTask` finds tasks by ID), and on a
 * task that accepts a request trigger, a template that renders `epic.prd` or
 * `story` (or any `story.*` path) outside an optional section.
 */
export function validateCodingTask(
  task: CodingTaskFields,
  getTask: (id: string) => PrDescriptionTaskFields | null,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (task.taskType !== "coding") return errors;
  if (task.pushTiming === "end" && task.draftPullRequest === "early") {
    errors.draftPullRequest =
      "An early draft PR needs the stories pushed as they're done: push after each story, or open the draft PR at the end.";
  }
  if (task.prDescriptionTaskId !== undefined) {
    const describer = getTask(task.prDescriptionTaskId);
    const problem = describer
      ? prDescriptionProblem(describer)
      : `There is no task ${task.prDescriptionTaskId}.`;
    if (problem) errors.prDescriptionTaskId = problem;
  }
  if (task.verifierTaskId !== undefined) {
    const verifier = getTask(task.verifierTaskId);
    const problem = verifier
      ? taskVerifierProblem(verifier)
      : `There is no task ${task.verifierTaskId}.`;
    if (problem) errors.verifierTaskId = problem;
  }
  const requests = task.triggers.filter((t) => (REQUEST_TRIGGERS as readonly string[]).includes(t));
  if (requests.length > 0) {
    const used = [...new Set(unconditionalVariables(task.promptTemplate).filter(needsEpic))];
    if (used.length > 0) {
      errors.promptTemplate = `A request (${requests.join(", ")}) may have no epic or story: put ${used.map((n) => `{{${n}}}`).join(", ")} in an optional section (e.g. {{#${used[0]}}}…{{/${used[0]}}}).`;
    }
  }
  return errors;
}
