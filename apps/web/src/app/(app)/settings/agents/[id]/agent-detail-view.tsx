"use client";

import { Link } from "@/components/link";
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
import { useQueryClient } from "@tanstack/react-query";
import type { NamedContent } from "@omniralph/tasks";
import { AppHeader } from "@/components/app-header";
import { MonoValue } from "@/components/mono-value";
import { PageHeader } from "@/components/page-header";
import { useQueryKeys } from "@/components/query-provider";
import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import {
  definitionPath,
  savedDefinitionSchema,
  type AgentDetail,
  type AgentTask,
} from "@/lib/api/definitions";
import { mutationResultSchema } from "@/lib/api/schemas";
import { stateLabel } from "@/lib/state-variants";
import {
  DefinitionLoading,
  notFoundOn404,
  useDefinitionId,
  useIsAdmin,
} from "../../definition-page";
import {
  definitionDeleted,
  definitionKeys,
  definitionsChanged,
  useAgentDetail,
} from "../../definition-queries";
import {
  agentEditHref,
  BuiltinBadge,
  Fact,
  ModelName,
  NameList,
  TaskTypeBadges,
} from "../agent-parts";

export type { AgentTask };

type AgentDetailContentProps = AgentDetail & { isAdmin: boolean };

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
function AdminActions({ agent, builtin, tasks }: AgentDetail) {
  const router = useRouter();
  const client = useQueryClient();
  const keys = useQueryKeys();
  const clone = useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      api.post(definitionPath("agents", agent.id, "clone"), savedDefinitionSchema, {
        organizationId,
      }),
    invalidate: definitionsChanged,
    success: `Cloned ${agent.name}`,
    onSuccess: ({ id }) => router.push(agentEditHref(id)),
  });
  const remove = useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      api.delete(definitionPath("agents", agent.id), mutationResultSchema, { organizationId }),
    invalidate: definitionDeleted("agents"),
    success: `Deleted ${agent.name}`,
    onSuccess: () => {
      router.push("/settings/agents");
      client.removeQueries({ queryKey: definitionKeys(keys).agents.detail(agent.id) });
    },
  });
  // Held until the page changes: the list or the clone's form is on its way.
  const pending = clone.isPending || clone.isSuccess || remove.isPending || remove.isSuccess;

  return (
    <>
      <Button variant="outline" disabled={pending} onClick={() => clone.mutate()}>
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
                {remove.isPending ? "Deleting…" : "Delete"}
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
                <AlertDialogAction variant="danger" onClick={() => remove.mutate()}>
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

/**
 * One agent definition of the organization (a built-in or one of its rows) and the tasks
 * that run on it, live. Unknown IDs, another organization's too, are not found.
 */
export function AgentDetailView() {
  const id = useDefinitionId();
  const isAdmin = useIsAdmin();
  const query = useAgentDetail(id);
  if (query.data) return <AgentDetailContent {...query.data} isAdmin={isAdmin} />;
  notFoundOn404(query.error);
  return (
    <DefinitionLoading
      breadcrumbs={[{ label: "Agents", href: "/settings/agents" }, { label: "Agent" }]}
      query={query}
      what="the agent"
    />
  );
}

export function AgentDetailContent({ agent, builtin, tasks, isAdmin }: AgentDetailContentProps) {
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
              <MonoValue value={agent.id} className="text-xs text-text-secondary" />
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
                  <MonoValue value={task.id} className="text-xs text-text-secondary" />
                  <Badge variant="neutral">{stateLabel(task.taskType)}</Badge>
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
