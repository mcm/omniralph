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
  Checkbox,
  Field,
  Input,
  Label,
  Muted,
  NativeSelect,
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
import { useAction } from "@/components/use-action";
import {
  createAgentDefinition,
  updateAgentDefinition,
  type AgentDefinitionFields,
} from "./actions";
import { agentHref, pageMain, pageTitle } from "./agent-parts";

/** The agent being edited (its definition without the ID), or null to create one. */
export interface AgentFormProps {
  agent: (Omit<AgentDefinition, "id"> & { id: string }) | null;
  /** Field errors to show from the start (component tests). */
  initialErrors?: FieldErrors;
}

const stack = { display: "flex", flexDirection: "column", gap: "var(--space-4)" } as const;
const grid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "var(--space-4)",
} as const;
const monoInput = { fontFamily: "var(--font-mono)" } as const;

/** Names from a comma- or newline-separated list. */
function splitNames(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** The error of `field` or of anything under it (`tools.builtin.2` for `tools.builtin`). */
function errorFor(errors: FieldErrors, field: string): string | undefined {
  if (errors[field]) return errors[field];
  const nested = Object.keys(errors).find((key) => key.startsWith(`${field}.`));
  return nested && errors[nested];
}

function toggled<T>(list: readonly T[], value: T, on: boolean): T[] {
  return on
    ? [...list.filter((item) => item !== value), value]
    : list.filter((item) => item !== value);
}

/** Checkboxes choosing some of `options`. */
function Choices<T extends string>({
  id,
  options,
  value,
  onChange,
  disabled,
}: {
  id: string;
  options: readonly T[];
  value: readonly T[];
  onChange: (value: T[]) => void;
  disabled: boolean;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-4)" }}>
      {options.map((option) => (
        <div key={option} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <Checkbox
            id={`${id}-${option}`}
            checked={value.includes(option)}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(toggled(value, option, checked === true))}
          />
          <Label htmlFor={`${id}-${option}`} style={monoInput}>
            {option}
          </Label>
        </div>
      ))}
    </div>
  );
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
    <div style={stack}>
      {errors[field] && <p style={{ margin: 0, color: "var(--text-danger)" }}>{errors[field]}</p>}
      {documents.length === 0 && <Muted>No {noun}s.</Muted>}
      {documents.map((doc, index) => {
        const prefix = `${field}.${index}`;
        return (
          <div
            key={index}
            style={{
              ...stack,
              padding: "var(--space-3)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-md)",
            }}
          >
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
              hint="Markdown."
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
                style={monoInput}
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
    </div>
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
    { label: "Settings" },
    { label: "Agents", href: "/settings/agents" },
    ...(agent ? [{ label: agent.name, href: agentHref(agent.id) }] : []),
    { label: agent ? "Edit" : "New" },
  ];

  return (
    <>
      <AppHeader breadcrumbs={breadcrumbs} />
      <main style={pageMain}>
        <div>
          <h1 style={pageTitle}>{title}</h1>
          <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
            An agent is the persona tasks run on. Changes apply to the next run of every task using
            it.
          </Muted>
        </div>
        <form onSubmit={save} noValidate style={{ ...stack, gap: "var(--space-5)" }}>
          {errors.form && <p style={{ margin: 0, color: "var(--text-danger)" }}>{errors.form}</p>}
          <Card>
            <CardHeader>
              <CardTitle>Overview</CardTitle>
            </CardHeader>
            <CardContent style={stack}>
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
                hint="Tasks of these types may run on the agent."
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
              <div style={grid}>
                <Field
                  label="Model"
                  htmlFor="agent-model"
                  hint="Claude model ID. Empty uses the repository profile's model."
                  error={errors.model}
                >
                  <Input
                    id="agent-model"
                    disabled={pending}
                    error={Boolean(errors.model)}
                    aria-invalid={Boolean(errors.model)}
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    style={monoInput}
                  />
                </Field>
                <Field
                  label="Fallback model"
                  htmlFor="agent-fallback-model"
                  hint="Used when the model is overloaded. Empty for none."
                  error={errors.fallbackModel}
                >
                  <Input
                    id="agent-fallback-model"
                    disabled={pending}
                    error={Boolean(errors.fallbackModel)}
                    aria-invalid={Boolean(errors.fallbackModel)}
                    value={fallbackModel}
                    onChange={(e) => setFallbackModel(e.target.value)}
                    style={monoInput}
                  />
                </Field>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>System prompt</CardTitle>
            </CardHeader>
            <CardContent style={stack}>
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
                  style={monoInput}
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tools</CardTitle>
              <CardDescription>
                What the agent wants; a task&apos;s type and tool settings narrow it further.
              </CardDescription>
            </CardHeader>
            <CardContent style={stack}>
              <Field
                label="Claude Code tools"
                htmlFor="agent-tools-builtin"
                hint="Comma-separated, e.g. Read, Grep, Glob."
                error={errorFor(errors, "tools.builtin")}
              >
                <Input
                  id="agent-tools-builtin"
                  disabled={pending}
                  error={Boolean(errorFor(errors, "tools.builtin"))}
                  aria-invalid={Boolean(errorFor(errors, "tools.builtin"))}
                  value={builtinTools}
                  onChange={(e) => setBuiltinTools(e.target.value)}
                  style={monoInput}
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
                hint="Read-only; a task must also enable Linear reads."
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
                hint="Comma-separated names of configured MCP servers."
                error={errorFor(errors, "tools.mcpServers")}
              >
                <Input
                  id="agent-tools-mcp"
                  disabled={pending}
                  error={Boolean(errorFor(errors, "tools.mcpServers"))}
                  aria-invalid={Boolean(errorFor(errors, "tools.mcpServers"))}
                  value={mcpServers}
                  onChange={(e) => setMcpServers(e.target.value)}
                  style={monoInput}
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Skills</CardTitle>
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
              <CardTitle>Reference docs</CardTitle>
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

          <div style={{ display: "flex", gap: "var(--space-2)" }}>
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
          </div>
        </form>
      </main>
    </>
  );
}
