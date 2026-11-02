import {
  AGENT_TOOLS_BY_TASK_TYPE,
  CODING_DEFAULTS,
  CORRELATION_OUTPUT_SCHEMA,
  DEFAULT_PR_DESCRIPTION_TASK_ID,
  DEFAULT_VERIFIER_TASK_ID,
  DEFAULT_AUDIT_TASK_ID,
  DEFAULT_MAX_AUDIT_ROUNDS,
  MAX_AUDIT_ROUNDS,
  HostToolName,
  InstallablePackageName,
  LOOP_DEFAULTS,
  MAX_LOOP_ITERATIONS,
  MAX_LOOP_STALL_ROUNDS,
  PR_DESCRIPTION_OUTPUT_SCHEMA,
  roleHasLoopSettings,
  roleLoops,
  roleTaskType,
  type JsonSchema,
  type Playbook,
  type PlaybookRole,
  type SystemPromptMode,
} from "@omniralph/tasks";

/**
 * The playbook editor's draft: what its fields edit, as the fields hold it (numbers as
 * typed text), and the playbook it started from, whose other fields (output schema,
 * variable limits, a command's timeout) a save keeps as they are.
 */

/** A setup or teardown command row: its name and command, the rest kept from the playbook. */
export interface CommandDraft {
  /** A stable React key. */
  key: string;
  name: string;
  command: string;
  rest: Record<string, unknown>;
}

/** A reference document row. */
export interface ReferenceDocDraft {
  key: string;
  name: string;
  content: string;
}

export interface CodingDraft {
  worktreeSetupCommand: string;
  runPrdQualityGates: boolean;
  allowPreparation: boolean;
  /** `started`, `completed` or a state name; null leaves the epic as it is. */
  epicCompletedState: string | null;
  cleanupMergedWorktrees: boolean;
  unmergedBranchTimeoutMinutes: string;
  prDescriptionPlaybookId: string;
  /** A story playbook's task verifier. */
  verifierPlaybookId: string;
  /** A story playbook's epic audit, and its rounds as typed. */
  auditPlaybookId: string;
  maxAuditRounds: string;
  /** A story playbook's loop settings, as typed. */
  maxAttemptsPerStory: string;
  maxRoundsPerStory: string;
  stallRounds: string;
}

/** A looped non-coding playbook's loop limits, as typed. */
export interface LoopDraft {
  /** A looped playbook's verifier; "" for none (its runs are one session). */
  verifierPlaybookId: string;
  maxIterations: string;
  stallRounds: string;
}

export interface PlaybookDraft {
  /** The playbook it started from (empty for a new one): fields the editor doesn't show. */
  base: Record<string, unknown>;
  name: string;
  description: string;
  role: PlaybookRole;
  systemPrompt: string;
  systemPromptMode: SystemPromptMode;
  promptTemplate: string;
  referenceDocs: ReferenceDocDraft[];
  /** Null for the Claude Code default. */
  model: string | null;
  fallbackModel: string | null;
  /** "No limit", or a cap typed as text. */
  tokenLimit: { limited: boolean; tokens: string };
  tools: { builtin: string[]; agent: string[]; tracker: string[]; mcpServers: string[] };
  toolSettings: { shell: boolean; trackerRead: boolean; network: boolean };
  requires: { installables: string[]; hostTools: string[] };
  setupCommands: CommandDraft[];
  teardownCommands: CommandDraft[];
  coding: CodingDraft;
  loop: LoopDraft;
}

let nextKey = 0;
/** A key for a new list row. */
export function rowKey(): string {
  nextKey += 1;
  return `row-${nextKey}`;
}

/** Whether `role`'s runs are reviews (the review depth picks their model and budget). */
export function isReviewRole(role: PlaybookRole): boolean {
  return roleTaskType(role) === "review";
}

/** Whether `role` has coding settings (story and request). */
export function isCodingRole(role: PlaybookRole): boolean {
  return roleTaskType(role) === "coding";
}

/** Whether the editor shows `role`'s loop settings (every looped role). */
export function showsLoopSettings(role: PlaybookRole): boolean {
  return roleLoops(role);
}

/** The agent tools `role`'s runs may use. */
export function agentToolsFor(role: PlaybookRole): readonly string[] {
  return AGENT_TOOLS_BY_TASK_TYPE[roleTaskType(role)];
}

function commandDrafts(commands: readonly { name: string; command: string }[]): CommandDraft[] {
  return commands.map(({ name, command, ...rest }) => ({ key: rowKey(), name, command, rest }));
}

