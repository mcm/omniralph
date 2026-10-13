"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  NativeSelect,
  Stack,
  Textarea,
} from "@iamthemcmaster/ui";
import {
  CODING_FIELD_NAMES,
  TASK_TYPES,
  TRIGGERS_BY_TASK_TYPE,
  type PoolName,
  type SinkKind,
  type TaskDefinition,
  type TaskType,
} from "@omniralph/tasks";
import type { FieldErrors } from "@omniralph/shared";
import type { TaskChoice } from "@/lib/definitions";
import { AppHeader } from "@/components/app-header";
import { PageHeader } from "@/components/page-header";
import { ConfirmChangesDialog } from "@/components/settings-card";
import { useAction } from "@/components/use-action";
import { NOT_SET, withDefault } from "@/lib/settings/changes";
import { Choices, EditorActions, errorFor, splitNames } from "../agents/form-parts";
import { createTaskDefinition, updateTaskDefinition, type TaskDefinitionFields } from "./actions";
import {
  defaultPool,
  taskChanges,
  taskDraft,
  tokenBudget,
  type BudgetMode,
  type TaskDraft,
} from "./task-changes";
import {
  codingFields,
  CodingFields,
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
  const [saved, setSaved] = React.useState(() => taskDraft(task, pools));
  const [draft, setDraft] = React.useState(saved);
  const [errors, setErrors] = React.useState<FieldErrors>(initialErrors);
  const [confirming, setConfirming] = React.useState(false);
  const set = (change: Partial<TaskDraft>) => setDraft((current) => ({ ...current, ...change }));
  const { taskType, toolSettings } = draft;
  const names = {
    agents: new Map(agents.map((agent) => [agent.id, agent.name])),
    tasks: new Map(prDescriptionTasks.map((choice) => [choice.id, choice.name])),
  };
  const changes = taskChanges(saved, draft, names);
  const dirty = changes.length > 0;

  const typeAgents = agents.filter((agent) => agent.taskTypes.includes(taskType));
  const typeSinks = sinks.filter((option) => option.taskType === taskType);
  const typeTriggers = TRIGGERS_BY_TASK_TYPE[taskType];

  /** A new type drops the choices it doesn't accept. */
  const changeTaskType = (next: TaskType) =>
    setDraft((current) => ({
      ...current,
      taskType: next,
      triggers: current.triggers.filter((trigger) => TRIGGERS_BY_TASK_TYPE[next].includes(trigger)),
      agentId: agents.some(
        (agent) => agent.id === current.agentId && agent.taskTypes.includes(next),
      )
        ? current.agentId
        : "",
      sink: sinks.some((option) => option.kind === current.sink && option.taskType === next)
        ? current.sink
        : "",
      pool: task ? current.pool : defaultPool(next, pools),
      // Shell is a query task setting: other types keep the saved one.
      toolSettings:
        next === "query"
          ? current.toolSettings
          : { ...current.toolSettings, shell: saved.toolSettings.shell },
    }));

  const save = () => {
    const schema = taskType === "query" ? parseOutputSchema(draft.outputSchema) : {};
    if ("error" in schema) {
      setErrors({ outputSchema: schema.error });
      return;
    }
    const input = {
      ...keptFields(task),
      name: draft.name,
      description: draft.description,
      taskType,
      agentId: draft.agentId,
      triggers: draft.triggers,
      promptTemplate: draft.promptTemplate,
      sink: draft.sink,
      pool: draft.pool,
      model: draft.model.trim() || undefined,
      tokenBudget: tokenBudget(draft.budgetMode, draft.budgetAmount),
      setupCommands: draft.setupCommands.map(setupCommand),
      teardownCommands: draft.teardownCommands.map(teardownCommand),
      // Shell is a query task setting: other types keep what they have.
      toolSettings: {
        ...toolSettings,
        shell: taskType === "query" ? toolSettings.shell : (task?.toolSettings.shell ?? false),
      },
      requires: {
        installables: splitNames(draft.requiredInstallables),
        hostTools: splitNames(draft.requiredHostTools),
      },
      ...(schema.schema && { outputSchema: schema.schema }),
      ...(taskType === "coding" && codingFields(draft.coding)),
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
      task ? `${draft.name} saved` : `${draft.name} created`,
      () => {
        setErrors({});
        setSaved(draft);
        if (savedId) router.push(taskHref(savedId));
      },
      (result) => setErrors(result.fieldErrors ?? {}),
    );
  };

  /** An edit confirms its change list first; a new task saves straight away. */
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (!task) save();
    else if (dirty) setConfirming(true);
  };

  const discard = () => {
    setDraft(saved);
    setErrors({});
  };

  const title = task ? `Edit ${task.name}` : "New task";
  const breadcrumbs = [
    { label: "Tasks", href: "/settings/tasks" },
    ...(task ? [{ label: task.name, href: taskHref(task.id) }] : []),
    { label: task ? "Edit" : "New" },
  ];
  const budgetError = errorFor(errors, "tokenBudget");

  return (
    <>
      <AppHeader breadcrumbs={breadcrumbs} />
      <main className="detail-main">
        <PageHeader
          title={title}
          description="A task runs an agent with its prompt on the triggers it accepts and hands the output to its sink. Changes apply to the next run."
        />
        <Stack gap={6} asChild>
          <form onSubmit={submit} noValidate>
            {errors.form && <p className="m-0 text-danger-fg">{errors.form}</p>}
            <Card>
              <CardHeader>
                <CardTitle as="h2">Overview</CardTitle>
              </CardHeader>
              <CardContent className="settings-card-content">
                <Field label="Name" htmlFor="task-name" error={errors.name} required>
                  <Input
                    id="task-name"
                    disabled={pending}
                    error={Boolean(errors.name)}
                    aria-invalid={Boolean(errors.name)}
                    value={draft.name}
                    onChange={(e) => set({ name: e.target.value })}
                  />
                </Field>
                <Field label="Description" htmlFor="task-description" error={errors.description}>
                  <Textarea
                    id="task-description"
                    rows={2}
                    disabled={pending}
                    aria-invalid={Boolean(errors.description)}
                    value={draft.description}
                    onChange={(e) => set({ description: e.target.value })}
                  />
                </Field>
                <div className="definition-grid-wide">
                  <Field
                    label="Task type"
                    htmlFor="task-type"
                    description={withDefault("How the harness runs it.", TASK_TYPE_LABELS.query)}
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
                      value={draft.agentId}
                      onChange={(e) => set({ agentId: e.target.value })}
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
                    value={draft.triggers}
                    onChange={(triggers) => set({ triggers })}
                    disabled={pending}
                  />
                </Field>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle as="h2">Prompt template</CardTitle>
                <CardDescription>
                  Rendered with the trigger&apos;s variables for each run: every variable it uses
                  must be available for every trigger.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Field
                  label="Template"
                  htmlFor="task-prompt-template"
                  description={[
                    "Rendered with the trigger's variables.",
                    setupHint(draft.setupCommands),
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  error={errors.promptTemplate}
                  required
                >
                  <Textarea
                    id="task-prompt-template"
                    rows={16}
                    disabled={pending}
                    aria-invalid={Boolean(errors.promptTemplate)}
                    value={draft.promptTemplate}
                    onChange={(e) => set({ promptTemplate: e.target.value })}
                    className="settings-mono"
                  />
                </Field>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle as="h2">Setup commands</CardTitle>
                <CardDescription>
                  Run in order in the working directory before the session. Each one&apos;s output
                  is the template variable {"{{setup.<name>}}"}.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <CommandsEditor
                  field="setupCommands"
                  commands={draft.setupCommands}
                  onChange={(setupCommands) => set({ setupCommands })}
                  errors={errors}
                  disabled={pending}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle as="h2">Teardown commands</CardTitle>
                <CardDescription>
                  Run in order after the session, whatever happened; their output is logged and a
                  failure never fails the run.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <CommandsEditor
                  field="teardownCommands"
                  commands={draft.teardownCommands}
                  onChange={(teardownCommands) => set({ teardownCommands })}
                  errors={errors}
                  disabled={pending}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle as="h2">Tool settings</CardTitle>
                <CardDescription>
                  {withDefault("Narrow the agent's tools for this task.", "all off")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ToolSettingsFields
                  value={toolSettings}
                  onChange={(next) => set({ toolSettings: next })}
                  query={taskType === "query"}
                  errors={errors}
                  disabled={pending}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle as="h2">Requirements</CardTitle>
                <CardDescription>
                  Only harnesses that have these claim the task&apos;s runs (besides the
                  installables of MCP servers its agent lists).
                </CardDescription>
              </CardHeader>
              <CardContent className="settings-card-content">
                <Field
                  label="Installables"
                  htmlFor="task-requires-installables"
                  description={withDefault(
                    "Comma-separated npm package names, e.g. @omniralph/code-graph.",
                  )}
                  error={errorFor(errors, "requires.installables")}
                >
                  <Input
                    id="task-requires-installables"
                    disabled={pending}
                    error={Boolean(errorFor(errors, "requires.installables"))}
                    aria-invalid={Boolean(errorFor(errors, "requires.installables"))}
                    value={draft.requiredInstallables}
                    onChange={(e) => set({ requiredInstallables: e.target.value })}
                    className="settings-mono"
                  />
                </Field>
                <Field
                  label="Host tools"
                  htmlFor="task-requires-host-tools"
                  description={withDefault(
                    "Comma-separated names from Settings › Harness defaults › Host tools, e.g. opengrep.",
                  )}
                  error={errorFor(errors, "requires.hostTools")}
                >
                  <Input
                    id="task-requires-host-tools"
                    disabled={pending}
                    error={Boolean(errorFor(errors, "requires.hostTools"))}
                    aria-invalid={Boolean(errorFor(errors, "requires.hostTools"))}
                    value={draft.requiredHostTools}
                    onChange={(e) => set({ requiredHostTools: e.target.value })}
                    className="settings-mono"
                  />
                </Field>
              </CardContent>
            </Card>

            {taskType === "query" && (
              <Card>
                <CardHeader>
                  <CardTitle as="h2">Output schema</CardTitle>
                  <CardDescription>
                    A JSON schema (an object) the run&apos;s structured output must match. Empty for
                    a Markdown answer.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Field
                    label="Schema"
                    htmlFor="task-output-schema"
                    description={withDefault("Leave it empty for a Markdown answer.")}
                    error={errorFor(errors, "outputSchema")}
                  >
                    <Textarea
                      id="task-output-schema"
                      rows={10}
                      disabled={pending}
                      aria-invalid={Boolean(errorFor(errors, "outputSchema"))}
                      value={draft.outputSchema}
                      onChange={(e) => set({ outputSchema: e.target.value })}
                      className="settings-mono"
                    />
                  </Field>
                </CardContent>
              </Card>
            )}

            {taskType === "coding" && (
              <Card>
                <CardHeader>
                  <CardTitle as="h2">Coding</CardTitle>
                  <CardDescription>
                    How the run publishes its work and how far it may go.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <CodingFields
                    value={draft.coding}
                    onChange={(coding) => set({ coding })}
                    prDescriptionTasks={prDescriptionTasks}
                    errors={errors}
                    disabled={pending}
                  />
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle as="h2">Running</CardTitle>
                <CardDescription>Where the output goes and what a run may use.</CardDescription>
              </CardHeader>
              <CardContent className="definition-grid-wide">
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
                    value={draft.sink}
                    onChange={(e) => set({ sink: e.target.value as SinkKind })}
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
                  description={withDefault(
                    "Whose concurrency slots its runs take.",
                    defaultPool(taskType, pools) || NOT_SET,
                  )}
                  error={errors.pool}
                  required
                >
                  <NativeSelect
                    id="task-pool"
                    disabled={pending}
                    aria-invalid={Boolean(errors.pool)}
                    value={draft.pool}
                    onChange={(e) => set({ pool: e.target.value as PoolName })}
                  >
                    {draft.pool === "" && <option value="">Choose a pool</option>}
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
                  description={withDefault(
                    "Claude model ID. Leave it empty to use the agent's model.",
                    "the agent's model",
                  )}
                  error={errors.model}
                >
                  <Input
                    id="task-model"
                    disabled={pending}
                    error={Boolean(errors.model)}
                    aria-invalid={Boolean(errors.model)}
                    value={draft.model}
                    onChange={(e) => set({ model: e.target.value })}
                    className="settings-mono"
                  />
                </Field>
                <Field
                  label="Token budget"
                  htmlFor="task-token-budget"
                  description={withDefault("The most tokens a run may use.", "the profile budget")}
                  error={budgetError}
                >
                  <div className="task-budget">
                    <NativeSelect
                      id="task-token-budget"
                      disabled={pending}
                      aria-invalid={Boolean(budgetError)}
                      value={draft.budgetMode}
                      onChange={(e) => set({ budgetMode: e.target.value as BudgetMode })}
                    >
                      <option value="profile">Profile budget</option>
                      <option value="tokens">Tokens</option>
                      <option value="profileFraction">% of the profile budget</option>
                    </NativeSelect>
                    {draft.budgetMode !== "profile" && (
                      <Input
                        id="task-token-budget-amount"
                        aria-label={draft.budgetMode === "tokens" ? "Tokens" : "Percent"}
                        type="number"
                        className="input-number-wide"
                        min={1}
                        max={draft.budgetMode === "tokens" ? undefined : 100}
                        disabled={pending}
                        error={Boolean(budgetError)}
                        aria-invalid={Boolean(budgetError)}
                        value={draft.budgetAmount}
                        onChange={(e) => set({ budgetAmount: e.target.value })}
                      />
                    )}
                  </div>
                </Field>
              </CardContent>
            </Card>

            <EditorActions
              anchorId="task-form-actions"
              label={task?.name ?? "New task"}
              editing={task !== null}
              dirty={dirty}
              pending={pending}
              saveLabel={task ? "Save task" : "Create task"}
              onDiscard={discard}
              cancelHref={task ? taskHref(task.id) : "/settings/tasks"}
            />
          </form>
        </Stack>
        {task && (
          <ConfirmChangesDialog
            open={confirming}
            onCancel={() => setConfirming(false)}
            title={`Save ${task.name}?`}
            consequence="The task's next run uses the new settings."
            changes={changes}
            onConfirm={() => {
              setConfirming(false);
              save();
            }}
          />
        )}
      </main>
    </>
  );
}
