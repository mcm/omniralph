"use client";

import type { ReactNode } from "react";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconCopy, IconPencil, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import type { SetupCommand, TaskDefinition, TeardownCommand, TokenBudget } from "@omniralph/tasks";
import { AppHeader } from "@/components/app-header";
import { MonoValue } from "@/components/mono-value";
import { PageHeader } from "@/components/page-header";
import { useQueryKeys } from "@/components/query-provider";
import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import { definitionPath, savedDefinitionSchema, type TaskDetail } from "@/lib/api/definitions";
import { mutationResultSchema } from "@/lib/api/schemas";
import type { TaskReferrers } from "@/lib/definitions/referrers";
import { repositoryTaskRoles } from "@/lib/definitions/repository-roles";
import { BuiltinBadge, Fact, NameList } from "../../agents/agent-parts";
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
  useTaskDetail,
} from "../../definition-queries";
import { AgentLink, TASK_TYPE_LABELS, taskEditHref, taskHref, TriggerBadges } from "../task-parts";

type TaskDetailContentProps = TaskDetail & { isAdmin: boolean };

const CHAT_TASK_LABELS: Record<TaskReferrers["chatTasks"][number], string> = {
  askAboutCode: "Ask about code",
  startWork: "Start work",
};

function tokenBudgetText(budget: TokenBudget): string {
  if (budget === null) return "Profile budget";
  if ("tokens" in budget) return `${budget.tokens.toLocaleString("en-US")} tokens`;
  return `${Math.round(budget.profileFraction * 100)}% of the profile budget`;
}

function YesNo({ value }: { value: boolean }) {
  return value ? <Badge variant="neutral">Yes</Badge> : <Muted>No</Muted>;
}

