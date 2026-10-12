"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Muted,
} from "@iamthemcmaster/ui";
import { IconCopy, IconPencil, IconTrash } from "@tabler/icons-react";
import type { AgentDefinition, NamedContent, TaskType } from "@omniralph/tasks";
import { AppHeader } from "@/components/app-header";
import { useAction } from "@/components/use-action";
import { cloneAgentDefinition, deleteAgentDefinition } from "../actions";
import {
  agentEditHref,
  BuiltinBadge,
  Fact,
  ModelName,
  mono,
  NameList,
  pageMain,
  pageTitle,
  preBlock,
  stack,
  TaskTypeBadges,
} from "../agent-parts";

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

/** Clone (any agent), and Edit and Delete (the organization's own). */
function AdminActions({ agent, builtin, tasks }: Omit<AgentDetailViewProps, "isAdmin">) {
  const router = useRouter();
  const { pending, run } = useAction();

  const clone = () => {
    let cloneId: string | undefined;
    run(
      async () => {
        const result = await cloneAgentDefinition(agent.id);
        if (result.ok && "id" in result) cloneId = result.id;
        return result;
      },
      `Cloned ${agent.name}`,
      () => {
        if (cloneId) router.push(agentEditHref(cloneId));
      },
    );
  };

  return (
    <div style={{ display: "flex", gap: "var(--space-2)" }}>
      <Button variant="outline" disabled={pending} onClick={clone}>
        <IconCopy size={14} />
        Clone
      </Button>
      {!builtin && (
        <>
          <Button asChild variant="outline">
            <Link href={agentEditHref(agent.id)}>
              <IconPencil size={14} />
              Edit
            </Link>
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="danger" disabled={pending}>
                <IconTrash size={14} />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  {tasks.length > 0
                    ? `It can't be deleted while tasks use it: ${tasks.map((task) => task.name).join(", ")}.`
                    : "This can't be undone."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="danger"
                  onClick={() =>
                    run(
                      () => deleteAgentDefinition(agent.id),
                      `Deleted ${agent.name}`,
                      () => router.push("/settings/agents"),
                    )
                  }
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}

export function AgentDetailView({ agent, builtin, tasks, isAdmin }: AgentDetailViewProps) {
  return (
    <>
      <AppHeader
        breadcrumbs={[{ label: "Agents", href: "/settings/agents" }, { label: agent.name }]}
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
          {isAdmin && <AdminActions agent={agent} builtin={builtin} tasks={tasks} />}
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
                  <Badge variant="neutral">{task.taskType}</Badge>
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
