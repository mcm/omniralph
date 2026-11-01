/**
 * Playbooks: one recipe per kind of run (role, prompts, model, tools,
 * requirements). A playbook's role fixes its task type, triggers and sink
 * (`PLAYBOOK_ROLES`); everything else a run needs is on the playbook itself.
 * The agent still runs today's run spec (`agent` + `task`), which
 * `playbookRunSpec` builds from a playbook.
 */
import { z } from "zod";
import {
  AgentTools,
  CODING_DEFAULTS,
  CODING_FIELDS,
  DEFAULT_PR_DESCRIPTION_TASK_ID,
  MAX_SETUP_COMMANDS,
  NamedContent,
  RunSpecAgent,
  SetupCommand,
  SYSTEM_PROMPT_MODES,
  TaskDefinition,
  TaskRequires,
  TeardownCommand,
  TokenBudget,
  ToolSettings,
  agentToolsProblem,
  type TaskDefinitionInput,
} from "./definitions.js";
import { DefinitionId } from "./ids.js";
import { parseInstallableMcpServerRef } from "./installables.js";
import {
  REQUEST_TRIGGERS,
  STORY_TRIGGERS,
  type SinkKind,
  type TaskType,
  type TriggerKind,
} from "./kinds.js";
import { deriveTaskRequirements, type TaskRequirements } from "./requirements.js";
import type { VariableDefinition } from "./variables.js";

/** What a role fixes about its playbooks' runs. */
export interface PlaybookRoleSpec {
  taskType: TaskType;
  /** The events that start its runs. */
  triggers: readonly TriggerKind[];
  /** The control-panel code that applies its runs' output. */
  sink: SinkKind;
  /** Only a built-in playbook can take the role (its sink is tied to that playbook's output). */
  builtinOnly: boolean;
}

const REVIEW_TRIGGERS = ["pr.updated", "pr.mention", "review.rerun"] as const;

/**
 * Each playbook role with the task type, triggers and sink it fixes. `triage`,
 * `learn-rule` and `reply-to-finding` are built-in only.
 */
export const PLAYBOOK_ROLES = {
  review: { taskType: "review", triggers: REVIEW_TRIGGERS, sink: "review", builtinOnly: false },
  "review-summary": {
    taskType: "review",
    triggers: REVIEW_TRIGGERS,
    sink: "sticky-comment",
    builtinOnly: false,
  },
  correlation: {
    taskType: "query",
    triggers: ["run.invoked"],
    sink: "run-result",
    builtinOnly: false,
  },
  story: { taskType: "coding", triggers: STORY_TRIGGERS, sink: "ralph-run", builtinOnly: false },
  request: {
    taskType: "coding",
    triggers: REQUEST_TRIGGERS,
    sink: "ralph-run",
    builtinOnly: false,
  },
  "pr-description": {
    taskType: "query",
    triggers: ["run.invoked"],
    sink: "run-result",
    builtinOnly: false,
  },
  "chat-ask": {
    taskType: "query",
    triggers: ["chat.request"],
    sink: "chat-thread",
    builtinOnly: false,
  },
  triage: { taskType: "query", triggers: ["linear.triage"], sink: "triage", builtinOnly: true },
  "learn-rule": {
    taskType: "query",
    triggers: ["finding.dismissed"],
    sink: "learned-rule",
    builtinOnly: true,
  },
  "reply-to-finding": {
    taskType: "query",
    triggers: ["finding.mention"],
    sink: "finding-thread",
    builtinOnly: true,
  },
} as const satisfies Record<string, PlaybookRoleSpec>;

export type PlaybookRole = keyof typeof PLAYBOOK_ROLES;
export const PLAYBOOK_ROLE_IDS = Object.keys(PLAYBOOK_ROLES) as [PlaybookRole, ...PlaybookRole[]];
export const PlaybookRoleSchema = z.enum(PLAYBOOK_ROLE_IDS);

/** The roles a custom playbook can take (every role that isn't built-in only). */
export const CUSTOM_PLAYBOOK_ROLES = PLAYBOOK_ROLE_IDS.filter(
  (role) => !PLAYBOOK_ROLES[role].builtinOnly,
);

/** The task type a role's runs have. */
export function roleTaskType(role: PlaybookRole): TaskType {
  return PLAYBOOK_ROLES[role].taskType;
}

/** A playbook's tools: only installable MCP servers (`<package>:<server>`). */
export const PlaybookTools = AgentTools.extend({
  mcpServers: z
    .array(
      z
        .string()
        .min(1)
        .max(300)
        .refine(
          (name) => parseInstallableMcpServerRef(name) !== null,
          "Name an installable's MCP server as <package>:<server>; other MCP servers can't be used.",
        ),
    )
    .default([]),
});
export type PlaybookTools = z.infer<typeof PlaybookTools>;

