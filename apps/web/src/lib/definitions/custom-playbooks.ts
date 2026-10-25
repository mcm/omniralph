/**
 * Custom playbooks as they are still stored: a task row and the agent it runs
 * on (built-in playbooks are in code). `customPlaybook` reads such a pair as
 * one playbook, with the role its task type, sink, triggers and output fit, so
 * custom runs resolve through the same path as built-in ones.
 */
import {
  CUSTOM_PLAYBOOK_ROLES,
  correlationProblem,
  Playbook,
  prDescriptionProblem,
  REQUEST_TRIGGERS,
  STORY_TRIGGERS,
  type PlaybookRole,
  type RunSpecAgent,
  type TaskDefinition,
} from "@omniralph/tasks";

/**
 * The playbook role a custom task fits, or null when none does: its task type
 * and sink pick it; a `run-result` query task is a correlation or a PR
 * description by its output schema, and a coding task a request when it
 * accepts every request trigger, else a story when it accepts the story
 * trigger. Built-in-only roles are never a custom task's.
 */
export function customTaskRole(task: TaskDefinition): PlaybookRole | null {
  const role = ((): PlaybookRole | null => {
    switch (task.sink) {
      case "review":
        return task.taskType === "review" ? "review" : null;
      case "sticky-comment":
        return task.taskType === "review" ? "review-summary" : null;
      case "chat-thread":
        return task.taskType === "query" && task.triggers.includes("chat.request")
          ? "chat-ask"
          : null;
      case "run-result":
        if (task.taskType !== "query" || !task.triggers.includes("run.invoked")) return null;
        if (correlationProblem(task) === null) return "correlation";
        return prDescriptionProblem(task) === null ? "pr-description" : null;
      case "ralph-run":
        if (task.taskType !== "coding") return null;
        if (REQUEST_TRIGGERS.every((trigger) => task.triggers.includes(trigger))) return "request";
        return STORY_TRIGGERS.every((trigger) => task.triggers.includes(trigger)) ? "story" : null;
      default:
        return null;
    }
  })();
  return role && CUSTOM_PLAYBOOK_ROLES.includes(role) ? role : null;
}

/**
 * Custom `task` on `agent` as one playbook (the task's ID and name): the
 * agent's persona (system prompt, tools, reference docs, fallback model), the
 * task's prompt and settings, and model = task `model` ?? agent `model` (none
 * on a review playbook: the review depth sets it). Null when the pair fits no
 * playbook role or doesn't make a valid playbook (e.g. an MCP server that
 * isn't an installable's).
 */
export function customPlaybook(task: TaskDefinition, agent: RunSpecAgent): Playbook | null {
  const role = customTaskRole(task);
  if (!role) return null;
  const coding =
    task.taskType === "coding"
      ? {
          maxAttemptsPerStory: task.maxAttemptsPerStory,
          maxRoundsPerStory: task.maxRoundsPerStory,
          stallRounds: task.stallRounds,
          maxIterationsPerRun: task.maxIterationsPerRun,
          maxReviewRounds: task.maxReviewRounds,
          maxFixRounds: task.maxFixRounds,
          pushTiming: task.pushTiming,
          prDescriptionPlaybookId: task.prDescriptionTaskId,
        }
      : undefined;
  const parsed = Playbook.safeParse({
    id: task.id,
    name: task.name,
    description: task.description,
    role,
    systemPrompt: agent.systemPrompt,
    systemPromptMode: agent.systemPromptMode,
    promptTemplate: task.promptTemplate,
    systemAppend: task.systemAppend,
    referenceDocs: agent.referenceDocs,
    model: task.taskType === "review" ? null : (task.model ?? agent.model),
    fallbackModel: agent.fallbackModel,
    tools: agent.tools,
    toolSettings: task.toolSettings,
    requires: task.requires,
    setupCommands: task.setupCommands,
    teardownCommands: task.teardownCommands,
    outputSchema: task.outputSchema,
    tokenBudget: task.tokenBudget,
    coding,
    variableLimits: task.variableLimits,
    idleTimeoutMs: task.idleTimeoutMs,
    maxTurns: task.maxTurns,
  });
  return parsed.success ? parsed.data : null;
}
