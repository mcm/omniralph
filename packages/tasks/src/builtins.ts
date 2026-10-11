/**
 * The built-in agent and task definitions (IDs `builtin:<name>`), shipped in
 * code. Port stories add theirs to `AGENT_INPUTS`/`TASK_INPUTS`;
 * `builtinProblems` (run by a test over the registry) checks they fit together.
 */
import {
  AgentDefinition,
  TaskDefinition,
  validateAgentForTask,
  type AgentDefinitionInput,
  type TaskDefinitionInput,
} from "./definitions.js";
import { ASK_ABOUT_CODE_TASK, CODE_EXPLAINER_AGENT } from "./builtin/ask-about-code.js";
import { LEARN_RULE_TASK, RULE_WRITER_AGENT } from "./builtin/learn-rule.js";
import { REPLY_TASK, REVIEWER_AGENT } from "./builtin/reply.js";
import { isBuiltinId } from "./ids.js";
import { validateTemplate } from "./template.js";
import { availableVariables } from "./variables.js";

const AGENT_INPUTS: readonly AgentDefinitionInput[] = [
  RULE_WRITER_AGENT,
  REVIEWER_AGENT,
  CODE_EXPLAINER_AGENT,
];

const TASK_INPUTS: readonly TaskDefinitionInput[] = [
  LEARN_RULE_TASK,
  REPLY_TASK,
  ASK_ABOUT_CODE_TASK,
];

export const BUILTIN_AGENTS: readonly AgentDefinition[] = AGENT_INPUTS.map((agent) =>
  AgentDefinition.parse(agent),
);

export const BUILTIN_TASKS: readonly TaskDefinition[] = TASK_INPUTS.map((task) =>
  TaskDefinition.parse(task),
);

/** The built-in agent with `id`, or null. */
export function getBuiltinAgent(id: string): AgentDefinition | null {
  return BUILTIN_AGENTS.find((agent) => agent.id === id) ?? null;
}

/** The built-in task with `id`, or null. */
export function getBuiltinTask(id: string): TaskDefinition | null {
  return BUILTIN_TASKS.find((task) => task.id === id) ?? null;
}

/**
 * Problems with a set of built-in definitions; empty when they're fine. Each
 * must parse, have a unique `builtin:` ID; each task must reference one of
 * `agents`, fit it (`validateAgentForTask`) and have a template (and
 * variable limits) using only the variables its task type and triggers provide.
 */
export function builtinProblems(agents: readonly unknown[], tasks: readonly unknown[]): string[] {
  const problems: string[] = [];
  const parsedAgents = new Map<string, AgentDefinition>();
  const parsedTaskIds = new Set<string>();
  const checkId = (kind: string, id: string, seen: { has(id: string): boolean }) => {
    if (!isBuiltinId(id)) problems.push(`${kind} ${id} doesn't have a builtin: ID.`);
    if (seen.has(id)) problems.push(`${kind} ${id} is defined twice.`);
  };

  agents.forEach((input, index) => {
    const parsed = AgentDefinition.safeParse(input);
    if (!parsed.success) {
      problems.push(`Agent #${index + 1} doesn't parse: ${parsed.error.message}`);
      return;
    }
    checkId("Agent", parsed.data.id, parsedAgents);
    parsedAgents.set(parsed.data.id, parsed.data);
  });

  tasks.forEach((input, index) => {
    const parsed = TaskDefinition.safeParse(input);
    if (!parsed.success) {
      problems.push(`Task #${index + 1} doesn't parse: ${parsed.error.message}`);
      return;
    }
    const task = parsed.data;
    checkId("Task", task.id, parsedTaskIds);
    parsedTaskIds.add(task.id);
    const agent = parsedAgents.get(task.agentId);
    if (!agent) {
      problems.push(`Task ${task.id} references the unknown agent ${task.agentId}.`);
    } else {
      problems.push(...validateAgentForTask(agent, task).map((p) => `Task ${task.id}: ${p}`));
    }
    const available = availableVariables(task.taskType, task.triggers);
    for (const problem of validateTemplate(task.promptTemplate, available)) {
      const what = problem.kind === "parse" ? problem.message : `unknown variable ${problem.name}`;
      problems.push(`Task ${task.id} template (${problem.line}:${problem.column}): ${what}`);
    }
    for (const name of Object.keys(task.variableLimits ?? {})) {
      if (!available.includes(name))
        problems.push(`Task ${task.id} limits the unknown variable ${name}.`);
    }
  });
  return problems;
}
