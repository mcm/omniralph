/**
 * The building blocks of playbooks (`playbooks.ts`) and the two halves of the
 * run spec an agent runs: `RunSpecAgent` (persona: system prompt, tools,
 * model) and `TaskDefinition` (what to do and when: task type, triggers,
 * prompt template, tool settings, sink). The control panel builds both from a
 * playbook (`playbookRunSpec`); custom tasks stored before playbooks still
 * parse as `TaskDefinition`.
 */
import { z } from "zod";
import { HostToolName } from "./host-tools.js";
import { DefinitionId } from "./ids.js";
import {
  INSTALLABLE_MCP_SERVER_SEPARATOR,
  InstallablePackageName,
  parseInstallableMcpServerRef,
} from "./installables.js";
import {
  AGENT_TOOLS,
  AGENT_TOOLS_BY_TASK_TYPE,
  LINEAR_TOOLS,
  SINK_KINDS,
  TASK_TYPES,
  TRIGGER_KINDS,
  type TaskType,
} from "./kinds.js";

export const TaskTypeSchema = z.enum(TASK_TYPES);
export const TriggerKindSchema = z.enum(TRIGGER_KINDS);
export const SinkKindSchema = z.enum(SINK_KINDS);
export const AgentToolSchema = z.enum(AGENT_TOOLS);
export const LinearToolSchema = z.enum(LINEAR_TOOLS);

const Name = z.string().trim().min(1).max(200);
const Description = z.string().max(2000);
const Model = z.string().min(1).max(200);

/** A named reference document shipped with a playbook. */
export const NamedContent = z.object({
  name: z.string().trim().min(1).max(200),
  content: z.string().min(1),
});
export type NamedContent = z.infer<typeof NamedContent>;

/** The tools a run's session may use; the task type and tool settings narrow them further. */
export const AgentTools = z.object({
  /** Claude Code tool names (`Read`, `Grep`, `Bash`, …). */
  builtin: z.array(z.string().min(1).max(100)).default([]),
  /** Agent tools from the `omniralph` MCP server. */
  agent: z.array(AgentToolSchema).default([]),
  /** Read-only Linear tools (need `toolSettings.linearRead`). */
  linear: z.array(LinearToolSchema).default([]),
  /**
   * An installable's MCP servers, as `<package>:<server>`
   * (`@omniralph/code-graph:graph`): runs then require that installable.
   * Other names are accepted on the wire (custom agents stored before
   * playbooks) and ignored by the agent; playbooks refuse them
   * (`PlaybookTools`).
   */
  mcpServers: z
    .array(
      z
        .string()
        .min(1)
        .max(300)
        .refine(
          (name) =>
            !name.includes(INSTALLABLE_MCP_SERVER_SEPARATOR) ||
            parseInstallableMcpServerRef(name) !== null,
          "Name an installable's MCP server as <package>:<server>",
        ),
    )
    .default([]),
});
export type AgentTools = z.infer<typeof AgentTools>;
export type AgentToolsInput = z.input<typeof AgentTools>;

/**
 * `append` adds the system prompt to the Claude Code preset; `replace` uses it
 * instead of the preset (as learn-rule, review replies and code questions do).
 */
export const SYSTEM_PROMPT_MODES = ["append", "replace"] as const;
export type SystemPromptMode = (typeof SYSTEM_PROMPT_MODES)[number];

/**
 * The agent half of a run spec: the persona a run's session gets (system
 * prompt, tools, reference docs, model). `playbookRunSpec` builds it from a
 * playbook; its ID and name are the playbook's. Fields it doesn't know pass
 * through untouched: the control panel still sends the `taskTypes` that
 * agents up to 0.13 require of an agent.
 */
