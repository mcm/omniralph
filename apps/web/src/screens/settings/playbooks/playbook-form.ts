import {
  AGENT_TOOLS_BY_TASK_TYPE,
  CODING_DEFAULTS,
  CORRELATION_OUTPUT_SCHEMA,
  DEFAULT_PR_DESCRIPTION_TASK_ID,
  HostToolName,
  InstallablePackageName,
  PR_DESCRIPTION_OUTPUT_SCHEMA,
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

/** A verify command row. */
export interface VerifyCommandDraft {
  key: string;
  command: string;
}

export interface CodingDraft {
  verifyCommands: VerifyCommandDraft[];
  worktreeSetupCommand: string;
  runPrdQualityGates: boolean;
  allowPreparation: boolean;
  /** `started`, `completed` or a state name; null leaves the epic as it is. */
  epicCompletedState: string | null;
  cleanupMergedWorktrees: boolean;
  unmergedBranchTimeoutMinutes: string;
  prDescriptionPlaybookId: string;
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
  tools: { builtin: string[]; agent: string[]; linear: string[]; mcpServers: string[] };
  toolSettings: { shell: boolean; linearRead: boolean; network: boolean };
  requires: { installables: string[]; hostTools: string[] };
  setupCommands: CommandDraft[];
  teardownCommands: CommandDraft[];
  coding: CodingDraft;
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
    verifyCommands: (set.verifyCommands ?? CODING_DEFAULTS.verifyCommands).map((command) => ({
      key: rowKey(),
      command,
    })),
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
      linear: [...playbook.tools.linear],
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
    tools: { builtin: [], agent: [], linear: [], mcpServers: [] },
    toolSettings: { shell: false, linearRead: false, network: false },
    requires: { installables: [], hostTools: [] },
    setupCommands: [],
    teardownCommands: [],
    coding: codingDraft(undefined),
  };
}

/** The output a new playbook of `role` must declare (correlation and PR description roles). */
function fixedOutputSchema(role: PlaybookRole): JsonSchema | undefined {
  if (role === "correlation") return CORRELATION_OUTPUT_SCHEMA;
  if (role === "pr-description") return PR_DESCRIPTION_OUTPUT_SCHEMA;
  return undefined;
}

const WHOLE_NUMBER = /^\d+$/;

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
  return errors;
}

/**
 * The playbook `draft` saves: the fields it started from with the edited ones over them.
 * Review roles set no model or budget of their own only when the editor hides those; a
 * coding playbook's unedited coding settings stay as they were.
 */
export function draftToInput(draft: PlaybookDraft): Record<string, unknown> {
  const {
    id: _id,
    coding: baseCoding,
    outputSchema,
    ...base
  } = draft.base as {
    id?: unknown;
    coding?: Record<string, unknown>;
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
    input.coding = {
      ...baseCoding,
      verifyCommands: coding.verifyCommands.map((row) => row.command),
      worktreeSetupCommand: coding.worktreeSetupCommand.trim() || null,
      runPrdQualityGates: coding.runPrdQualityGates,
      allowPreparation: coding.allowPreparation,
      epicCompletedState: coding.epicCompletedState,
      cleanupMergedWorktrees: coding.cleanupMergedWorktrees,
      unmergedBranchTimeoutMinutes: Number(coding.unmergedBranchTimeoutMinutes),
      prDescriptionPlaybookId: coding.prDescriptionPlaybookId,
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
    "tools.linear",
    "tools.mcpServers",
    "toolSettings",
    "requires.installables",
    "requires.hostTools",
    "setupCommands",
    "teardownCommands",
    ...(isCodingRole(role)
      ? [
          "coding.verifyCommands",
          "coding.worktreeSetupCommand",
          "coding.runPrdQualityGates",
          "coding.allowPreparation",
          "coding.epicCompletedState",
          "coding.cleanupMergedWorktrees",
          "coding.unmergedBranchTimeoutMinutes",
          "coding.prDescriptionPlaybookId",
        ]
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
