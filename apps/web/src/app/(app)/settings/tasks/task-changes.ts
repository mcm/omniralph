/**
 * The task form's draft (what its inputs hold) and its unsaved changes: the
 * "old → new" list an edit confirms. Pure, so the change list can be tested.
 */
import type {
  SinkKind,
  TaskDefinition,
  TaskType,
  TokenBudget,
  ToolSettings,
  TriggerKind,
} from "@omniralph/tasks";
import {
  formatSettingValue,
  settingChanges,
  type SettingChange,
  type SettingSpec,
  type SettingValue,
} from "@/lib/settings/changes";
import {
  codingDraft,
  commandDraft,
  DRAFT_PULL_REQUEST_LABELS,
  LIMIT_DEFAULTS,
  LIMITS,
  PUSH_TIMING_LABELS,
  type CodingDraft,
  type CommandDraft,
} from "./task-form-sections";
import { TASK_TYPE_LABELS } from "./task-parts";

/** A fixed number of tokens, or "No limit" (a null budget). */
export type BudgetMode = "none" | "tokens";

/** Everything the task form edits, as typed. */
export interface TaskDraft {
  name: string;
  description: string;
  taskType: TaskType;
  agentId: string;
  triggers: TriggerKind[];
  promptTemplate: string;
  sink: SinkKind | "";
  model: string;
  budgetMode: BudgetMode;
  budgetAmount: string;
  setupCommands: CommandDraft[];
  teardownCommands: CommandDraft[];
  toolSettings: ToolSettings;
  requiredInstallables: string[];
  requiredHostTools: string[];
  outputSchema: string;
  coding: CodingDraft;
}

function budgetMode(budget: TokenBudget | undefined): BudgetMode {
  return budget ? "tokens" : "none";
}

function budgetAmount(budget: TokenBudget | undefined): string {
  if (!budget) return "";
  return String(budget.tokens);
}

/** The draft of `task`, or of a new task when null. */
export function taskDraft(task: TaskDefinition | null): TaskDraft {
  const taskType = task?.taskType ?? "query";
  return {
    name: task?.name ?? "",
    description: task?.description ?? "",
    taskType,
    agentId: task?.agentId ?? "",
    triggers: task?.triggers ?? [],
    promptTemplate: task?.promptTemplate ?? "",
    sink: task?.sink ?? "",
    model: task?.model ?? "",
    budgetMode: budgetMode(task?.tokenBudget),
    budgetAmount: budgetAmount(task?.tokenBudget),
    setupCommands: (task?.setupCommands ?? []).map(commandDraft),
    teardownCommands: (task?.teardownCommands ?? []).map(commandDraft),
    toolSettings: task?.toolSettings ?? { shell: false, linearRead: false, network: false },
    requiredInstallables: task?.requires?.installables ?? [],
    requiredHostTools: task?.requires?.hostTools ?? [],
    outputSchema:
      task?.outputSchema === undefined ? "" : JSON.stringify(task.outputSchema, null, 2),
    coding: codingDraft(task),
  };
}

export function tokenBudget(mode: BudgetMode, amount: string): TokenBudget {
  if (mode === "none") return null;
  return { tokens: Number(amount.trim() || Number.NaN) };
}

/** The token budget as the form words it: "No limit" or "50,000 tokens". */
export function formatTokenBudget(budget: TokenBudget): string {
  if (!budget) return "No limit";
  return `${formatSettingValue(budget.tokens)} tokens`;
}

/** A command in one line: `name: command`, then what it sets beyond the defaults. */
function commandLine(command: CommandDraft, setup: boolean): string {
  const extras = [
    command.timeoutSeconds.trim() && `timeout ${command.timeoutSeconds.trim()}s`,
    command.maxOutputBytes.trim() && `output cap ${command.maxOutputBytes.trim()} bytes`,
    setup && command.fence.trim() && `fence ${command.fence.trim()}`,
    setup && command.optional && "optional",
  ].filter(Boolean);
  const line = `${command.name.trim()}: ${command.command.trim()}`;
  return extras.length > 0 ? `${line} (${extras.join(", ")})` : line;
}

/** Each line of a list on its own line (commands). */
const lines = (value: SettingValue): string =>
  Array.isArray(value) && value.length > 0 ? value.join("\n") : formatSettingValue(value);

