"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Muted,
  NativeSelect,
  Textarea,
} from "@iamthemcmaster/ui";
import { IconDeviceFloppy } from "@tabler/icons-react";
import {
  CODING_FIELD_NAMES,
  TASK_TYPES,
  TRIGGERS_BY_TASK_TYPE,
  type PoolName,
  type SinkKind,
  type TaskDefinition,
  type TaskType,
  type TokenBudget,
  type ToolSettings,
  type TriggerKind,
} from "@omniralph/tasks";
import type { FieldErrors } from "@omniralph/shared";
import type { TaskChoice } from "@/lib/definitions";
import { AppHeader } from "@/components/app-header";
import { useAction } from "@/components/use-action";
import { pageMain, pageTitle } from "../agents/agent-parts";
import { Choices, errorFor, monoInput, splitNames } from "../agents/form-parts";
import { createTaskDefinition, updateTaskDefinition, type TaskDefinitionFields } from "./actions";
import {
  codingDraft,
  codingFields,
  CodingFields,
  commandDraft,
  CommandsEditor,
  parseOutputSchema,
  setupCommand,
  teardownCommand,
  ToolSettingsFields,
} from "./task-form-sections";
import { TASK_TYPE_LABELS, taskHref } from "./task-parts";

/** An agent the form can pick. */
export interface TaskFormAgent {
  id: string;
  name: string;
  taskTypes: readonly TaskType[];
  builtin: boolean;
}

/** A sink the form can pick: the kinds the control panel implements, by task type. */
export interface TaskFormSink {
  kind: SinkKind;
  taskType: TaskType;
}

export interface TaskFormProps {
  /** The task being edited, or null to create one. */
  task: TaskDefinition | null;
  /** The organization's agents (built-in and custom). */
  agents: TaskFormAgent[];
  sinks: TaskFormSink[];
  /** The organization's pools a task may run in. */
  pools: PoolName[];
  /** The tasks a coding task may name for its PR description (`PR_DESCRIPTION_TASKS`). */
  prDescriptionTasks: TaskChoice[];
  /** Field errors to show from the start (component tests). */
  initialErrors?: FieldErrors;
}

type BudgetMode = "profile" | "tokens" | "profileFraction";

const stack = { display: "flex", flexDirection: "column", gap: "var(--space-4)" } as const;
const grid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "var(--space-4)",
} as const;

