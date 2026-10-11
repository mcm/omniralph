/**
 * Agent and task definitions. An agent definition says how to do a kind of
 * work (persona: system prompt, tools, skills, model); a task definition says
 * what to do and when (one task on one agent: task type, triggers, prompt
 * template, tool settings, sink, pool).
 */
import { z } from "zod";
import { DefinitionId } from "./ids.js";
import {
  HARNESS_TOOLS,
  HARNESS_TOOLS_BY_TASK_TYPE,
  LINEAR_TOOLS,
  POOLS,
  SINK_KINDS,
  TASK_TYPES,
  TRIGGER_KINDS,
} from "./kinds.js";

export const TaskTypeSchema = z.enum(TASK_TYPES);
export const PoolNameSchema = z.enum(POOLS);
export const TriggerKindSchema = z.enum(TRIGGER_KINDS);
export const SinkKindSchema = z.enum(SINK_KINDS);
export const HarnessToolSchema = z.enum(HARNESS_TOOLS);
export const LinearToolSchema = z.enum(LINEAR_TOOLS);

const Name = z.string().trim().min(1).max(200);
const Description = z.string().max(2000);
const Model = z.string().min(1).max(200);

/** A named document (skill or reference doc) shipped with an agent. */
export const NamedContent = z.object({
  name: z.string().trim().min(1).max(200),
  content: z.string().min(1),
});
export type NamedContent = z.infer<typeof NamedContent>;

/** The tools an agent wants; the task type and task settings narrow them further. */
export const AgentTools = z.object({
  /** Claude Code tool names (`Read`, `Grep`, `Bash`, …). */
  builtin: z.array(z.string().min(1).max(100)).default([]),
  /** Harness tools from the `omniralph` MCP server. */
  harness: z.array(HarnessToolSchema).default([]),
  /** Read-only Linear tools (need the task's `toolSettings.linearRead`). */
  linear: z.array(LinearToolSchema).default([]),
  /** Names of configured MCP servers. */
  mcpServers: z.array(z.string().min(1).max(100)).default([]),
});
export type AgentTools = z.infer<typeof AgentTools>;

/**
 * `append` adds the agent's system prompt to the Claude Code preset;
 * `replace` uses it instead of the preset (as learn-rule, review replies and
 * code questions do today).
 */
export const SYSTEM_PROMPT_MODES = ["append", "replace"] as const;
export type SystemPromptMode = (typeof SYSTEM_PROMPT_MODES)[number];