function codingDraft(coding: Playbook["coding"]): CodingDraft {
  const set = coding ?? {};
  return {
    worktreeSetupCommand: set.worktreeSetupCommand ?? "",
    runPrdQualityGates: set.runPrdQualityGates ?? CODING_DEFAULTS.runPrdQualityGates,
    allowPreparation: set.allowPreparation ?? CODING_DEFAULTS.allowPreparation,
    epicCompletedState:
      set.epicCompletedState === undefined
        ? CODING_DEFAULTS.epicCompletedState
        : set.epicCompletedState,
    cleanupMergedWorktrees: set.cleanupMergedWorktrees ?? CODING_DEFAULTS.cleanupMergedWorktrees,
    unmergedBranchTimeoutMinutes: String(
      set.unmergedBranchTimeoutMinutes ?? CODING_DEFAULTS.unmergedBranchTimeoutMinutes,
    ),
    prDescriptionPlaybookId: set.prDescriptionPlaybookId ?? DEFAULT_PR_DESCRIPTION_TASK_ID,
    verifierPlaybookId: set.verifierPlaybookId ?? DEFAULT_VERIFIER_TASK_ID,
    auditPlaybookId: set.auditPlaybookId ?? DEFAULT_AUDIT_TASK_ID,
    maxAuditRounds: String(set.maxAuditRounds ?? DEFAULT_MAX_AUDIT_ROUNDS),
    maxAttemptsPerStory: String(set.maxAttemptsPerStory ?? CODING_DEFAULTS.maxAttemptsPerStory),
    maxRoundsPerStory: String(set.maxRoundsPerStory ?? CODING_DEFAULTS.maxRoundsPerStory),
    stallRounds: String(set.stallRounds ?? CODING_DEFAULTS.stallRounds),
  };
}

function loopDraft(loop: Playbook["loop"]): LoopDraft {
  return {
    verifierPlaybookId: loop?.verifierPlaybookId ?? "",
    maxIterations: String(loop?.maxIterations ?? LOOP_DEFAULTS.maxIterations),
    stallRounds: String(loop?.stallRounds ?? LOOP_DEFAULTS.stallRounds),
  };
}

/** The draft of an existing playbook. */
export function draftFromPlaybook(playbook: Playbook): PlaybookDraft {
  return {
    base: { ...playbook },
    name: playbook.name,
    description: playbook.description,
    role: playbook.role,
    systemPrompt: playbook.systemPrompt,
    systemPromptMode: playbook.systemPromptMode,
    promptTemplate: playbook.promptTemplate,
    referenceDocs: playbook.referenceDocs.map((doc) => ({ key: rowKey(), ...doc })),
    model: playbook.model,
    fallbackModel: playbook.fallbackModel,
    tokenLimit:
      playbook.tokenBudget === null
        ? { limited: false, tokens: "" }
        : { limited: true, tokens: String(playbook.tokenBudget.tokens) },
    tools: {
      builtin: [...playbook.tools.builtin],
      agent: [...playbook.tools.agent],
      tracker: [...playbook.tools.tracker],
      mcpServers: [...playbook.tools.mcpServers],
    },
    toolSettings: { ...playbook.toolSettings },
    requires: {
      installables: [...(playbook.requires?.installables ?? [])],
      hostTools: [...(playbook.requires?.hostTools ?? [])],
    },
    setupCommands: commandDrafts(playbook.setupCommands),
    teardownCommands: commandDrafts(playbook.teardownCommands),
    coding: codingDraft(playbook.coding),
    loop: loopDraft(playbook.loop),
  };
}

/** The draft of a new playbook of `role`. */
export function newDraft(role: PlaybookRole): PlaybookDraft {
  return {
    base: {},
    name: "",
    description: "",
    role,
    systemPrompt: "",
    systemPromptMode: "append",
    promptTemplate: "",
    referenceDocs: [],
    model: null,
    fallbackModel: null,
    tokenLimit: { limited: false, tokens: "" },
    tools: { builtin: [], agent: [], tracker: [], mcpServers: [] },
    toolSettings: { shell: false, trackerRead: false, network: false },
    requires: { installables: [], hostTools: [] },
    setupCommands: [],
    teardownCommands: [],
    coding: codingDraft(undefined),
    loop: loopDraft(undefined),
  };
}

