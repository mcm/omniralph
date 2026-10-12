"use client";

import type { ReactNode } from "react";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconCopy, IconPencil, IconTrash } from "@tabler/icons-react";
import type {
  SetupCommand,
  TaskDefinition,
  TaskRequirements,
  TeardownCommand,
  TokenBudget,
} from "@omniralph/tasks";
import { AppHeader } from "@/components/app-header";
import { useAction } from "@/components/use-action";
import type { TaskReferrers } from "@/lib/definitions/referrers";
import { cloneTaskDefinition, deleteTaskDefinition } from "../actions";
import { repositoryTaskRoles } from "../repository-roles";
import {
  BuiltinBadge,
  Fact,
  mono,
  NameList,
  pageMain,
  pageTitle,
  preBlock,
  stack,
} from "../../agents/agent-parts";
import { AgentLink, TASK_TYPE_LABELS, taskEditHref, taskHref, TriggerBadges } from "../task-parts";

interface TaskDetailViewProps {
  task: TaskDefinition;
  builtin: boolean;
  /** Null when the agent doesn't resolve. */
  agentName: string | null;
  /** Null when the task has no PR description task or it doesn't resolve. */
  prDescriptionTaskName: string | null;
  requirements: TaskRequirements;
  referrers: TaskReferrers;
  isAdmin: boolean;
}

const factGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: "var(--space-4)",
} as const;

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
  return value ? <Badge variant="outline">Yes</Badge> : <Muted>No</Muted>;
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
              <span style={mono}>{command.name}</span>
            </TableCell>
            <TableCell>
              <pre style={{ ...preBlock, padding: "var(--space-2)" }}>{command.command}</pre>
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
    <div style={stack}>
      {items.map((item) => (
        <div
          key={item.key}
          style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
        >
          <span style={{ fontSize: "var(--text-sm)" }}>{item.label}</span>
          <Muted style={{ fontSize: "var(--text-xs)" }}>{item.detail}</Muted>
        </div>
      ))}
    </div>
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
  const { pending, run } = useAction();

  const clone = () => {
    let cloneId: string | undefined;
    run(
      async () => {
        const result = await cloneTaskDefinition(task.id);
        if (result.ok && "id" in result) cloneId = result.id;
        return result;
      },
      `Cloned ${task.name}`,
      () => {
        if (cloneId) router.push(taskEditHref(cloneId));
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
            <Link href={taskEditHref(task.id)}>
              <IconPencil size={14} />
              Edit
            </Link>
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" disabled={pending}>
                <IconTrash size={14} />
                Delete
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
                <AlertDialogAction
                  onClick={() =>
                    run(
                      () => deleteTaskDefinition(task.id),
                      `Deleted ${task.name}`,
                      () => router.push("/settings/tasks"),
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

export function TaskDetailView({
  task,
  builtin,
  agentName,
  prDescriptionTaskName,
  requirements,
  referrers,
  isAdmin,
}: TaskDetailViewProps) {
  return (
    <>
      <AppHeader
        breadcrumbs={[
          { label: "Settings" },
          { label: "Tasks", href: "/settings/tasks" },
          { label: task.name },
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
              <h1 style={pageTitle}>{task.name}</h1>
              {builtin && <BuiltinBadge />}
            </div>
            <span style={{ ...mono, color: "var(--text-secondary)" }}>{task.id}</span>
            {task.description && (
              <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
                {task.description}
              </Muted>
            )}
          </div>
          {isAdmin && (
            <AdminActions
              task={task}
              builtin={builtin}
              inUse={Object.values(referrers).some((list) => list.length > 0)}
            />
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Overview</CardTitle>
          </CardHeader>
          <CardContent style={factGrid}>
            <Fact label="Task type">{TASK_TYPE_LABELS[task.taskType]}</Fact>
            <Fact label="Agent">
              <AgentLink id={task.agentId} name={agentName} />
            </Fact>
            <Fact label="Triggers">
              <TriggerBadges triggers={task.triggers} />
            </Fact>
            <Fact label="Sink">
              <span style={mono}>{task.sink}</span>
            </Fact>
            <Fact label="Pool">
              <Badge variant="outline">{task.pool}</Badge>
            </Fact>
            <Fact label="Model override">
              {task.model ? <span style={mono}>{task.model}</span> : <Muted>Agent model</Muted>}
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
            <CardTitle>Prompt template</CardTitle>
            <CardDescription>
              Rendered with the trigger&apos;s variables for each run.
            </CardDescription>
          </CardHeader>
          <CardContent style={stack}>
            <pre style={preBlock}>{task.promptTemplate}</pre>
            {task.systemAppend && (
              <Fact label="Appended to the agent's system prompt">
                <pre style={preBlock}>{task.systemAppend}</pre>
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
            <CardTitle>Commands</CardTitle>
            <CardDescription>
              Setup runs before the session (its output becomes setup.&lt;name&gt;); teardown runs
              after it, whatever happened.
            </CardDescription>
          </CardHeader>
          <CardContent style={stack}>
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
            <CardTitle>Tool settings</CardTitle>
            <CardDescription>Narrow the tools the agent wants.</CardDescription>
          </CardHeader>
          <CardContent style={factGrid}>
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
              <CardTitle>Output schema</CardTitle>
              <CardDescription>
                The JSON schema the session&apos;s output must match.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {task.outputSchema ? (
                <pre style={preBlock}>{JSON.stringify(task.outputSchema, null, 2)}</pre>
              ) : (
                <Muted>No output schema: the answer is free text.</Muted>
              )}
            </CardContent>
          </Card>
        )}

        {task.taskType === "coding" && (
          <Card>
            <CardHeader>
              <CardTitle>Coding</CardTitle>
              <CardDescription>How a coding run pushes, opens its PR and retries.</CardDescription>
            </CardHeader>
            <CardContent style={factGrid}>
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
              <Fact label="Iterations per run">{task.maxIterationsPerRun}</Fact>
              <Fact label="Review rounds (at most)">{task.maxReviewRounds}</Fact>
              <Fact label="Fix rounds (at most)">{task.maxFixRounds}</Fact>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Requirements</CardTitle>
            <CardDescription>
              What a run needs from the harness that claims it; only capable harnesses are offered
              it.
            </CardDescription>
          </CardHeader>
          <CardContent style={factGrid}>
            <Fact label="Minimum harness version">
              {requirements.minHarnessVersion ? (
                <span style={mono}>{requirements.minHarnessVersion}</span>
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
            <CardTitle>Used by</CardTitle>
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