export const RunSpecAgent = z.looseObject({
  id: DefinitionId,
  name: Name,
  description: Description.default(""),
  systemPrompt: z.string(),
  systemPromptMode: z.enum(SYSTEM_PROMPT_MODES).default("append"),
  tools: AgentTools.default({ builtin: [], agent: [], linear: [], mcpServers: [] }),
  referenceDocs: z.array(NamedContent).default([]),
  /** The playbook's model; null for the Claude Code default. Never a review run's. */
  model: Model.nullable().default(null),
  fallbackModel: Model.nullable().default(null),
});
export type RunSpecAgent = z.infer<typeof RunSpecAgent>;
export type RunSpecAgentInput = z.input<typeof RunSpecAgent>;

export const ToolSettings = z.object({
  /** Shell access (`Bash`) in the session. */
  shell: z.boolean().default(false),
  /** The read-only Linear tools. */
  linearRead: z.boolean().default(false),
  /** Network access beyond the control panel. */
  network: z.boolean().default(false),
});
export type ToolSettings = z.infer<typeof ToolSettings>;

/**
 * A run's fixed token cap, or null for "No limit". Review tasks set none: their
 * run's cap comes from the review depth.
 */
export const TokenBudget = z
  .strictObject({ tokens: z.int().min(1) })
  .nullable()
  .describe('A fixed token cap ({ tokens }), or null for "No limit".');
export type TokenBudget = z.infer<typeof TokenBudget>;

/** Most setup (and teardown) commands a task may declare. */
export const MAX_SETUP_COMMANDS = 20;
/** Default and most seconds a setup or teardown command may take. */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 5 * 60;
export const MAX_COMMAND_TIMEOUT_SECONDS = 30 * 60;
/** Default and most bytes of a command's stdout kept (for `{{setup.<name>}}` or the log). */
export const DEFAULT_COMMAND_OUTPUT_BYTES = 20_000;
export const MAX_COMMAND_OUTPUT_BYTES = 200_000;

const ShellCommand = z.string().trim().min(1).max(4000);
const CommandName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "Use lowercase letters, digits and _, starting with a letter")
  .max(100);
const CommandTimeoutSeconds = z
  .number()
  .gt(0)
  .max(MAX_COMMAND_TIMEOUT_SECONDS)
  .default(DEFAULT_COMMAND_TIMEOUT_SECONDS);
const CommandOutputBytes = z
  .int()
  .min(1)
  .max(MAX_COMMAND_OUTPUT_BYTES)
  .default(DEFAULT_COMMAND_OUTPUT_BYTES);

/**
 * A command run (with `sh -c`) in the working directory before the session,
 * without either job token in its environment. Its stdout, cut to
 * `maxOutputBytes`, becomes the untrusted variable `setup.<name>`. A failing
 * command (non-zero exit, timeout) fails the run, unless it's `optional`:
 * then `setup.<name>` holds a short failure note instead.
 */