/** Shows an ID by its name in `names`, or the ID itself when it has none. */
const byName =
  (names: ReadonlyMap<string, string>) =>
  (value: SettingValue): string =>
    typeof value === "string"
      ? (names.get(value) ?? formatSettingValue(value))
      : formatSettingValue(value);

/** A typed limit: the number, or the default when empty (unset when not a coding task). */
const limit =
  (fallback: number) =>
  (value: SettingValue): string =>
    value === "" ? `Default (${fallback})` : formatSettingValue(value);

/** The values the task form saves, compared to find its changes (unused sections are unset). */
export function taskValues(draft: TaskDraft): Record<string, SettingValue> {
  const coding = draft.taskType === "coding";
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    taskType: draft.taskType,
    agentId: draft.agentId,
    triggers: draft.triggers,
    promptTemplate: draft.promptTemplate,
    setupCommands: draft.setupCommands.map((command) => commandLine(command, true)),
    teardownCommands: draft.teardownCommands.map((command) => commandLine(command, false)),
    shell: draft.toolSettings.shell,
    linearRead: draft.toolSettings.linearRead,
    network: draft.toolSettings.network,
    requiredInstallables: draft.requiredInstallables,
    requiredHostTools: draft.requiredHostTools,
    outputSchema: draft.taskType === "query" ? draft.outputSchema.trim() : null,
    pushTiming: coding ? draft.coding.pushTiming : null,
    draftPullRequest: coding ? draft.coding.draftPullRequest : null,
    prDescriptionTaskId: coding ? draft.coding.prDescriptionTaskId : null,
    ...Object.fromEntries(
      LIMITS.map(([key]) => [key, coding ? draft.coding[key].trim() : null] as const),
    ),
    sink: draft.sink,
    model: draft.model.trim(),
    tokenBudget: formatTokenBudget(tokenBudget(draft.budgetMode, draft.budgetAmount)),
  };
}

/** The names the change list shows instead of IDs. */
export interface TaskChangeNames {
  agents: ReadonlyMap<string, string>;
  tasks: ReadonlyMap<string, string>;
}

/** The task form's settings in form order, with their labels and how they're shown. */
export function taskSpecs(names: TaskChangeNames): SettingSpec[] {
  const option =
    (labels: Readonly<Record<string, string>>, empty?: string) =>
    (value: SettingValue): string =>
      value === "" && empty ? empty : (labels[String(value)] ?? formatSettingValue(value));
  return [
    { key: "name", label: "Name" },
    { key: "description", label: "Description" },
    { key: "taskType", label: "Task type", format: option(TASK_TYPE_LABELS) },
    { key: "agentId", label: "Agent", format: byName(names.agents) },
    { key: "triggers", label: "Triggers" },
    { key: "promptTemplate", label: "Prompt template" },
    { key: "setupCommands", label: "Setup commands", format: lines },
    { key: "teardownCommands", label: "Teardown commands", format: lines },
    { key: "shell", label: "Shell (Bash)" },
    { key: "linearRead", label: "Linear read access" },
    { key: "network", label: "Network access" },
    { key: "requiredInstallables", label: "Required installables" },
    { key: "requiredHostTools", label: "Required host tools" },
    { key: "outputSchema", label: "Output schema" },
    { key: "pushTiming", label: "Push", format: option(PUSH_TIMING_LABELS) },
    {
      key: "draftPullRequest",
      label: "Draft PR",
      format: option(DRAFT_PULL_REQUEST_LABELS, "The repository's setting"),
    },
    { key: "prDescriptionTaskId", label: "PR description task", format: byName(names.tasks) },
    ...LIMITS.map(([key, label]) => ({
      key,
      label,
      format: limit(LIMIT_DEFAULTS[key]),
    })),
    { key: "sink", label: "Sink" },
    { key: "model", label: "Model override" },
    { key: "tokenBudget", label: "Token budget" },
  ];
}

/** What saving `draft` over `saved` changes, in form order. */
export function taskChanges(
  saved: TaskDraft,
  draft: TaskDraft,
  names: TaskChangeNames,
): SettingChange[] {
  return settingChanges(taskSpecs(names), taskValues(saved), taskValues(draft));
}
