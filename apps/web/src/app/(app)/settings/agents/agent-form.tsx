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
  Stack,
  Textarea,
} from "@iamthemcmaster/ui";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import {
  HARNESS_TOOLS,
  LINEAR_TOOLS,
  SYSTEM_PROMPT_MODES,
  TASK_TYPES,
  type AgentDefinition,
  type NamedContent,
  type SystemPromptMode,
} from "@omniralph/tasks";
import { CLAUDE_CODE_TOOLS, type FieldErrors } from "@omniralph/shared";
import { AppHeader } from "@/components/app-header";
import { ModelPicker, TagInput } from "@/components/pickers";
import { PageHeader } from "@/components/page-header";
import { ConfirmChangesDialog } from "@/components/settings-card";
import { useAction } from "@/components/use-action";
import type { HarnessChoices } from "@/lib/harnesses/editor-choices";
import { withDefault } from "@/lib/settings/changes";
import {
  createAgentDefinition,
  updateAgentDefinition,
  type AgentDefinitionFields,
} from "./actions";
import {
  agentChanges,
  agentDraft,
  SYSTEM_PROMPT_MODE_LABELS,
  type AgentDraft,
} from "./agent-changes";
import { agentHref } from "./agent-parts";
import { Choices, EditorActions, errorFor, mcpServerOptions } from "./form-parts";

/** The agent being edited (its definition without the ID), or null to create one. */
export interface AgentFormProps {
  agent: (Omit<AgentDefinition, "id"> & { id: string }) | null;
  /** The models and installables the organization's harnesses report. */
  choices: HarnessChoices;
  /** Field errors to show from the start (component tests). */
  initialErrors?: FieldErrors;
}

/** Editable named documents (skills or reference docs), errors keyed `<field>.<index>.<name|content>`. */
function Documents({
  field,
  noun,
  documents,
  onChange,
  errors,
  disabled,
}: {
  field: "skills" | "referenceDocs";
  noun: string;
  documents: NamedContent[];
  onChange: (documents: NamedContent[]) => void;
  errors: FieldErrors;
  disabled: boolean;
}) {
  const update = (index: number, change: Partial<NamedContent>) =>
    onChange(documents.map((doc, i) => (i === index ? { ...doc, ...change } : doc)));
  return (
    <Stack>
      {errors[field] && <p className="m-0 text-danger-fg">{errors[field]}</p>}
      {documents.length === 0 && <Muted>No {noun}s.</Muted>}
      {documents.map((doc, index) => {
        const prefix = `${field}.${index}`;
        return (
          <div key={index} className="definition-document">
            <Field
              label="Name"
              htmlFor={`agent-${prefix}-name`}
              error={errors[`${prefix}.name`]}
              required
            >
              <Input
                id={`agent-${prefix}-name`}
                disabled={disabled}
                error={Boolean(errors[`${prefix}.name`])}
                aria-invalid={Boolean(errors[`${prefix}.name`])}
                value={doc.name}
                onChange={(e) => update(index, { name: e.target.value })}
              />
            </Field>
            <Field
              label="Content"
              htmlFor={`agent-${prefix}-content`}
              description="Markdown."
              error={errors[`${prefix}.content`]}
              required
            >
              <Textarea
                id={`agent-${prefix}-content`}
                rows={6}
                disabled={disabled}
                aria-invalid={Boolean(errors[`${prefix}.content`])}
                value={doc.content}
                onChange={(e) => update(index, { content: e.target.value })}
                className="settings-mono"
              />
            </Field>
            <div>
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                onClick={() => onChange(documents.filter((_, i) => i !== index))}
              >
                <IconTrash size={14} />
                Remove {noun}
              </Button>
            </div>
          </div>
        );
      })}
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange([...documents, { name: "", content: "" }])}
        >
          <IconPlus size={14} />
          Add {noun}
        </Button>
      </div>
    </Stack>
  );
}