/** The output a new playbook of `role` must declare (correlation and PR description roles). */
function fixedOutputSchema(role: PlaybookRole): JsonSchema | undefined {
  if (role === "correlation") return CORRELATION_OUTPUT_SCHEMA;
  if (role === "pr-description") return PR_DESCRIPTION_OUTPUT_SCHEMA;
  return undefined;
}

const WHOLE_NUMBER = /^\d+$/;

/** Whether `text` is a whole number from `min` to `max`. */
function inRange(text: string, min: number, max: number): boolean {
  return WHOLE_NUMBER.test(text) && Number(text) >= min && Number(text) <= max;
}

/** Story loop settings: the field, and its bounds (as `CODING_FIELDS` has them). */
const STORY_LOOP_FIELDS = [
  ["maxAttemptsPerStory", 20],
  ["maxRoundsPerStory", 100],
  ["stallRounds", 100],
  ["maxAuditRounds", MAX_AUDIT_ROUNDS],
] as const;

/** Errors the editor finds before sending anything, by the same field paths as the server's. */
export function draftErrors(draft: PlaybookDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  const { limited, tokens } = draft.tokenLimit;
  if (!isReviewRole(draft.role) && limited && !(WHOLE_NUMBER.test(tokens) && Number(tokens) > 0)) {
    errors.tokenBudget = 'Enter a number of tokens, or choose "No limit".';
  }
  const timeout = draft.coding.unmergedBranchTimeoutMinutes;
  if (isCodingRole(draft.role) && !(WHOLE_NUMBER.test(timeout) && Number(timeout) > 0)) {
    errors["coding.unmergedBranchTimeoutMinutes"] = "Enter a number of minutes.";
  }
  if (isCodingRole(draft.role) && showsLoopSettings(draft.role)) {
    for (const [field, max] of STORY_LOOP_FIELDS) {
      if (!inRange(draft.coding[field], 1, max)) {
        errors[`coding.${field}`] = `Enter a number from 1 to ${max}.`;
      }
    }
  }
  if (roleHasLoopSettings(draft.role)) {
    if (!inRange(draft.loop.maxIterations, 1, MAX_LOOP_ITERATIONS)) {
      errors["loop.maxIterations"] = `Enter a number from 1 to ${MAX_LOOP_ITERATIONS}.`;
    }
    if (!inRange(draft.loop.stallRounds, 1, MAX_LOOP_STALL_ROUNDS)) {
      errors["loop.stallRounds"] = `Enter a number from 1 to ${MAX_LOOP_STALL_ROUNDS}.`;
    }
  }
  return errors;
}

/**
 * The playbook `draft` saves: the fields it started from with the edited ones over them.
 * Review roles set no model or budget of their own only when the editor hides those; a
 * coding playbook's unedited coding settings stay as they were (but a task verifier and an
 * epic audit, which only a story playbook has). Only a looped non-coding role keeps a loop block.
 */