const {
  draftPullRequest: _draftPullRequest,
  prDescriptionTaskId: _prDescriptionTaskId,
  ...KEPT_CODING_FIELDS
} = CODING_FIELDS;

/**
 * Settings only story and request playbooks have; unset ones get
 * `CODING_DEFAULTS`. When the draft PR opens is the repo's "open PR early".
 */
export const PlaybookCoding = z.object({
  ...KEPT_CODING_FIELDS,
  /** The `pr-description` playbook that writes the PR title and description. */
  prDescriptionPlaybookId: DefinitionId.optional(),
});
export type PlaybookCoding = z.infer<typeof PlaybookCoding>;

const Model = z.string().min(1).max(200);

const PlaybookFields = z.object({
  id: DefinitionId,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).default(""),
  role: PlaybookRoleSchema,
  systemPrompt: z.string(),
  systemPromptMode: z.enum(SYSTEM_PROMPT_MODES).default("append"),
  promptTemplate: z.string().min(1),
  /** Role-specific system text (e.g. the output contract), appended after the system prompt. */
  systemAppend: z.string().min(1).optional(),
  referenceDocs: z.array(NamedContent).default([]),
  /** Null for the Claude Code default. Review playbooks set none: the review depth does. */
  model: Model.nullable().default(null),
  fallbackModel: Model.nullable().default(null),
  tools: PlaybookTools.default({ builtin: [], agent: [], tracker: [], mcpServers: [] }),
  toolSettings: ToolSettings.default({ shell: false, trackerRead: false, network: false }),
  /** Installables and host tools its runs need (its installable MCP servers add theirs). */
  requires: TaskRequires.optional(),
  /** Run in the working directory, in order, after checkout and before the session. */
  setupCommands: z.array(SetupCommand).max(MAX_SETUP_COMMANDS).default([]),
  /** Run in the working directory, in order, after finish, whatever happened. */
  teardownCommands: z.array(TeardownCommand).max(MAX_SETUP_COMMANDS).default([]),
  /** JSON schema the session's output must match; query roles only. */
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  /** A fixed token cap, or null for "No limit". Review playbooks set none: the review depth does. */
  tokenBudget: TokenBudget.default(null),
  /** Story and request playbooks only. */
  coding: PlaybookCoding.optional(),
  /**
   * Most characters of a variable's value rendered into the prompt, by
   * catalog name (e.g. `{ hunk: 5000 }`); longer values are cut and marked.
   */
  variableLimits: z.record(z.string().min(1).max(200), z.int().min(1)).optional(),
  idleTimeoutMs: z.int().min(1).optional(),
  maxTurns: z.int().min(1).optional(),
});
export type PlaybookInput = z.input<typeof PlaybookFields>;

/**
 * Fields agent and task definitions had that a playbook doesn't, with why:
 * parsing a playbook that sets one fails with that message. (`skills`, never
 * read by the agent, is dropped from old input instead.)
 */
export const REFUSED_PLAYBOOK_FIELDS = {
  taskTypes: "A playbook's role sets its task type; remove taskTypes.",
  sink: "A playbook's role sets where its output goes; remove sink.",
  pool: "A run's pool follows from its role's task type; remove pool.",
  triggers: "A playbook's role sets what starts its runs; remove triggers.",
  draftPullRequest:
    'The repo\'s "open PR early" setting decides when the draft PR opens; remove draftPullRequest.',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Old input without `skills`, with an issue for each refused field it sets. */
function refuseRemovedFields(input: unknown, ctx: z.RefinementCtx): unknown {
  if (!isRecord(input)) return input;
  for (const [field, message] of Object.entries(REFUSED_PLAYBOOK_FIELDS)) {
    if (field in input) ctx.addIssue({ code: "custom", path: [field], message });
  }
  if (isRecord(input.coding) && "draftPullRequest" in input.coding) {
    ctx.addIssue({
      code: "custom",
      path: ["coding", "draftPullRequest"],
      message: REFUSED_PLAYBOOK_FIELDS.draftPullRequest,
    });
  }
  const { skills: _skills, ...rest } = input;
  return rest;
}

export const Playbook = z.preprocess(
  refuseRemovedFields,
  PlaybookFields.superRefine((playbook, ctx) => {
    const { taskType } = PLAYBOOK_ROLES[playbook.role];
    const names = new Set<string>();
    playbook.setupCommands.forEach((command, index) => {
      if (names.has(command.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["setupCommands", index, "name"],
          message: `Setup command name ${command.name} is used twice`,
        });
      }
      names.add(command.name);
    });
    if (playbook.outputSchema !== undefined && taskType !== "query") {
      ctx.addIssue({
        code: "custom",
        path: ["outputSchema"],
        message: `A ${playbook.role} playbook can't declare an output schema.`,
      });
    }
    if (playbook.coding !== undefined && taskType !== "coding") {
      ctx.addIssue({
        code: "custom",
        path: ["coding"],
        message: "Only story and request playbooks have coding settings.",
      });
    }
    if (taskType === "review") {
      if (playbook.model !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["model"],
          message: "Review playbooks can't set a model; the repo's review depth sets it.",
        });
      }
      if (playbook.fallbackModel !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["fallbackModel"],
          message:
            "Review playbooks can't set a fallback model; the repo's review depth sets the model.",
        });
      }
      if (playbook.tokenBudget !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["tokenBudget"],
          message: "Review playbooks can't set a token budget; the repo's review depth sets it.",
        });
      }
    }
    const toolsProblem = agentToolsProblem(playbook.tools, taskType);
    if (toolsProblem) {
      ctx.addIssue({ code: "custom", path: ["tools", "agent"], message: toolsProblem });
    }
  }),
);
export type Playbook = z.infer<typeof Playbook>;