export const SetupCommand = z.object({
  /** The variable's name after `setup.`. */
  name: CommandName,
  command: ShellCommand,
  timeoutSeconds: CommandTimeoutSeconds,
  maxOutputBytes: CommandOutputBytes,
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

/**
 * A command run after finish, whatever happened; its failure is logged, never
 * fatal. Its stdout, cut to `maxOutputBytes`, is logged.
 */
export const TeardownCommand = z.object({
  name: CommandName,
  command: ShellCommand,
  timeoutSeconds: CommandTimeoutSeconds,
  maxOutputBytes: CommandOutputBytes,
});
export type TeardownCommand = z.infer<typeof TeardownCommand>;

/** Most installables or host tools a task may require. */
export const MAX_TASK_REQUIRES = 20;

/**
 * What a task's runs need on the agent beyond its agent's tools: installables
 * (npm package names) and host tools (names in the organization's catalog).
 * Only agents reporting all of them claim its runs.
 */
export const TaskRequires = z.object({
  installables: z.array(InstallablePackageName).max(MAX_TASK_REQUIRES).default([]),
  hostTools: z.array(HostToolName).max(MAX_TASK_REQUIRES).default([]),
});
export type TaskRequires = z.infer<typeof TaskRequires>;

/** Attempts a story gets before it is marked exhausted (`MAX_ATTEMPTS_PER_STORY` in `@omniralph/shared`). */
export const DEFAULT_MAX_ATTEMPTS_PER_STORY = 3;
/** Rounds (blocked results that file follow-ups) a story gets (`MAX_ROUNDS_PER_STORY` in `@omniralph/shared`). */
export const DEFAULT_MAX_ROUNDS_PER_STORY = 8;
/** Rounds without a better metric before a story is set aside (`STALL_ROUNDS` in `@omniralph/shared`). */
export const DEFAULT_STALL_ROUNDS = 3;
/** Story attempts a run makes before it stops and asks (`MAX_ITERATIONS_PER_RUN` of the control panel). */
export const DEFAULT_MAX_ITERATIONS_PER_RUN = 50;
/** Most review or CI fix rounds (`MAX_FIX_ROUNDS` in `@omniralph/shared`; a test there checks they agree). */
export const CODING_MAX_FIX_ROUNDS = 20;
/** Review and CI fix rounds a lane's PR gets when its request playbook sets none. */
export const DEFAULT_FIX_ROUNDS = 3;
/** Most verify commands of a coding playbook (`MAX_VERIFY_COMMANDS` in `@omniralph/shared`). */
export const MAX_VERIFY_COMMANDS = 50;
/** Longest verify or worktree setup command. */
export const MAX_CODING_COMMAND_LENGTH = 4000;
/** Longest wait for an answer about a merged lane's unmerged commits (a week). */
export const MAX_UNMERGED_BRANCH_TIMEOUT_MINUTES = 7 * 24 * 60;

/** When a coding run pushes its branch: after each story, or once when every story is done. */
export const PUSH_TIMINGS = ["per-story", "end"] as const;
export type PushTiming = (typeof PUSH_TIMINGS)[number];
/** When a coding run opens its draft PR: after the first story, or when every story is done. */
export const DRAFT_PULL_REQUEST_TIMINGS = ["early", "end"] as const;
export type DraftPullRequestTiming = (typeof DRAFT_PULL_REQUEST_TIMINGS)[number];

/** The query task that writes a coding run's PR description by default. */
export const DEFAULT_PR_DESCRIPTION_TASK_ID = "builtin:describe-pr";

const FixRounds = z.int().min(0).max(CODING_MAX_FIX_ROUNDS);

/** A one-line shell command (a verify command or the worktree setup command). */
const CodingCommand = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CODING_COMMAND_LENGTH)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$/, "Commands are one line, without control characters.");

/** Settings only coding tasks have; parsing a coding task fills their defaults (see `CODING_DEFAULTS`). */
export const CODING_FIELDS = {
  maxAttemptsPerStory: z.int().min(1).max(20).optional(),
  /** Rounds of a review loop (blocked results that file follow-ups) a story gets. */
  maxRoundsPerStory: z.int().min(1).max(100).optional(),
  /** Rounds in a row a story's reported metric may fail to beat its best. */
  stallRounds: z.int().min(1).max(100).optional(),
  maxIterationsPerRun: z.int().min(1).max(1000).optional(),
  /** Review rounds (fixing findings and `@bot` requests) a lane's PR gets. */
  maxReviewRounds: FixRounds.optional(),
  /** CI fix rounds a lane's PR gets. */
  maxFixRounds: FixRounds.optional(),
  pushTiming: z.enum(PUSH_TIMINGS).optional(),
  /** Refused on playbooks: the repo's "open PR early" decides when the draft PR opens. */
  draftPullRequest: z.enum(DRAFT_PULL_REQUEST_TIMINGS).optional(),
  /** Query task (accepting `run.invoked`) that writes the PR title and description. */
  prDescriptionTaskId: DefinitionId.optional(),
  /** Quality gates every story and request runs, before the PRD's. */
  verifyCommands: z.array(CodingCommand).max(MAX_VERIFY_COMMANDS).optional(),
  /** Run once in a fresh branch worktree (e.g. `pnpm install`); null for none. */
  worktreeSetupCommand: CodingCommand.nullable().optional(),
  /** Also run the PRD's `## Quality Gates` commands. */
  runPrdQualityGates: z.boolean().optional(),
  /** Offer to run a manual story's `cyralph-prepare` commands ("Run it"). */
  allowPreparation: z.boolean().optional(),
  /**
   * The state an epic moves to when every story is complete: a state type
   * (`started` or `completed`) or a state name; null leaves it as it is.
   */
  epicCompletedState: z.string().trim().min(1).max(255).nullable().optional(),
  /** Remove the worktree and local branch after the PR merges. */
  cleanupMergedWorktrees: z.boolean().optional(),
  /** A merged lane's unmerged commits' branch is deleted after this long without an answer. */
  unmergedBranchTimeoutMinutes: z.int().min(1).max(MAX_UNMERGED_BRANCH_TIMEOUT_MINUTES).optional(),
};
/** The coding-only fields, which other task types must leave unset. */
export const CODING_FIELD_NAMES = Object.keys(CODING_FIELDS) as (keyof typeof CODING_FIELDS)[];

