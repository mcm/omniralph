/**
 * Save-time validation of agent and task definitions: the zod schema, then
 * the static checks a definition must pass before it's stored (templates
 * against the variable catalog for every trigger, the agent, triggers, sink
 * and coding settings). Errors are keyed by dotted field path, the format of
 * `fieldErrors` in `@omniralph/shared`, so forms show them inline.
 */
import type { z } from "zod";
import { validateCodingTask, type PrDescriptionTaskFields } from "./coding.js";
import { AgentDefinition, TaskDefinition, validateAgentForTask } from "./definitions.js";
import { TRIGGERS_BY_TASK_TYPE, type SinkKind, type TaskType, type TriggerKind } from "./kinds.js";
import { invalidOutputSchema, outputSchemaProblem, type JsonSchema } from "./output-schema.js";
import { deriveTaskRequirements, type TaskRequirements } from "./requirements.js";
import { validateTemplate } from "./template.js";
import { findVariable, taskVariables } from "./variables.js";

/** Errors by dotted field path (`triggers`, `setupCommands.0.name`), first message per field. */
export type DefinitionFieldErrors = Record<string, string>;

/** Zod issues as field errors (the format of `fieldErrors` in `@omniralph/shared`). */
function zodFieldErrors(error: z.ZodError): DefinitionFieldErrors {
  const errors: DefinitionFieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "form";
    errors[key] ??= issue.message;
  }
  return errors;
}

/**
 * What a sink accepts: runs of one task type, with that type's fixed output
 * for `review` and `coding`. A query sink takes a Markdown `answer` (the task
 * must not declare an output schema), `any` query result, or structured output
 * matching a JSON `schema` (the task's output schema must guarantee its shape).
 */
export interface SinkOutput {
  taskType: TaskType;
  output?: "answer" | "any" | { schema: JsonSchema };
}

/** What `validateTaskDefinition` looks up beyond the definition itself. */
export interface TaskValidationContext {
  /** The agent with an ID (built-in or the organization's), or null. */
  getAgent(id: string): Pick<AgentDefinition, "id" | "taskTypes" | "tools"> | null;
  /** The task with an ID (built-in or the organization's), or null: a coding task's PR description task. */
  getTask(id: string): PrDescriptionTaskFields | null;
  /** What each sink accepts (control-panel code); a kind without an entry isn't available. */
  sinks: Readonly<Partial<Record<SinkKind, SinkOutput>>>;
}

export type AgentValidation =
  { ok: true; definition: AgentDefinition } | { ok: false; fieldErrors: DefinitionFieldErrors };

export type TaskValidation =
  | { ok: true; definition: TaskDefinition; requirements: TaskRequirements }
  | { ok: false; fieldErrors: DefinitionFieldErrors };

/** The parsed agent definition, or its schema errors by field. */
export function validateAgentDefinition(input: unknown): AgentValidation {
  const parsed = AgentDefinition.safeParse(input);
  return parsed.success
    ? { ok: true, definition: parsed.data }
    : { ok: false, fieldErrors: zodFieldErrors(parsed.error) };
}

/**
 * The parsed task definition with the requirements derived from it
 * (`deriveTaskRequirements`), or its errors by field: the schema's, then
 * - `triggers`: a trigger kind its task type doesn't accept;
 * - `promptTemplate`: a template that isn't valid (the Mustache subset), or uses
 *   a variable not available for every trigger; on a coding task, `epic.prd` or
 *   `story` outside an optional section when a request may start it;
 * - `variableLimits.<name>`: a limit on a variable the task can't use;
 * - `outputSchema`: a schema the harness can't check output against (`invalidOutputSchema`);
 * - `agentId`: an unknown agent, or one that doesn't suit the task type;
 * - `sink`: a sink that isn't available or doesn't accept the task's output;
 * - coding settings that don't combine (`validateCodingTask`).
 */