/** The pool a new task of `taskType` defaults to: coding runs are long. */
function defaultPool(taskType: TaskType, pools: readonly PoolName[]): PoolName | "" {
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

function tokenBudget(mode: BudgetMode, amount: string): TokenBudget {
  if (mode === "profile") return null;
  const value = Number(amount.trim() || Number.NaN);
  return mode === "tokens" ? { tokens: value } : { profileFraction: value / 100 };
}

/**
 * The settings of `task` this form doesn't edit (system text, variable
 * limits, turn and idle limits), kept as they are.
 */
function keptFields(task: TaskDefinition | null): Partial<TaskDefinition> {
  if (!task) return {};
  const { id: _id, ...kept }: Partial<TaskDefinition> = { ...task };
  delete kept.outputSchema;
  for (const field of CODING_FIELD_NAMES) delete kept[field];
  return kept;
}

/** The setup variables the template may use, by the commands' names. */
function setupHint(commands: readonly { name: string }[]): string | undefined {
  const names = commands.map((command) => command.name.trim()).filter(Boolean);
  if (names.length === 0) return undefined;
  return `Setup variables: ${names.map((name) => `{{setup.${name}}}`).join(", ")}.`;
}

function schemaText(schema: TaskDefinition["outputSchema"]): string {
  return schema === undefined ? "" : JSON.stringify(schema, null, 2);
}

/** The form creating a task, or editing one of the organization's (common fields). */
export function TaskForm({
  task,
  agents,
  sinks,
  pools,
  prDescriptionTasks,
  initialErrors = {},
}: TaskFormProps) {
  const router = useRouter();
  const { pending, run } = useAction();
  const [name, setName] = React.useState(task?.name ?? "");
  const [description, setDescription] = React.useState(task?.description ?? "");
  const [taskType, setTaskType] = React.useState<TaskType>(task?.taskType ?? "query");
  const [agentId, setAgentId] = React.useState(task?.agentId ?? "");
  const [triggers, setTriggers] = React.useState<TriggerKind[]>(task?.triggers ?? []);
  const [promptTemplate, setPromptTemplate] = React.useState(task?.promptTemplate ?? "");
  const [sink, setSink] = React.useState<SinkKind | "">(task?.sink ?? "");
  const [pool, setPool] = React.useState<PoolName | "">(task?.pool ?? defaultPool(taskType, pools));
  const [model, setModel] = React.useState(task?.model ?? "");
  const [budgetModeValue, setBudgetMode] = React.useState(budgetMode(task?.tokenBudget));
  const [budgetAmountValue, setBudgetAmount] = React.useState(budgetAmount(task?.tokenBudget));
  const [setupCommands, setSetupCommands] = React.useState(
    (task?.setupCommands ?? []).map(commandDraft),
  );
  const [teardownCommands, setTeardownCommands] = React.useState(
    (task?.teardownCommands ?? []).map(commandDraft),
  );
  const [toolSettings, setToolSettings] = React.useState<ToolSettings>(
    task?.toolSettings ?? { shell: false, linearRead: false, network: false },
  );
  const [requiredInstallables, setRequiredInstallables] = React.useState(
    task?.requires?.installables.join(", ") ?? "",
  );
  const [requiredHostTools, setRequiredHostTools] = React.useState(
    task?.requires?.hostTools.join(", ") ?? "",
  );
  const [outputSchema, setOutputSchema] = React.useState(schemaText(task?.outputSchema));
  const [coding, setCoding] = React.useState(codingDraft(task));
  const [errors, setErrors] = React.useState<FieldErrors>(initialErrors);

  const typeAgents = agents.filter((agent) => agent.taskTypes.includes(taskType));
  const typeSinks = sinks.filter((option) => option.taskType === taskType);
  const typeTriggers = TRIGGERS_BY_TASK_TYPE[taskType];

  /** A new type drops the choices it doesn't accept. */
  const changeTaskType = (next: TaskType) => {
    setTaskType(next);
    setTriggers((current) =>
      current.filter((trigger) => TRIGGERS_BY_TASK_TYPE[next].includes(trigger)),
    );
    if (!agents.some((agent) => agent.id === agentId && agent.taskTypes.includes(next))) {
      setAgentId("");
    }
    if (!sinks.some((option) => option.kind === sink && option.taskType === next)) setSink("");
    if (!task) setPool(defaultPool(next, pools));
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const schema = taskType === "query" ? parseOutputSchema(outputSchema) : {};
    if ("error" in schema) {
      setErrors({ outputSchema: schema.error });
      return;
    }
    const input = {
      ...keptFields(task),
      name,
      description,
      taskType,
      agentId,
      triggers,
      promptTemplate,
      sink,
      pool,
      model: model.trim() || undefined,
      tokenBudget: tokenBudget(budgetModeValue, budgetAmountValue),
      setupCommands: setupCommands.map(setupCommand),
      teardownCommands: teardownCommands.map(teardownCommand),
      // Shell is a query task setting: other types keep what they have.
      toolSettings: {
        ...toolSettings,
        shell: taskType === "query" ? toolSettings.shell : (task?.toolSettings.shell ?? false),
      },
      requires: {
        installables: splitNames(requiredInstallables),
        hostTools: splitNames(requiredHostTools),
      },
      ...(schema.schema && { outputSchema: schema.schema }),
      ...(taskType === "coding" && codingFields(coding)),
      // Unset choices fail validation with their field's error.
    } as TaskDefinitionFields;
    let savedId = task?.id;
    run(
      async () => {
        if (task) return updateTaskDefinition(task.id, input);
        const result = await createTaskDefinition(input);
        if (result.ok && "id" in result) savedId = result.id;
        return result;
      },
      task ? `${name} saved` : `${name} created`,
      () => {
        setErrors({});
        if (savedId) router.push(taskHref(savedId));
      },
      (result) => setErrors(result.fieldErrors ?? {}),
    );
  };

  const title = task ? `Edit ${task.name}` : "New task";
  const breadcrumbs = [
    { label: "Settings" },
    { label: "Tasks", href: "/settings/tasks" },
    ...(task ? [{ label: task.name, href: taskHref(task.id) }] : []),
    { label: task ? "Edit" : "New" },
  ];
  const budgetError = errorFor(errors, "tokenBudget");

  return (
    <>
      <AppHeader breadcrumbs={breadcrumbs} />
      <main style={pageMain}>
        <div>
          <h1 style={pageTitle}>{title}</h1>
          <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
            A task runs an agent with its prompt on the triggers it accepts and hands the output to
            its sink. Changes apply to the next run.
          </Muted>
        </div>
        <form onSubmit={save} noValidate style={{ ...stack, gap: "var(--space-6)" }}>
          {errors.form && <p style={{ margin: 0, color: "var(--danger-fg)" }}>{errors.form}</p>}
          <Card>
            <CardHeader>
              <CardTitle>Overview</CardTitle>
            </CardHeader>
            <CardContent style={stack}>
              <Field label="Name" htmlFor="task-name" error={errors.name} required>
                <Input
                  id="task-name"
                  disabled={pending}
                  error={Boolean(errors.name)}
                  aria-invalid={Boolean(errors.name)}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="Description" htmlFor="task-description" error={errors.description}>
                <Textarea
                  id="task-description"
                  rows={2}
                  disabled={pending}
                  aria-invalid={Boolean(errors.description)}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
              <div style={grid}>
                <Field
                  label="Task type"
                  htmlFor="task-type"
                  description="How the harness runs it."
                  error={errors.taskType}
                  required
                >
                  <NativeSelect
                    id="task-type"
                    disabled={pending}
                    aria-invalid={Boolean(errors.taskType)}
                    value={taskType}
                    onChange={(e) => changeTaskType(e.target.value as TaskType)}
                  >
                    {TASK_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {TASK_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field
                  label="Agent"
                  htmlFor="task-agent"
                  description="Agents suited to the task type."
                  error={errors.agentId}
                  required
                >
                  <NativeSelect
                    id="task-agent"
                    disabled={pending}
                    aria-invalid={Boolean(errors.agentId)}
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                  >
                    <option value="">Choose an agent</option>
                    {typeAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.builtin ? `${agent.name} (built-in)` : agent.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
              <Field
                label="Triggers"
                htmlFor="task-triggers"
                description="The events that may start it; the task type decides which it accepts."
                error={errorFor(errors, "triggers")}
                required
              >
                <Choices
                  id="task-triggers"
                  options={typeTriggers}
                  value={triggers}
                  onChange={setTriggers}
                  disabled={pending}
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Prompt template</CardTitle>
              <CardDescription>
                Rendered with the trigger&apos;s variables for each run: every variable it uses must
                be available for every trigger.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Field
                label="Template"
                htmlFor="task-prompt-template"
                description={setupHint(setupCommands)}
                error={errors.promptTemplate}
                required
              >
                <Textarea
                  id="task-prompt-template"
                  rows={16}
                  disabled={pending}
                  aria-invalid={Boolean(errors.promptTemplate)}
                  value={promptTemplate}
                  onChange={(e) => setPromptTemplate(e.target.value)}
                  style={monoInput}
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Setup commands</CardTitle>
              <CardDescription>
                Run in order in the working directory before the session. Each one&apos;s output is
                the template variable {"{{setup.<name>}}"}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CommandsEditor
                field="setupCommands"
                commands={setupCommands}
                onChange={setSetupCommands}
                errors={errors}
                disabled={pending}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Teardown commands</CardTitle>
              <CardDescription>
                Run in order after the session, whatever happened; their output is logged and a
                failure never fails the run.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CommandsEditor
                field="teardownCommands"
                commands={teardownCommands}
                onChange={setTeardownCommands}
                errors={errors}
                disabled={pending}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tool settings</CardTitle>
              <CardDescription>Narrow the agent&apos;s tools for this task.</CardDescription>
            </CardHeader>
            <CardContent>
              <ToolSettingsFields
                value={toolSettings}
                onChange={setToolSettings}
                query={taskType === "query"}
                errors={errors}
                disabled={pending}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Requirements</CardTitle>
              <CardDescription>
                Only harnesses that have these claim the task&apos;s runs (besides the installables
                of MCP servers its agent lists).
              </CardDescription>
            </CardHeader>
            <CardContent style={stack}>
              <Field
                label="Installables"
                htmlFor="task-requires-installables"
                description="Comma-separated npm package names, e.g. @omniralph/code-graph."
                error={errorFor(errors, "requires.installables")}
              >
                <Input
                  id="task-requires-installables"
                  disabled={pending}
                  error={Boolean(errorFor(errors, "requires.installables"))}
                  aria-invalid={Boolean(errorFor(errors, "requires.installables"))}
                  value={requiredInstallables}
                  onChange={(e) => setRequiredInstallables(e.target.value)}
                  style={monoInput}
                />
              </Field>
              <Field
                label="Host tools"
                htmlFor="task-requires-host-tools"
                description="Comma-separated names from Settings › Harnesses › Host tools, e.g. opengrep."
                error={errorFor(errors, "requires.hostTools")}
              >
                <Input
                  id="task-requires-host-tools"
                  disabled={pending}
                  error={Boolean(errorFor(errors, "requires.hostTools"))}
                  aria-invalid={Boolean(errorFor(errors, "requires.hostTools"))}
                  value={requiredHostTools}
                  onChange={(e) => setRequiredHostTools(e.target.value)}
                  style={monoInput}
                />
              </Field>
            </CardContent>
          </Card>

          {taskType === "query" && (
            <Card>
              <CardHeader>
                <CardTitle>Output schema</CardTitle>
                <CardDescription>
                  A JSON schema (an object) the run&apos;s structured output must match. Empty for a
                  Markdown answer.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Field
                  label="Schema"
                  htmlFor="task-output-schema"
                  error={errorFor(errors, "outputSchema")}
                >
                  <Textarea
                    id="task-output-schema"
                    rows={10}
                    disabled={pending}
                    aria-invalid={Boolean(errorFor(errors, "outputSchema"))}
                    value={outputSchema}
                    onChange={(e) => setOutputSchema(e.target.value)}
                    style={monoInput}
                  />
                </Field>
              </CardContent>
            </Card>
          )}

          {taskType === "coding" && (
            <Card>
              <CardHeader>
                <CardTitle>Coding</CardTitle>
                <CardDescription>
                  How the run publishes its work and how far it may go.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <CodingFields
                  value={coding}
                  onChange={setCoding}
                  prDescriptionTasks={prDescriptionTasks}
                  errors={errors}
                  disabled={pending}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Running</CardTitle>
              <CardDescription>Where the output goes and what a run may use.</CardDescription>
            </CardHeader>
            <CardContent style={grid}>
              <Field
                label="Sink"
                htmlFor="task-sink"
                description="What applies the run's output."
                error={errors.sink}
                required
              >
                <NativeSelect
                  id="task-sink"
                  disabled={pending}
                  aria-invalid={Boolean(errors.sink)}
                  value={sink}
                  onChange={(e) => setSink(e.target.value as SinkKind)}
                >
                  <option value="">Choose a sink</option>
                  {typeSinks.map((option) => (
                    <option key={option.kind} value={option.kind}>
                      {option.kind}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field
                label="Pool"
                htmlFor="task-pool"
                description="Whose concurrency slots its runs take."
                error={errors.pool}
                required
              >
                <NativeSelect
                  id="task-pool"
                  disabled={pending}
                  aria-invalid={Boolean(errors.pool)}
                  value={pool}
                  onChange={(e) => setPool(e.target.value as PoolName)}
                >
                  {pool === "" && <option value="">Choose a pool</option>}
                  {pools.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field
                label="Model override"
                htmlFor="task-model"
                description="Claude model ID. Empty uses the agent's model."
                error={errors.model}
              >
                <Input
                  id="task-model"
                  disabled={pending}
                  error={Boolean(errors.model)}
                  aria-invalid={Boolean(errors.model)}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  style={monoInput}
                />
              </Field>
              <Field label="Token budget" htmlFor="task-token-budget" error={budgetError}>
                <div style={{ display: "flex", gap: "var(--space-2)" }}>
                  <NativeSelect
                    id="task-token-budget"
                    disabled={pending}
                    aria-invalid={Boolean(budgetError)}
                    value={budgetModeValue}
                    onChange={(e) => setBudgetMode(e.target.value as BudgetMode)}
                  >
                    <option value="profile">Profile budget</option>
                    <option value="tokens">Tokens</option>
                    <option value="profileFraction">% of the profile budget</option>
                  </NativeSelect>
                  {budgetModeValue !== "profile" && (
                    <Input
                      id="task-token-budget-amount"
                      aria-label={budgetModeValue === "tokens" ? "Tokens" : "Percent"}
                      type="number"
                      min={1}
                      max={budgetModeValue === "tokens" ? undefined : 100}
                      disabled={pending}
                      error={Boolean(budgetError)}
                      aria-invalid={Boolean(budgetError)}
                      value={budgetAmountValue}
                      onChange={(e) => setBudgetAmount(e.target.value)}
                    />
                  )}
                </div>
              </Field>
            </CardContent>
          </Card>

          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button type="submit" variant="primary" disabled={pending}>
              <IconDeviceFloppy size={14} />
              {pending ? "Saving…" : task ? "Save task" : "Create task"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => router.push(task ? taskHref(task.id) : "/settings/tasks")}
            >
              Cancel
            </Button>
          </div>
        </form>
      </main>
    </>
  );
}