function Commands({
  commands,
  empty,
}: {
  commands: (SetupCommand | TeardownCommand)[];
  empty: string;
}) {
  if (commands.length === 0) return <Muted>{empty}</Muted>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Command</TableHead>
          <TableHead>Timeout</TableHead>
          <TableHead>Output kept</TableHead>
          <TableHead>Optional</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {commands.map((command) => (
          <TableRow key={command.name}>
            <TableCell>
              <MonoValue value={command.name} className="text-xs" />
            </TableCell>
            <TableCell>
              <pre className="definition-pre definition-pre-compact">{command.command}</pre>
            </TableCell>
            <TableCell>{command.timeoutSeconds}s</TableCell>
            <TableCell>{command.maxOutputBytes.toLocaleString("en-US")} bytes</TableCell>
            <TableCell>
              {"optional" in command ? <YesNo value={command.optional} /> : <Muted>n/a</Muted>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ReferrerList({ referrers }: { referrers: TaskReferrers }) {
  const items: { key: string; label: ReactNode; detail: string }[] = [
    ...referrers.repositories.map((repo) => ({
      key: `repo:${repo.id}`,
      label: <Link href={`/repositories/${repo.id}`}>{repo.fullPath}</Link>,
      detail: repositoryTaskRoles(repo),
    })),
    ...referrers.chatTasks.map((role) => ({
      key: `chat:${role}`,
      label: "Chat",
      detail: `organization ${CHAT_TASK_LABELS[role]} task`,
    })),
    ...referrers.chatChannels.map((channel) => ({
      key: `channel:${channel.connectionId}:${channel.channelId}`,
      label: `${channel.connectionName} › ${channel.channelId.slice(channel.channelId.lastIndexOf(":") + 1)}`,
      detail: [
        channel.askAboutCode && `channel ${CHAT_TASK_LABELS.askAboutCode} task`,
        channel.startWork && `channel ${CHAT_TASK_LABELS.startWork} task`,
      ]
        .filter(Boolean)
        .join(", "),
    })),
    ...referrers.codingTasks.map((task) => ({
      key: `task:${task.id}`,
      label: <Link href={taskHref(task.id)}>{task.name}</Link>,
      detail: task.builtin ? "built-in coding task, PR description" : "coding task, PR description",
    })),
  ];
  if (items.length === 0) return <Muted>Nothing uses this task.</Muted>;
  return (
    <Stack gap={3}>
      {items.map((item) => (
        <Cluster key={item.key}>
          <span className="text-sm">{item.label}</span>
          <Muted className="text-xs">{item.detail}</Muted>
        </Cluster>
      ))}
    </Stack>
  );
}

/** Clone (any task), and Edit and Delete (the organization's own). */
function AdminActions({
  task,
  builtin,
  inUse,
}: {
  task: TaskDefinition;
  builtin: boolean;
  inUse: boolean;
}) {
  const router = useRouter();
  const client = useQueryClient();
  const keys = useQueryKeys();
  const clone = useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      api.post(definitionPath("tasks", task.id, "clone"), savedDefinitionSchema, {
        organizationId,
      }),
    invalidate: definitionsChanged,
    success: `Cloned ${task.name}`,
    onSuccess: ({ id }) => router.push(taskEditHref(id)),
  });
  const remove = useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      api.delete(definitionPath("tasks", task.id), mutationResultSchema, { organizationId }),
    invalidate: definitionDeleted("tasks"),
    success: `Deleted ${task.name}`,
    onSuccess: () => {
      router.push("/settings/tasks");
      client.removeQueries({ queryKey: definitionKeys(keys).tasks.detail(task.id) });
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
            <Link href={taskEditHref(task.id)}>
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
                <AlertDialogTitle>Delete {task.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  {inUse
                    ? "It can't be deleted while the settings and tasks under Used by use it."
                    : "This can't be undone. It can't be deleted while one of its runs is queued or running."}
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
 * One task definition of the organization (a built-in or one of its rows), what its runs
 * need and what uses it, live. Unknown IDs, another organization's too, are not found.
 */
export function TaskDetailView() {
  const id = useDefinitionId();
  const isAdmin = useIsAdmin();
  const query = useTaskDetail(id);
  if (query.data) return <TaskDetailContent {...query.data} isAdmin={isAdmin} />;
  notFoundOn404(query.error);
  return (
    <DefinitionLoading
      breadcrumbs={[{ label: "Tasks", href: "/settings/tasks" }, { label: "Task" }]}
      query={query}
      what="the task"
    />
  );
}

export function TaskDetailContent({
  task,
  builtin,
  agentName,
  prDescriptionTaskName,
  requirements,
  referrers,
  isAdmin,
}: TaskDetailContentProps) {
  return (
    <>
      <AppHeader
        breadcrumbs={[{ label: "Tasks", href: "/settings/tasks" }, { label: task.name }]}
      />
      <main className="detail-main">
        <PageHeader
          title={task.name}
          description={task.description || undefined}
          meta={
            <>
              {builtin && <BuiltinBadge />}
              <MonoValue value={task.id} className="text-xs text-text-secondary" />
            </>
          }
          actions={
            isAdmin && (
              <AdminActions
                task={task}
                builtin={builtin}
                inUse={Object.values(referrers).some((list) => list.length > 0)}
              />
            )
          }
        />

        <Card>
          <CardHeader>
            <CardTitle as="h2">Overview</CardTitle>
          </CardHeader>
          <CardContent className="definition-grid">
            <Fact label="Task type">{TASK_TYPE_LABELS[task.taskType]}</Fact>
            <Fact label="Agent">
              <AgentLink id={task.agentId} name={agentName} />
            </Fact>
            <Fact label="Triggers">
              <TriggerBadges triggers={task.triggers} />
            </Fact>
            <Fact label="Sink">
              <MonoValue value={task.sink} className="text-xs" />
            </Fact>
            <Fact label="Pool">
              <Badge variant="neutral">{task.pool}</Badge>
            </Fact>
            <Fact label="Model override">
              {task.model ? (
                <MonoValue value={task.model} className="text-xs" />
              ) : (
                <Muted>Agent model</Muted>
              )}
            </Fact>
            <Fact label="Token budget">{tokenBudgetText(task.tokenBudget)}</Fact>
            {task.maxTurns !== undefined && <Fact label="Max turns">{task.maxTurns}</Fact>}
            {task.idleTimeoutMs !== undefined && (
              <Fact label="Idle timeout">{Math.round(task.idleTimeoutMs / 1000)}s</Fact>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">Prompt template</CardTitle>
            <CardDescription>
              Rendered with the trigger&apos;s variables for each run.
            </CardDescription>
          </CardHeader>
          <CardContent className="definition-stack">
            <pre className="definition-pre">{task.promptTemplate}</pre>
            {task.systemAppend && (
              <Fact label="Appended to the agent's system prompt">
                <pre className="definition-pre">{task.systemAppend}</pre>
              </Fact>
            )}
            {task.variableLimits && Object.keys(task.variableLimits).length > 0 && (
              <Fact label="Variable limits">
                <NameList
                  names={Object.entries(task.variableLimits).map(
                    ([name, limit]) => `${name}: ${limit.toLocaleString("en-US")} chars`,
                  )}
                />
              </Fact>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">Commands</CardTitle>
            <CardDescription>
              Setup runs before the session (its output becomes setup.&lt;name&gt;); teardown runs
              after it, whatever happened.
            </CardDescription>
          </CardHeader>
          <CardContent className="definition-stack">
            <Fact label="Setup commands">
              <Commands commands={task.setupCommands} empty="No setup commands." />
            </Fact>
            <Fact label="Teardown commands">
              <Commands commands={task.teardownCommands} empty="No teardown commands." />
            </Fact>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">Tool settings</CardTitle>
            <CardDescription>Narrow the tools the agent wants.</CardDescription>
          </CardHeader>
          <CardContent className="definition-grid">
            <Fact label="Shell">
              <YesNo value={task.toolSettings.shell} />
            </Fact>
            <Fact label="Linear (read-only)">
              <YesNo value={task.toolSettings.linearRead} />
            </Fact>
            <Fact label="Network">
              <YesNo value={task.toolSettings.network} />
            </Fact>
          </CardContent>
        </Card>

        {task.taskType === "query" && (
          <Card>
            <CardHeader>
              <CardTitle as="h2">Output schema</CardTitle>
              <CardDescription>
                The JSON schema the session&apos;s output must match.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {task.outputSchema ? (
                <pre className="definition-pre">{JSON.stringify(task.outputSchema, null, 2)}</pre>
              ) : (
                <Muted>No output schema: the answer is free text.</Muted>
              )}
            </CardContent>
          </Card>
        )}

        {task.taskType === "coding" && (
          <Card>
            <CardHeader>
              <CardTitle as="h2">Coding</CardTitle>
              <CardDescription>How a coding run pushes, opens its PR and retries.</CardDescription>
            </CardHeader>
            <CardContent className="definition-grid">
              <Fact label="Push">
                {task.pushTiming === "end" ? "Once, when every story is done" : "After each story"}
              </Fact>
              <Fact label="Draft PR">
                {task.draftPullRequest === undefined ? (
                  <Muted>Repository setting</Muted>
                ) : task.draftPullRequest === "early" ? (
                  "After the first story"
                ) : (
                  "When every story is done"
                )}
              </Fact>
              <Fact label="PR description task">
                {task.prDescriptionTaskId ? (
                  <Link href={taskHref(task.prDescriptionTaskId)}>
                    {prDescriptionTaskName ?? task.prDescriptionTaskId}
                  </Link>
                ) : (
                  <Muted>None</Muted>
                )}
              </Fact>
              <Fact label="Attempts per story">{task.maxAttemptsPerStory}</Fact>
              <Fact label="Rounds per story">{task.maxRoundsPerStory}</Fact>
              <Fact label="Rounds without progress">{task.stallRounds}</Fact>
              <Fact label="Iterations per run">{task.maxIterationsPerRun}</Fact>
              <Fact label="Review rounds (at most)">{task.maxReviewRounds}</Fact>
              <Fact label="Fix rounds (at most)">{task.maxFixRounds}</Fact>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle as="h2">Requirements</CardTitle>
            <CardDescription>
              What a run needs from the harness that claims it; only capable harnesses are offered
              it.
            </CardDescription>
          </CardHeader>
          <CardContent className="definition-grid">
            <Fact label="Minimum harness version">
              {requirements.minHarnessVersion ? (
                <MonoValue value={requirements.minHarnessVersion} className="text-xs" />
              ) : (
                <Muted>Any</Muted>
              )}
            </Fact>
            <Fact label="Installables">
              <NameList names={requirements.installables} />
            </Fact>
            <Fact label="Host tools">
              <NameList names={requirements.hostTools} />
            </Fact>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">Used by</CardTitle>
            <CardDescription>
              Repository and chat settings, and coding tasks writing their PR description with it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReferrerList referrers={referrers} />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