export function draftToInput(draft: PlaybookDraft): Record<string, unknown> {
  const {
    id: _id,
    coding: baseCoding,
    loop: baseLoop,
    outputSchema,
    ...base
  } = draft.base as {
    id?: unknown;
    coding?: Record<string, unknown>;
    loop?: Record<string, unknown>;
    outputSchema?: JsonSchema;
  } & Record<string, unknown>;
  const input: Record<string, unknown> = {
    ...base,
    name: draft.name,
    description: draft.description,
    role: draft.role,
    systemPrompt: draft.systemPrompt,
    systemPromptMode: draft.systemPromptMode,
    promptTemplate: draft.promptTemplate,
    referenceDocs: draft.referenceDocs.map(({ name, content }) => ({ name, content })),
    model: draft.model,
    fallbackModel: draft.fallbackModel,
    tokenBudget:
      isReviewRole(draft.role) || !draft.tokenLimit.limited
        ? null
        : { tokens: Number(draft.tokenLimit.tokens) },
    tools: draft.tools,
    toolSettings: draft.toolSettings,
    requires: draft.requires,
    setupCommands: draft.setupCommands.map(({ name, command, rest }) => ({
      ...rest,
      name,
      command,
    })),
    teardownCommands: draft.teardownCommands.map(({ name, command, rest }) => ({
      ...rest,
      name,
      command,
    })),
  };
  const schema = outputSchema ?? fixedOutputSchema(draft.role);
  if (schema !== undefined) input.outputSchema = schema;
  if (isCodingRole(draft.role)) {
    const { coding } = draft;
    const {
      verifierPlaybookId: _verifier,
      auditPlaybookId: _audit,
      maxAuditRounds: _auditRounds,
      ...keptCoding
    } = baseCoding ?? {};
    input.coding = {
      ...keptCoding,
      worktreeSetupCommand: coding.worktreeSetupCommand.trim() || null,
      runPrdQualityGates: coding.runPrdQualityGates,
      allowPreparation: coding.allowPreparation,
      epicCompletedState: coding.epicCompletedState,
      cleanupMergedWorktrees: coding.cleanupMergedWorktrees,
      unmergedBranchTimeoutMinutes: Number(coding.unmergedBranchTimeoutMinutes),
      prDescriptionPlaybookId: coding.prDescriptionPlaybookId,
      ...(showsLoopSettings(draft.role)
        ? {
            maxAttemptsPerStory: Number(coding.maxAttemptsPerStory),
            maxRoundsPerStory: Number(coding.maxRoundsPerStory),
            stallRounds: Number(coding.stallRounds),
            verifierPlaybookId: coding.verifierPlaybookId,
            auditPlaybookId: coding.auditPlaybookId,
            maxAuditRounds: Number(coding.maxAuditRounds),
          }
        : {}),
    };
  }
  if (roleHasLoopSettings(draft.role)) {
    const { verifierPlaybookId: _verifier, ...keptLoop } = baseLoop ?? {};
    input.loop = {
      ...keptLoop,
      ...(draft.loop.verifierPlaybookId
        ? { verifierPlaybookId: draft.loop.verifierPlaybookId }
        : {}),
      maxIterations: Number(draft.loop.maxIterations),
      stallRounds: Number(draft.loop.stallRounds),
    };
  }
  return input;
}

/** Why `value` can't be a required package, or null. */
export function packageError(value: string): string | null {
  return InstallablePackageName.safeParse(value).success ? null : "Enter an npm package name.";
}

/** Why `value` can't be a required host tool, or null. */
export function hostToolError(value: string): string | null {
  return HostToolName.safeParse(value).success
    ? null
    : "Use lowercase letters, digits, dots, dashes and underscores.";
}

/**
 * The error of the field at `path`: its own, else the first one under it (`setupCommands`
 * takes `setupCommands.1.name`).
 */
export function errorAt(errors: Record<string, string>, path: string): string | undefined {
  if (errors[path] !== undefined) return errors[path];
  const nested = Object.keys(errors).find((key) => key.startsWith(`${path}.`));
  return nested === undefined ? undefined : errors[nested];
}

/** The field paths the editor shows an error next to, for a playbook of `role`. */
export function shownFields(role: PlaybookRole): string[] {
  return [
    "name",
    "description",
    "role",
    "systemPrompt",
    "systemPromptMode",
    "promptTemplate",
    "referenceDocs",
    "model",
    "fallbackModel",
    ...(isReviewRole(role) ? [] : ["tokenBudget"]),
    "tools.builtin",
    "tools.agent",
    "tools.tracker",
    "tools.mcpServers",
    "toolSettings",
    "requires.installables",
    "requires.hostTools",
    "setupCommands",
    "teardownCommands",
    ...(isCodingRole(role)
      ? [
          "coding.worktreeSetupCommand",
          "coding.runPrdQualityGates",
          "coding.allowPreparation",
          "coding.epicCompletedState",
          "coding.cleanupMergedWorktrees",
          "coding.unmergedBranchTimeoutMinutes",
          "coding.prDescriptionPlaybookId",
          ...(showsLoopSettings(role)
            ? [
                "coding.maxAttemptsPerStory",
                "coding.maxRoundsPerStory",
                "coding.stallRounds",
                "coding.verifierPlaybookId",
                "coding.auditPlaybookId",
                "coding.maxAuditRounds",
              ]
            : []),
        ]
      : []),
    ...(roleHasLoopSettings(role)
      ? ["loop.verifierPlaybookId", "loop.maxIterations", "loop.stallRounds"]
      : []),
  ];
}

/** The errors no field of the editor shows (e.g. an output schema), to list above the form. */
export function unplacedErrors(errors: Record<string, string>, role: PlaybookRole): string[] {
  const fields = shownFields(role);
  return [
    ...new Set(
      Object.entries(errors)
        .filter(([key]) => !fields.some((field) => key === field || key.startsWith(`${field}.`)))
        .map(([, message]) => message),
    ),
  ];
}
