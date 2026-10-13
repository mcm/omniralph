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
  Cluster,
  Field,
  Input,
  Muted,
  NativeSelect,
  Stack,
  Textarea,
} from "@iamthemcmaster/ui";
import { IconDeviceFloppy, IconPlus, IconTrash } from "@tabler/icons-react";
import {
  HARNESS_TOOLS,
  LINEAR_TOOLS,
  TASK_TYPES,
  type AgentDefinition,
  type NamedContent,
  type SystemPromptMode,
} from "@omniralph/tasks";
import type { FieldErrors } from "@omniralph/shared";
import { AppHeader } from "@/components/app-header";
import { PageHeader } from "@/components/page-header";
import { useAction } from "@/components/use-action";
import {
  createAgentDefinition,
  updateAgentDefinition,
  type AgentDefinitionFields,
} from "./actions";
import { agentHref } from "./agent-parts";
import { Choices, errorFor, splitNames } from "./form-parts";

/** The agent being edited (its definition without the ID), or null to create one. */
export interface AgentFormProps {
  agent: (Omit<AgentDefinition, "id"> & { id: string }) | null;
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
export function AgentForm({ agent, initialErrors = {} }: AgentFormProps) {
  const router = useRouter();
  const { pending, run } = useAction();
  const [name, setName] = React.useState(agent?.name ?? "");
  const [description, setDescription] = React.useState(agent?.description ?? "");
  const [systemPrompt, setSystemPrompt] = React.useState(agent?.systemPrompt ?? "");
  const [systemPromptMode, setSystemPromptMode] = React.useState<SystemPromptMode>(
    agent?.systemPromptMode ?? "append",
  );
  const [builtinTools, setBuiltinTools] = React.useState(agent?.tools.builtin.join(", ") ?? "");
  const [harnessTools, setHarnessTools] = React.useState(agent?.tools.harness ?? []);
  const [linearTools, setLinearTools] = React.useState(agent?.tools.linear ?? []);
  const [mcpServers, setMcpServers] = React.useState(agent?.tools.mcpServers.join(", ") ?? "");
  const [skills, setSkills] = React.useState<NamedContent[]>(agent?.skills ?? []);
  const [referenceDocs, setReferenceDocs] = React.useState<NamedContent[]>(
    agent?.referenceDocs ?? [],
  );
  const [model, setModel] = React.useState(agent?.model ?? "");
  const [fallbackModel, setFallbackModel] = React.useState(agent?.fallbackModel ?? "");
  const [taskTypes, setTaskTypes] = React.useState(agent?.taskTypes ?? []);
  const [errors, setErrors] = React.useState<FieldErrors>(initialErrors);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const input: AgentDefinitionFields = {
      name,
      description,
      systemPrompt,
      systemPromptMode,
      tools: {
        builtin: splitNames(builtinTools),
        harness: harnessTools,
        linear: linearTools,
        mcpServers: splitNames(mcpServers),
      },
      skills,
      referenceDocs,
      model: model.trim() || null,
      fallbackModel: fallbackModel.trim() || null,
      taskTypes,
    };
    let savedId = agent?.id;
    run(
      async () => {
        if (agent) return updateAgentDefinition(agent.id, input);
        const result = await createAgentDefinition(input);
        if (result.ok && "id" in result) savedId = result.id;
        return result;
      },
      agent ? `${name} saved` : `${name} created`,
      () => {
        setErrors({});
        if (savedId) router.push(agentHref(savedId));
      },
      (result) => setErrors(result.fieldErrors ?? {}),
    );
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
          <form onSubmit={save} noValidate>
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
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field label="Description" htmlFor="agent-description" error={errors.description}>
                  <Textarea
                    id="agent-description"
                    rows={2}
                    disabled={pending}
                    aria-invalid={Boolean(errors.description)}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
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
                    value={taskTypes}
                    onChange={setTaskTypes}
                    disabled={pending}
                  />
                </Field>
                <div className="definition-grid-wide">
                  <Field
                    label="Model"
                    htmlFor="agent-model"
                    description="Claude model ID. Empty uses the repository profile's model."
                    error={errors.model}
                  >
                    <Input
                      id="agent-model"
                      disabled={pending}
                      error={Boolean(errors.model)}
                      aria-invalid={Boolean(errors.model)}
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className="settings-mono"
                    />
                  </Field>
                  <Field
                    label="Fallback model"
                    htmlFor="agent-fallback-model"
                    description="Used when the model is overloaded. Leave it empty for no fallback. Default: not set."
                    error={errors.fallbackModel}
                  >
                    <Input
                      id="agent-fallback-model"
                      disabled={pending}
                      error={Boolean(errors.fallbackModel)}
                      aria-invalid={Boolean(errors.fallbackModel)}
                      value={fallbackModel}
                      onChange={(e) => setFallbackModel(e.target.value)}
                      className="settings-mono"
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
                  error={errors.systemPromptMode}
                >
                  <NativeSelect
                    id="agent-system-prompt-mode"
                    disabled={pending}
                    value={systemPromptMode}
                    onChange={(e) => setSystemPromptMode(e.target.value as SystemPromptMode)}
                  >
                    <option value="append">Append to the Claude Code system prompt</option>
                    <option value="replace">Replace the Claude Code system prompt</option>
                  </NativeSelect>
                </Field>
                <Field
                  label="System prompt"
                  htmlFor="agent-system-prompt"
                  error={errors.systemPrompt}
                >
                  <Textarea
                    id="agent-system-prompt"
                    rows={12}
                    disabled={pending}
                    aria-invalid={Boolean(errors.systemPrompt)}
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
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
                  description="Comma-separated, e.g. Read, Grep, Glob."
                  error={errorFor(errors, "tools.builtin")}
                >
                  <Input
                    id="agent-tools-builtin"
                    disabled={pending}
                    error={Boolean(errorFor(errors, "tools.builtin"))}
                    aria-invalid={Boolean(errorFor(errors, "tools.builtin"))}
                    value={builtinTools}
                    onChange={(e) => setBuiltinTools(e.target.value)}
                    className="settings-mono"
                  />
                </Field>
                <Field
                  label="Harness tools"
                  htmlFor="agent-tools-harness"
                  error={errorFor(errors, "tools.harness")}
                >
                  <Choices
                    id="agent-tools-harness"
                    options={HARNESS_TOOLS}
                    value={harnessTools}
                    onChange={setHarnessTools}
                    disabled={pending}
                  />
                </Field>
                <Field
                  label="Linear tools"
                  htmlFor="agent-tools-linear"
                  description="Read-only; a task must also enable Linear reads."
                  error={errorFor(errors, "tools.linear")}
                >
                  <Choices
                    id="agent-tools-linear"
                    options={LINEAR_TOOLS}
                    value={linearTools}
                    onChange={setLinearTools}
                    disabled={pending}
                  />
                </Field>
                <Field
                  label="MCP servers"
                  htmlFor="agent-tools-mcp"
                  description="Comma-separated names of configured MCP servers, or an installable's as <package>:<server> (its tasks then need that installable)."
                  error={errorFor(errors, "tools.mcpServers")}
                >
                  <Input
                    id="agent-tools-mcp"
                    disabled={pending}
                    error={Boolean(errorFor(errors, "tools.mcpServers"))}
                    aria-invalid={Boolean(errorFor(errors, "tools.mcpServers"))}
                    value={mcpServers}
                    onChange={(e) => setMcpServers(e.target.value)}
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
                  documents={skills}
                  onChange={setSkills}
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
                  documents={referenceDocs}
                  onChange={setReferenceDocs}
                  errors={errors}
                  disabled={pending}
                />
              </CardContent>
            </Card>

            <Cluster>
              <Button type="submit" variant="primary" disabled={pending}>
                <IconDeviceFloppy size={14} />
                {pending ? "Saving…" : agent ? "Save agent" : "Create agent"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => router.push(agent ? agentHref(agent.id) : "/settings/agents")}
              >
                Cancel
              </Button>
            </Cluster>
          </form>
        </Stack>
      </main>
    </>
  );
}
