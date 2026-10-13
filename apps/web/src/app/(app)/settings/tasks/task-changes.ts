/**
 * The task form's draft (what its inputs hold) and its unsaved changes: the
 * "old → new" list an edit confirms. Pure, so the change list can be tested.
 */
import type {
  PoolName,
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
import { splitNames } from "../agents/form-parts";
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

export type BudgetMode = "profile" | "tokens" | "profileFraction";

/** Everything the task form edits, as typed. */
export interface TaskDraft {
  name: string;
  description: string;
  taskType: TaskType;
  agentId: string;
  triggers: TriggerKind[];
  promptTemplate: string;
  sink: SinkKind | "";
  pool: PoolName | "";
  model: string;
  budgetMode: BudgetMode;
  budgetAmount: string;
  setupCommands: CommandDraft[];
  teardownCommands: CommandDraft[];
  toolSettings: ToolSettings;
  requiredInstallables: string;
  requiredHostTools: string;
  outputSchema: string;
  coding: CodingDraft;
}

/** The pool a new task of `taskType` defaults to: coding runs are long. */
export function defaultPool(taskType: TaskType, pools: readonly PoolName[]): PoolName | "" {
  const preferred = taskType === "coding" ? "long" : "short";
  return pools.includes(preferred) ? preferred : (pools[0] ?? "");
}

function budgetMode(budget: TokenBudget | undefined): BudgetMode {
  if (!budget) return "profile";
  return "tokens" in budget ? "tokens" : "profileFraction";
}

function budgetAmount(budget: TokenBudget | undefined): string {
  if (!budget) return "";
  return "tokens" in budget ? String(budget.tokens) : String(budget.profileFraction * 100);
}

/** The draft of `task`, or of a new task when null. */
export function taskDraft(task: TaskDefinition | null, pools: readonly PoolName[]): TaskDraft {
  const taskType = task?.taskType ?? "query";
  return {
    name: task?.name ?? "",
    description: task?.description ?? "",
    taskType,
    agentId: task?.agentId ?? "",
    triggers: task?.triggers ?? [],
    promptTemplate: task?.promptTemplate ?? "",
    sink: task?.sink ?? "",
    pool: task?.pool ?? defaultPool(taskType, pools),
    model: task?.model ?? "",
    budgetMode: budgetMode(task?.tokenBudget),
    budgetAmount: budgetAmount(task?.tokenBudget),
    setupCommands: (task?.setupCommands ?? []).map(commandDraft),
    teardownCommands: (task?.teardownCommands ?? []).map(commandDraft),
    toolSettings: task?.toolSettings ?? { shell: false, linearRead: false, network: false },
    requiredInstallables: task?.requires?.installables.join(", ") ?? "",
    requiredHostTools: task?.requires?.hostTools.join(", ") ?? "",
    outputSchema:
      task?.outputSchema === undefined ? "" : JSON.stringify(task.outputSchema, null, 2),
    coding: codingDraft(task),
  };
}

export function tokenBudget(mode: BudgetMode, amount: string): TokenBudget {
  if (mode === "profile") return null;
  const value = Number(amount.trim() || Number.NaN);
  return mode === "tokens" ? { tokens: value } : { profileFraction: value / 100 };
}

/** The token budget as the form words it: "Profile budget", "50,000 tokens", "40% of the profile budget". */
export function formatTokenBudget(budget: TokenBudget): string {
  if (!budget) return "Profile budget";
  if ("tokens" in budget) return `${formatSettingValue(budget.tokens)} tokens`;
  return `${formatSettingValue(budget.profileFraction * 100)}% of the profile budget`;
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
    requiredInstallables: splitNames(draft.requiredInstallables),
    requiredHostTools: splitNames(draft.requiredHostTools),
    outputSchema: draft.taskType === "query" ? draft.outputSchema.trim() : null,
    pushTiming: coding ? draft.coding.pushTiming : null,
    draftPullRequest: coding ? draft.coding.draftPullRequest : null,
    prDescriptionTaskId: coding ? draft.coding.prDescriptionTaskId : null,
    ...Object.fromEntries(
      LIMITS.map(([key]) => [key, coding ? draft.coding[key].trim() : null] as const),
    ),
    sink: draft.sink,
    pool: draft.pool,
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
    { key: "pool", label: "Pool" },
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