export function validateTaskDefinition(
  input: unknown,
  context: TaskValidationContext,
): TaskValidation {
  const parsed = TaskDefinition.safeParse(input);
  if (!parsed.success) return { ok: false, fieldErrors: zodFieldErrors(parsed.error) };
  const task = parsed.data;
  const errors: DefinitionFieldErrors = {};
  const add = (field: string, message: string) => {
    errors[field] ??= message;
  };

  const accepted = TRIGGERS_BY_TASK_TYPE[task.taskType];
  const unaccepted = task.triggers.filter((trigger) => !accepted.includes(trigger));
  if (unaccepted.length > 0) {
    add(
      "triggers",
      `${task.taskType} tasks can't be started by ${unaccepted.join(", ")}; they accept ${accepted.join(", ")}.`,
    );
  }

  // The coding rules first: their template message says more than "not available".
  for (const [field, message] of Object.entries(
    validateCodingTask(task, (id) => context.getTask(id)),
  )) {
    add(field, message);
  }
  const templateError = templateProblem(task);
  if (templateError) add("promptTemplate", templateError);

  const available = new Set(taskVariables(task));
  for (const name of Object.keys(task.variableLimits ?? {})) {
    if (!available.has(name)) add(`variableLimits.${name}`, `This task can't use ${name}.`);
  }

  const agent = context.getAgent(task.agentId);
  if (!agent) {
    add("agentId", `There is no agent ${task.agentId}.`);
  } else {
    const problems = validateAgentForTask(agent, task);
    if (problems.length > 0) add("agentId", problems.join(" "));
  }

  const schemaError = task.outputSchema && invalidOutputSchema(task.outputSchema);
  if (schemaError) add("outputSchema", schemaError);

  const sinkError = sinkProblem(task, context.sinks[task.sink]);
  if (sinkError) add("sink", sinkError);

  return Object.keys(errors).length > 0
    ? { ok: false, fieldErrors: errors }
    : { ok: true, definition: task, requirements: deriveTaskRequirements(task) };
}

/**
 * Why a task's template is invalid: its parse error, or the variables it uses
 * that some trigger doesn't provide (each with those triggers); null when valid.
 */
function templateProblem(task: TaskDefinition): string | null {
  const triggersMissing = new Map<string, TriggerKind[]>();
  for (const trigger of task.triggers) {
    const problems = validateTemplate(
      task.promptTemplate,
      taskVariables({ ...task, triggers: [trigger] }),
    );
    for (const problem of problems) {
      if (problem.kind === "parse") {
        return `Line ${problem.line}, column ${problem.column}: ${problem.message}.`;
      }
      const missing = triggersMissing.get(problem.name) ?? [];
      if (!missing.includes(trigger)) missing.push(trigger);
      triggersMissing.set(problem.name, missing);
    }
  }
  if (triggersMissing.size === 0) return null;
  const setupNames = new Set(task.setupCommands.map((command) => `setup.${command.name}`));
  return [...triggersMissing]
    .map(([name, triggers]) => {
      const known = findVariable(name) !== undefined || setupNames.has(name);
      if (!known && triggers.length === task.triggers.length) {
        return `{{${name}}} isn't a variable ${task.taskType} tasks can use.`;
      }
      return `{{${name}}} isn't available for ${triggers.join(", ")}.`;
    })
    .join(" ");
}

/** Why `sink` can't take the output of `task`'s runs, or null when it can. */
function sinkProblem(task: TaskDefinition, sink: SinkOutput | undefined): string | null {
  if (!sink) return `The ${task.sink} sink isn't available.`;
  if (sink.taskType !== task.taskType) {
    return `The ${task.sink} sink applies the output of ${sink.taskType} tasks, not ${task.taskType} tasks.`;
  }
  if (task.taskType !== "query" || sink.output === undefined || sink.output === "any") return null;
  if (sink.output === "answer") {
    return task.outputSchema === undefined
      ? null
      : `The ${task.sink} sink takes a Markdown answer: remove the output schema.`;
  }
  if (task.outputSchema === undefined) {
    return `The ${task.sink} sink takes structured output: declare an output schema it accepts.`;
  }
  const problem = outputSchemaProblem(task.outputSchema, sink.output.schema);
  return problem && `The ${task.sink} sink doesn't accept this output schema: ${problem}`;
}
