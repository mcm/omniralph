import "server-only";
import {
  validateTaskDefinition,
  type AgentDefinition,
  type SinkKind,
  type SinkOutput,
  type TaskDefinition,
  type TaskValidation,
  type TaskValidationContext,
} from "@omniralph/tasks";
import { z } from "zod";
import { allSinks, type Sink } from "@/lib/sinks";
import { listAgentDefinitions, listTaskDefinitions } from "./index";

/**
 * Save-time validation of an organization's definitions: the validators of
 * `@omniralph/tasks` with what only the control panel knows, the
 * organization's agents and tasks and the output each sink accepts.
 */

type Queryable = Parameters<typeof listAgentDefinitions>[0];

/** What `sink` accepts, for `validateTaskDefinition`: its structured output as a JSON schema. */
export function sinkOutput(sink: Sink): SinkOutput {
  if (sink.taskType !== "query") return { taskType: sink.taskType };
  if (sink.anyOutput) return { taskType: "query", output: "any" };
  if (sink.outputSchema === null) return { taskType: "query", output: "answer" };
  // What a task's output must satisfy is the input side of the sink's schema.
  const schema = z.toJSONSchema(sink.outputSchema, { io: "input", unrepresentable: "any" });
  return { taskType: "query", output: { schema } };
}

/** What every implemented sink accepts, by kind. */
export function sinkOutputs(): Partial<Record<SinkKind, SinkOutput>> {
  return Object.fromEntries(allSinks().map((sink) => [sink.kind, sinkOutput(sink)]));
}

/** A validation context over these agents and tasks (built-in and custom), with the real sinks. */
export function taskValidationContext(
  agents: readonly AgentDefinition[],
  tasks: readonly TaskDefinition[],
): TaskValidationContext {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  return {
    getAgent: (id) => agentsById.get(id) ?? null,
    getTask: (id) => tasksById.get(id) ?? null,
    sinks: sinkOutputs(),
  };
}

/** The validation context of an organization: its agents and tasks (built-ins included). */
export async function organizationValidationContext(
  db: Queryable,
  organizationId: string,
): Promise<TaskValidationContext> {
  const [agents, tasks] = await Promise.all([
    listAgentDefinitions(db, organizationId),
    listTaskDefinitions(db, organizationId),
  ]);
  return taskValidationContext(
    agents.map((agent) => agent.definition),
    tasks.map((task) => task.definition),
  );
}

/** `validateTaskDefinition` against the organization's definitions and the real sinks. */
export async function validateOrganizationTask(
  db: Queryable,
  organizationId: string,
  input: unknown,
): Promise<TaskValidation> {
  return validateTaskDefinition(input, await organizationValidationContext(db, organizationId));
}
