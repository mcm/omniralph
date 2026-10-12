"use client";

import * as React from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Muted,
} from "@iamthemcmaster/ui";
import { IconCopy } from "@tabler/icons-react";
import type { AgentDefinition, NamedContent, TaskType } from "@omniralph/tasks";
import { AppHeader } from "@/components/app-header";
import { BuiltinBadge, ModelName, mono, pageMain, pageTitle, TaskTypeBadges } from "../agent-parts";

/** A task running on the agent. */
export interface AgentTask {
  id: string;
  name: string;
  taskType: TaskType;
  builtin: boolean;
}

interface AgentDetailViewProps {
  agent: AgentDefinition;
  builtin: boolean;
  tasks: AgentTask[];
  isAdmin: boolean;
}

const stack = { display: "flex", flexDirection: "column", gap: "var(--space-3)" } as const;
const factLabel = { fontSize: "var(--text-xs)", color: "var(--text-tertiary)" } as const;
const preBlock = {
  ...mono,
  margin: 0,
  padding: "var(--space-3)",
  background: "var(--bg-raised)",
  borderRadius: "var(--radius-sm)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  maxHeight: 480,
  overflowY: "auto",
} as const;

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <span style={factLabel}>{label}</span>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--text-primary)" }}>{children}</div>
    </div>
  );
}

function NameList({ names }: { names: string[] }) {
  if (names.length === 0) return <Muted>None</Muted>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
      {names.map((name) => (
        <Badge key={name} variant="outline">
          {name}
        </Badge>
      ))}
    </div>
  );
}

function Documents({ documents, empty }: { documents: NamedContent[]; empty: string }) {
  if (documents.length === 0) return <Muted>{empty}</Muted>;
  return (
    <div style={stack}>
      {documents.map((doc) => (
        <details key={doc.name}>
          <summary style={{ cursor: "pointer", fontSize: "var(--text-sm)" }}>{doc.name}</summary>
          <pre style={{ ...preBlock, marginTop: "var(--space-2)" }}>{doc.content}</pre>
        </details>
      ))}
    </div>
  );
}

export function AgentDetailView({ agent, builtin, tasks, isAdmin }: AgentDetailViewProps) {
  return (
    <>
      <AppHeader
        breadcrumbs={[
          { label: "Settings" },
          { label: "Agents", href: "/settings/agents" },
          { label: agent.name },
        ]}
      />
      <main style={pageMain}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "var(--space-4)",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <h1 style={pageTitle}>{agent.name}</h1>
              {builtin && <BuiltinBadge />}
            </div>
            <span style={{ ...mono, color: "var(--text-secondary)" }}>{agent.id}</span>
            {agent.description && (
              <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
                {agent.description}
              </Muted>
            )}
          </div>
          {builtin && isAdmin && (
            // Cloning is wired with agent editing; until then the button only shows where it goes.
            <Button variant="outline" disabled title="Cloning arrives with agent editing">
              <IconCopy size={14} />
              Clone
            </Button>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Overview</CardTitle>
          </CardHeader>
          <CardContent
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "var(--space-4)",
            }}
          >
            <Fact label="Task types">
              <TaskTypeBadges taskTypes={agent.taskTypes} />
            </Fact>
            <Fact label="Model">
              <ModelName model={agent.model} />
            </Fact>
            <Fact label="Fallback model">
              {agent.fallbackModel === null ? (
                <Muted>None</Muted>
              ) : (
                <ModelName model={agent.fallbackModel} />
              )}
            </Fact>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>System prompt</CardTitle>
            <CardDescription>
              {agent.systemPromptMode === "replace"
                ? "Replaces the Claude Code system prompt."
                : "Appended to the Claude Code system prompt."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {agent.systemPrompt ? (
              <pre style={preBlock}>{agent.systemPrompt}</pre>
            ) : (
              <Muted>No system prompt.</Muted>
            )}
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
            <Fact label="Claude Code tools">
              <NameList names={agent.tools.builtin} />
            </Fact>
            <Fact label="Harness tools">
              <NameList names={agent.tools.harness} />
            </Fact>
            <Fact label="Linear tools">
              <NameList names={agent.tools.linear} />
            </Fact>
            <Fact label="MCP servers">
              <NameList names={agent.tools.mcpServers} />
            </Fact>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Skills</CardTitle>
          </CardHeader>
          <CardContent>
            <Documents documents={agent.skills} empty="No skills." />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Reference docs</CardTitle>
          </CardHeader>
          <CardContent>
            <Documents documents={agent.referenceDocs} empty="No reference docs." />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Used by</CardTitle>
            <CardDescription>Tasks that run on this agent.</CardDescription>
          </CardHeader>
          <CardContent style={stack}>
            {tasks.length === 0 ? (
              <Muted>No task uses this agent.</Muted>
            ) : (
              tasks.map((task) => (
                <div
                  key={task.id}
                  style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
                >
                  <span style={{ fontSize: "var(--text-sm)" }}>{task.name}</span>
                  <span style={{ ...mono, color: "var(--text-secondary)" }}>{task.id}</span>
                  <Badge variant="outline">{task.taskType}</Badge>
                  {task.builtin && <BuiltinBadge />}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