/** The form creating an agent, or editing one of the organization's. */
export function AgentForm({ agent, choices, initialErrors = {} }: AgentFormProps) {
  const router = useRouter();
  const { pending, run } = useAction();
  const [saved, setSaved] = React.useState(() => agentDraft(agent));
  const [draft, setDraft] = React.useState(saved);
  const [errors, setErrors] = React.useState<FieldErrors>(initialErrors);
  const [confirming, setConfirming] = React.useState(false);
  const set = (change: Partial<AgentDraft>) => setDraft((current) => ({ ...current, ...change }));
  const changes = agentChanges(saved, draft);
  const dirty = changes.length > 0;

  const save = () => {
    const input: AgentDefinitionFields = {
      name: draft.name,
      description: draft.description,
      systemPrompt: draft.systemPrompt,
      systemPromptMode: draft.systemPromptMode,
      tools: {
        builtin: draft.builtinTools,
        harness: draft.harnessTools,
        linear: draft.linearTools,
        mcpServers: draft.mcpServers,
      },
      skills: draft.skills,
      referenceDocs: draft.referenceDocs,
      model: draft.model.trim() || null,
      fallbackModel: draft.fallbackModel.trim() || null,
      taskTypes: draft.taskTypes,
    };
    let savedId = agent?.id;
    run(
      async () => {
        if (agent) return updateAgentDefinition(agent.id, input);
        const result = await createAgentDefinition(input);
        if (result.ok && "id" in result) savedId = result.id;
        return result;
      },
      agent ? `${draft.name} saved` : `${draft.name} created`,
      () => {
        setErrors({});
        setSaved(draft);
        if (savedId) router.push(agentHref(savedId));
      },
      (result) => setErrors(result.fieldErrors ?? {}),
    );
  };

  /** An edit confirms its change list first; a new agent saves straight away. */
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (!agent) save();
    else if (dirty) setConfirming(true);
  };

  const discard = () => {
    setDraft(saved);
    setErrors({});
  };

  const title = agent ? `Edit ${agent.name}` : "New agent";
  const breadcrumbs = [
    { label: "Agents", href: "/settings/agents" },
    ...(agent ? [{ label: agent.name, href: agentHref(agent.id) }] : []),
    { label: agent ? "Edit" : "New" },
  ];

  return (
    <>
      <AppHeader breadcrumbs={breadcrumbs} />
      <main className="detail-main">
        <PageHeader
          title={title}
          description="An agent is the persona tasks run on. Changes apply to the next run of every task using it."
        />
        <Stack gap={6} asChild>
          <form onSubmit={submit} noValidate>
            {errors.form && <p className="m-0 text-danger-fg">{errors.form}</p>}
            <Card>
              <CardHeader>
                <CardTitle as="h2">Overview</CardTitle>
              </CardHeader>
              <CardContent className="settings-card-content">
                <Field label="Name" htmlFor="agent-name" error={errors.name} required>
                  <Input
                    id="agent-name"
                    disabled={pending}
                    error={Boolean(errors.name)}
                    aria-invalid={Boolean(errors.name)}
                    value={draft.name}
                    onChange={(e) => set({ name: e.target.value })}
                  />
                </Field>
                <Field label="Description" htmlFor="agent-description" error={errors.description}>
                  <Textarea
                    id="agent-description"
                    rows={2}
                    disabled={pending}
                    aria-invalid={Boolean(errors.description)}
                    value={draft.description}
                    onChange={(e) => set({ description: e.target.value })}
                  />
                </Field>
                <Field
                  label="Suited task types"
                  htmlFor="agent-task-types"
                  description="Tasks of these types may run on the agent."
                  error={errorFor(errors, "taskTypes")}
                  required
                >
                  <Choices
                    id="agent-task-types"
                    options={TASK_TYPES}
                    value={draft.taskTypes}
                    onChange={(taskTypes) => set({ taskTypes })}
                    disabled={pending}
                  />
                </Field>
                <div className="definition-grid-wide">
                  <Field
                    label="Model"
                    htmlFor="agent-model"
                    description={withDefault(
                      "From the models your harnesses report. The profile's model leaves it to the repository's review profile.",
                      "the profile's model",
                    )}
                    error={errors.model}
                  >
                    <ModelPicker
                      id="agent-model"
                      disabled={pending}
                      value={draft.model}
                      onChange={(model) => set({ model: model ?? "" })}
                      options={choices.models}
                      harnessCount={choices.harnessCount}
                      allowNone
                      noneLabel="The profile's model"
                    />
                  </Field>
                  <Field
                    label="Fallback model"
                    htmlFor="agent-fallback-model"
                    description={withDefault(
                      "Used when the model is overloaded. None runs without a fallback.",
                    )}
                    error={errors.fallbackModel}
                  >
                    <ModelPicker
                      id="agent-fallback-model"
                      disabled={pending}
                      value={draft.fallbackModel}
                      onChange={(fallbackModel) => set({ fallbackModel: fallbackModel ?? "" })}
                      options={choices.models}
                      harnessCount={choices.harnessCount}
                      allowNone
                    />
                  </Field>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle as="h2">System prompt</CardTitle>
              </CardHeader>
              <CardContent className="settings-card-content">
                <Field
                  label="Mode"
                  htmlFor="agent-system-prompt-mode"
                  description={withDefault(
                    "How the agent's prompt combines with Claude Code's own.",
                    "append to the Claude Code system prompt",
                  )}
                  error={errors.systemPromptMode}
                >
                  <NativeSelect
                    id="agent-system-prompt-mode"
                    disabled={pending}
                    value={draft.systemPromptMode}
                    onChange={(e) => set({ systemPromptMode: e.target.value as SystemPromptMode })}
                  >
                    {SYSTEM_PROMPT_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {SYSTEM_PROMPT_MODE_LABELS[mode]}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field
                  label="System prompt"
                  htmlFor="agent-system-prompt"
                  description="Markdown."
                  error={errors.systemPrompt}
                >
                  <Textarea
                    id="agent-system-prompt"
                    rows={12}
                    disabled={pending}
                    aria-invalid={Boolean(errors.systemPrompt)}
                    value={draft.systemPrompt}
                    onChange={(e) => set({ systemPrompt: e.target.value })}
                    className="settings-mono"
                  />
                </Field>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle as="h2">Tools</CardTitle>
                <CardDescription>
                  What the agent wants; a task&apos;s type and tool settings narrow it further.
                </CardDescription>
              </CardHeader>
              <CardContent className="settings-card-content">
                <Field
                  label="Claude Code tools"
                  htmlFor="agent-tools-builtin"
                  description={withDefault(
                    "Pick Claude Code's tools, or type a rule such as Bash(git log:*).",
                  )}
                  error={errorFor(errors, "tools.builtin")}
                >
                  <TagInput
                    id="agent-tools-builtin"
                    disabled={pending}
                    value={draft.builtinTools}
                    onChange={(builtinTools) => set({ builtinTools })}
                    options={CLAUDE_CODE_TOOLS}
                    allowCustom
                    placeholder="Add a tool…"
                    className="settings-mono"
                  />
                </Field>
                <Field
                  label="Harness tools"
                  htmlFor="agent-tools-harness"
                  description={withDefault(
                    "Tools from the harness's omniralph MCP server.",
                    "none chosen",
                  )}
                  error={errorFor(errors, "tools.harness")}
                >
                  <Choices
                    id="agent-tools-harness"
                    options={HARNESS_TOOLS}
                    value={draft.harnessTools}
                    onChange={(harnessTools) => set({ harnessTools })}
                    disabled={pending}
                  />
                </Field>
                <Field
                  label="Linear tools"
                  htmlFor="agent-tools-linear"
                  description={withDefault(
                    "Read-only; a task must also enable Linear reads.",
                    "none chosen",
                  )}
                  error={errorFor(errors, "tools.linear")}
                >
                  <Choices
                    id="agent-tools-linear"
                    options={LINEAR_TOOLS}
                    value={draft.linearTools}
                    onChange={(linearTools) => set({ linearTools })}
                    disabled={pending}
                  />
                </Field>
                <Field
                  label="MCP servers"
                  htmlFor="agent-tools-mcp"
                  description={withDefault(
                    "Pick an installable's server (<package>:<server>; its tasks then need that installable), or type the name of an MCP server configured on the harnesses.",
                  )}
                  error={errorFor(errors, "tools.mcpServers")}
                >
                  <TagInput
                    id="agent-tools-mcp"
                    disabled={pending}
                    value={draft.mcpServers}
                    onChange={(mcpServers) => set({ mcpServers })}
                    options={mcpServerOptions(choices)}
                    allowCustom
                    placeholder="Add an MCP server…"
                    className="settings-mono"
                  />
                </Field>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle as="h2">Skills</CardTitle>
                <CardDescription>
                  Instructions the agent loads when a task calls for them.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Documents
                  field="skills"
                  noun="skill"
                  documents={draft.skills}
                  onChange={(skills) => set({ skills })}
                  errors={errors}
                  disabled={pending}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle as="h2">Reference docs</CardTitle>
                <CardDescription>Documents the agent can read during a run.</CardDescription>
              </CardHeader>
              <CardContent>
                <Documents
                  field="referenceDocs"
                  noun="reference doc"
                  documents={draft.referenceDocs}
                  onChange={(referenceDocs) => set({ referenceDocs })}
                  errors={errors}
                  disabled={pending}
                />
              </CardContent>
            </Card>

            <EditorActions
              anchorId="agent-form-actions"
              label={agent?.name ?? "New agent"}
              editing={agent !== null}
              dirty={dirty}
              pending={pending}
              saveLabel={agent ? "Save agent" : "Create agent"}
              onDiscard={discard}
              cancelHref={agent ? agentHref(agent.id) : "/settings/agents"}
            />
          </form>
        </Stack>
        {agent && (
          <ConfirmChangesDialog
            open={confirming}
            onCancel={() => setConfirming(false)}
            title={`Save ${agent.name}?`}
            consequence="The next run of every task using this agent uses the new settings."
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