/** The task type of `playbook`'s runs (its role's). */
export function playbookTaskType(playbook: Pick<Playbook, "role">): TaskType {
  return roleTaskType(playbook.role);
}

/** The two halves of the run spec an agent runs. */
export interface PlaybookRunSpec {
  agent: RunSpecAgent;
  task: TaskDefinition;
}

/**
 * The run spec `agent` and `task` the agent runs for `playbook`: the agent
 * carries its persona (system prompt, tools, reference docs, model), the task
 * the rest, with the task type, triggers and sink of its role and, for a story
 * or request playbook, its coding settings over `CODING_DEFAULTS`. Both take
 * the playbook's ID and name. The one place a playbook becomes a run spec.
 */
export function playbookRunSpec(playbook: Playbook): PlaybookRunSpec {
  const role = PLAYBOOK_ROLES[playbook.role];
  const agent = RunSpecAgent.parse({
    id: playbook.id,
    name: playbook.name,
    description: playbook.description,
    systemPrompt: playbook.systemPrompt,
    systemPromptMode: playbook.systemPromptMode,
    tools: playbook.tools,
    referenceDocs: playbook.referenceDocs,
    model: playbook.model,
    fallbackModel: playbook.fallbackModel,
  });
  let coding: Partial<TaskDefinitionInput> = {};
  if (role.taskType === "coding") {
    const { prDescriptionPlaybookId, ...settings } = playbook.coding ?? {};
    coding = {
      ...CODING_DEFAULTS,
      ...dropUndefined(settings),
      prDescriptionTaskId: prDescriptionPlaybookId ?? DEFAULT_PR_DESCRIPTION_TASK_ID,
    };
  }
  const task = TaskDefinition.parse(
    dropUndefined({
      id: playbook.id,
      name: playbook.name,
      description: playbook.description,
      taskType: role.taskType,
      agentId: playbook.id,
      triggers: [...role.triggers],
      promptTemplate: playbook.promptTemplate,
      systemAppend: playbook.systemAppend,
      setupCommands: playbook.setupCommands,
      teardownCommands: playbook.teardownCommands,
      toolSettings: playbook.toolSettings,
      requires: playbook.requires,
      outputSchema: playbook.outputSchema,
      sink: role.sink,
      ...coding,
      model: playbook.model ?? undefined,
      tokenBudget: playbook.tokenBudget,
      variableLimits: playbook.variableLimits,
      idleTimeoutMs: playbook.idleTimeoutMs,
      maxTurns: playbook.maxTurns,
    } satisfies TaskDefinitionInput),
  );
  return { agent, task };
}

/** What runs of `playbook` need from an agent (`deriveTaskRequirements` of its run spec). */
export function playbookRequirements(
  playbook: Playbook,
  catalog?: readonly VariableDefinition[],
): TaskRequirements {
  const { agent, task } = playbookRunSpec(playbook);
  return deriveTaskRequirements(task, catalog, agent);
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * The persona part of a playbook (system prompt, its mode, tools, reference
 * docs): what built-in playbooks that share a persona (the reviewer, the
 * engineer) spread in.
 */
export type PlaybookPersona = Pick<PlaybookInput, "systemPrompt"> &
  Partial<Pick<PlaybookInput, "systemPromptMode" | "tools" | "referenceDocs">>;