export const AgentDefinition = z.object({
  id: DefinitionId,
  name: Name,
  description: Description.default(""),
  systemPrompt: z.string(),
  systemPromptMode: z.enum(SYSTEM_PROMPT_MODES).default("append"),
  tools: AgentTools.default({ builtin: [], harness: [], linear: [], mcpServers: [] }),
  skills: z.array(NamedContent).default([]),
  referenceDocs: z.array(NamedContent).default([]),
  /** Null uses the repository profile's model, or the Claude Code default. */
  model: Model.nullable().default(null),
  fallbackModel: Model.nullable().default(null),
  /** Task types this agent suits. */
  taskTypes: z.array(TaskTypeSchema).min(1),
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;
export type AgentDefinitionInput = z.input<typeof AgentDefinition>;

export const ToolSettings = z.object({
  /** Shell access (`Bash`) in the session. */
  shell: z.boolean().default(false),
  /** The read-only Linear tools. */
  linearRead: z.boolean().default(false),
  /** Network access beyond the control panel. */
  network: z.boolean().default(false),
});
export type ToolSettings = z.infer<typeof ToolSettings>;

/** A run's token cap: a fixed number, or a fraction of the repository profile's budget. */
export const TokenBudget = z
  .union([
    z.strictObject({ tokens: z.int().min(1) }),
    z.strictObject({ profileFraction: z.number().gt(0).max(1) }),
  ])
  .nullable();
export type TokenBudget = z.infer<typeof TokenBudget>;

/** Most setup (and teardown) commands a task may declare. */
export const MAX_SETUP_COMMANDS = 20;
/** Default and most time a setup or teardown command may take. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;
export const MAX_COMMAND_TIMEOUT_MS = 30 * 60_000;
/** Default and most characters of a setup command's stdout kept for `{{setup.<name>}}`. */
export const DEFAULT_SETUP_OUTPUT_CHARS = 20_000;
export const MAX_SETUP_OUTPUT_CHARS = 200_000;

const ShellCommand = z.string().trim().min(1).max(4000);
const CommandTimeoutMs = z
  .int()
  .min(1)
  .max(MAX_COMMAND_TIMEOUT_MS)
  .default(DEFAULT_COMMAND_TIMEOUT_MS);

/**
 * A command run (with `bash -lc`) in the working directory before the
 * session, without either job token in its environment. Its stdout, cut to
 * `maxOutputChars`, becomes the untrusted variable `setup.<name>`. A failing
 * command (non-zero exit, timeout) fails the run, unless it's `optional`:
 * then `setup.<name>` holds a short failure note instead.
 */
export const SetupCommand = z.object({
  /** The variable's name after `setup.` (letters, digits, `_` and `-`). */
  name: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, "Use letters, digits, _ and -, not starting with a digit")
    .max(100),
  command: ShellCommand,
  timeoutMs: CommandTimeoutMs,
  maxOutputChars: z.int().min(1).max(MAX_SETUP_OUTPUT_CHARS).default(DEFAULT_SETUP_OUTPUT_CHARS),
  /** Info string of the fence around the output (e.g. `json`). */
  fence: z
    .string()
    .regex(/^[A-Za-z0-9_+.-]*$/)
    .max(50)
    .default(""),
  optional: z.boolean().default(false),
});
export type SetupCommand = z.infer<typeof SetupCommand>;
export type SetupCommandInput = z.input<typeof SetupCommand>;

/** A command run after finish, whatever happened; its failure is logged, never fatal. */
export const TeardownCommand = z.object({
  command: ShellCommand,
  timeoutMs: CommandTimeoutMs,
});
export type TeardownCommand = z.infer<typeof TeardownCommand>;

export const TaskDefinition = z
  .object({
    id: DefinitionId,
    name: Name,
    description: Description.default(""),
    taskType: TaskTypeSchema,
    agentId: DefinitionId,
    triggers: z.array(TriggerKindSchema).min(1),
    promptTemplate: z.string().min(1),
    /** Task-specific system text (e.g. the output contract), appended after the agent's system prompt. */
    systemAppend: z.string().min(1).optional(),
    /** Run in the working directory, in order, after checkout and before the session. */
    setupCommands: z.array(SetupCommand).max(MAX_SETUP_COMMANDS).default([]),
    /** Run in the working directory, in order, after finish, whatever happened. */
    teardownCommands: z.array(TeardownCommand).max(MAX_SETUP_COMMANDS).default([]),
    toolSettings: ToolSettings.default({ shell: false, linearRead: false, network: false }),
    /** JSON schema the session's output must match; query tasks only. */
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    sink: SinkKindSchema,
    /** Task that writes the PR description; coding tasks only. */
    describePrTaskId: DefinitionId.optional(),
    pool: PoolNameSchema,
    /** Overrides the agent's model. */
    model: Model.optional(),
    tokenBudget: TokenBudget.default(null),
    /**
     * Most characters of a variable's value rendered into the prompt, by
     * catalog name (e.g. `{ hunk: 5000 }`); longer values are cut and marked.
     */
    variableLimits: z.record(z.string().min(1).max(200), z.int().min(1)).optional(),
    idleTimeoutMs: z.int().min(1).optional(),
    maxTurns: z.int().min(1).optional(),
  })
  .superRefine((task, ctx) => {
    const names = new Set<string>();
    task.setupCommands.forEach((command, index) => {
      if (names.has(command.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["setupCommands", index, "name"],
          message: `Setup command name ${command.name} is used twice`,
        });
      }
      names.add(command.name);
    });
    if (task.outputSchema !== undefined && task.taskType !== "query") {
      ctx.addIssue({
        code: "custom",
        path: ["outputSchema"],
        message: "outputSchema is only allowed on query tasks",
      });
    }
    if (task.describePrTaskId !== undefined && task.taskType !== "coding") {
      ctx.addIssue({
        code: "custom",
        path: ["describePrTaskId"],
        message: "describePrTaskId is only allowed on coding tasks",
      });
    }
  });
export type TaskDefinition = z.infer<typeof TaskDefinition>;
export type TaskDefinitionInput = z.input<typeof TaskDefinition>;

/**
 * Problems running `task` on `agent`: the agent doesn't suit the task's type,
 * or wants harness tools the type doesn't allow. Empty when they fit.
 */
export function validateAgentForTask(
  agent: Pick<AgentDefinition, "id" | "taskTypes" | "tools">,
  task: Pick<TaskDefinition, "taskType">,
): string[] {
  const problems: string[] = [];
  if (!agent.taskTypes.includes(task.taskType)) {
    problems.push(
      `Agent ${agent.id} suits ${agent.taskTypes.join(", ")} tasks, not ${task.taskType}.`,
    );
  }
  const allowed = HARNESS_TOOLS_BY_TASK_TYPE[task.taskType];
  const disallowed = agent.tools.harness.filter((tool) => !allowed.includes(tool));
  if (disallowed.length > 0) {
    problems.push(
      `${task.taskType} tasks can't use the harness tool${disallowed.length > 1 ? "s" : ""} ${disallowed.join(", ")}.`,
    );
  }
  return problems;
}
