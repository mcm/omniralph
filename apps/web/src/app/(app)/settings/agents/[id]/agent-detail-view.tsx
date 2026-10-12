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
  Cluster,
  Muted,
  Stack,
} from "@iamthemcmaster/ui";
import { IconCopy, IconPencil, IconTrash } from "@tabler/icons-react";
import type { AgentDefinition, NamedContent, TaskType } from "@omniralph/tasks";
import { AppHeader } from "@/components/app-header";
import { PageHeader } from "@/components/page-header";
import { useAction } from "@/components/use-action";
import { cloneAgentDefinition, deleteAgentDefinition } from "../actions";
import {
  agentEditHref,
  BuiltinBadge,
  Fact,
  ModelName,
  NameList,
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
    <Stack gap={3}>
      {documents.map((doc) => (
        <details key={doc.name}>
          <summary className="cursor-pointer text-sm">{doc.name}</summary>
          <pre className="definition-pre definition-pre-spaced">{doc.content}</pre>
        </details>
      ))}
    </Stack>
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
    <>
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
    </>
  );
}

export function AgentDetailView({ agent, builtin, tasks, isAdmin }: AgentDetailViewProps) {
  return (
    <>
      <AppHeader
        breadcrumbs={[{ label: "Agents", href: "/settings/agents" }, { label: agent.name }]}
      />
      <main className="detail-main">
        <PageHeader
          title={agent.name}
          description={agent.description || undefined}
          meta={
            <>
              {builtin && <BuiltinBadge />}
              <span className="font-mono text-xs text-text-secondary">{agent.id}</span>
            </>
          }
          actions={isAdmin && <AdminActions agent={agent} builtin={builtin} tasks={tasks} />}
        />

        <Card>
          <CardHeader>
            <CardTitle as="h2">Overview</CardTitle>
          </CardHeader>
          <CardContent className="definition-grid">
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
            <CardTitle as="h2">System prompt</CardTitle>
            <CardDescription>
              {agent.systemPromptMode === "replace"
                ? "Replaces the Claude Code system prompt."
                : "Appended to the Claude Code system prompt."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {agent.systemPrompt ? (
              <pre className="definition-pre">{agent.systemPrompt}</pre>
            ) : (
              <Muted>No system prompt.</Muted>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">Tools</CardTitle>
            <CardDescription>
              What the agent wants; a task&apos;s type and tool settings narrow it further.
            </CardDescription>
          </CardHeader>
          <CardContent className="definition-stack">
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
            <CardTitle as="h2">Skills</CardTitle>
          </CardHeader>
          <CardContent>
            <Documents documents={agent.skills} empty="No skills." />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">Reference docs</CardTitle>
          </CardHeader>
          <CardContent>
            <Documents documents={agent.referenceDocs} empty="No reference docs." />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">Used by</CardTitle>
            <CardDescription>Tasks that run on this agent.</CardDescription>
          </CardHeader>
          <CardContent className="definition-stack">
            {tasks.length === 0 ? (
              <Muted>No task uses this agent.</Muted>
            ) : (
              tasks.map((task) => (
                <Cluster key={task.id}>
                  <span className="text-sm">{task.name}</span>
                  <span className="font-mono text-xs text-text-secondary">{task.id}</span>
                  <Badge variant="neutral">{task.taskType}</Badge>
                  {task.builtin && <BuiltinBadge />}
                </Cluster>
              ))
            )}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