/** What a coding task's unset coding-only fields become. */
export const CODING_DEFAULTS = {
  maxAttemptsPerStory: DEFAULT_MAX_ATTEMPTS_PER_STORY,
  maxRoundsPerStory: DEFAULT_MAX_ROUNDS_PER_STORY,
  stallRounds: DEFAULT_STALL_ROUNDS,
  maxIterationsPerRun: DEFAULT_MAX_ITERATIONS_PER_RUN,
  maxReviewRounds: DEFAULT_FIX_ROUNDS,
  maxFixRounds: DEFAULT_FIX_ROUNDS,
  pushTiming: "per-story",
  prDescriptionTaskId: DEFAULT_PR_DESCRIPTION_TASK_ID,
  verifyCommands: [] as string[],
  worktreeSetupCommand: null,
  runPrdQualityGates: true,
  allowPreparation: true,
  epicCompletedState: null,
  cleanupMergedWorktrees: true,
  unmergedBranchTimeoutMinutes: 60,
} as const satisfies Partial<Record<keyof typeof CODING_FIELDS, unknown>>;

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * The task half of a run spec (`playbookRunSpec` builds it from a playbook,
 * its task type, triggers and sink from the playbook's role), and the shape
 * of custom tasks stored before playbooks. `agentId` is the playbook's ID.
 */
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
    /** Installables and host tools the task's runs need (the agent's installable MCP servers add theirs). */
    requires: TaskRequires.optional(),
    /** JSON schema the session's output must match; query tasks only. */
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    sink: SinkKindSchema,
    ...CODING_FIELDS,
    /** The playbook's model (also the run spec agent's); unset for the Claude Code default. */
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
    if (task.taskType !== "coding") {
      for (const field of CODING_FIELD_NAMES) {
        if (task[field] === undefined) continue;
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is only allowed on coding tasks`,
        });
      }
    }
  })
  // Coding tasks get the defaults of their coding-only fields (`draftPullRequest` stays unset).
  .transform((task) =>
    task.taskType === "coding" ? { ...CODING_DEFAULTS, ...dropUndefined(task) } : task,
  );
export type TaskDefinition = z.infer<typeof TaskDefinition>;
export type TaskDefinitionInput = z.input<typeof TaskDefinition>;

/**
 * Why `tools` don't fit runs of `taskType`: agent tools the type doesn't
 * allow (`ship` is for coding runs only); null when they fit.
 */
export function agentToolsProblem(
  tools: Pick<AgentTools, "agent">,
  taskType: TaskType,
): string | null {
  const allowed = AGENT_TOOLS_BY_TASK_TYPE[taskType];
  const disallowed = tools.agent.filter((tool) => !allowed.includes(tool));
  if (disallowed.length === 0) return null;
  return `${taskType} runs can't use the agent tool${disallowed.length > 1 ? "s" : ""} ${disallowed.join(", ")}.`;
}
