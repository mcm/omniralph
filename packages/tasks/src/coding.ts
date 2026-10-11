/**
 * Save-time checks of coding tasks beyond their schema: settings that don't
 * combine, the PR description task they name, and templates that count on an
 * epic where a request may have none.
 */
import type { TaskDefinition } from "./definitions.js";
import { REQUEST_TRIGGERS } from "./kinds.js";
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

type CodingTaskFields = Pick<
  TaskDefinition,
  | "taskType"
  | "triggers"
  | "promptTemplate"
  | "pushTiming"
  | "draftPullRequest"
  | "prDescriptionTaskId"
>;

/**
 * Problems with a coding task, by field (empty when there are none, or the
 * task isn't a coding task): pushing only at the end with an early draft PR
 * (the draft would have nothing to show), a `prDescriptionTaskId` that isn't
 * a query task accepting `run.invoked` (`getTask` finds tasks by ID), and on a
 * task that accepts a request trigger, a template that renders `epic.prd` or
 * `story` (or any `story.*` path) outside an optional section.
 */
export function validateCodingTask(
  task: CodingTaskFields,
  getTask: (id: string) => Pick<TaskDefinition, "taskType" | "triggers"> | null,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (task.taskType !== "coding") return errors;
  if (task.pushTiming === "end" && task.draftPullRequest === "early") {
    errors.draftPullRequest =
      "An early draft PR needs the stories pushed as they're done: push after each story, or open the draft PR at the end.";
  }
  if (task.prDescriptionTaskId !== undefined) {
    const describer = getTask(task.prDescriptionTaskId);
    if (
      !describer ||
      describer.taskType !== "query" ||
      !describer.triggers.includes("run.invoked")
    ) {
      errors.prDescriptionTaskId = `${task.prDescriptionTaskId} isn't a query task started by run.invoked.`;
    }
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
