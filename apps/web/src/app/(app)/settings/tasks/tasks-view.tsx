"use client";

import { Link } from "@/components/link";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Muted,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconPlus } from "@tabler/icons-react";
import { TASK_TYPES, type TaskType } from "@omniralph/tasks";
import { AppHeader } from "@/components/app-header";
import { PhoneMeta, WIDE_COLUMN } from "@/components/list-table";
import { MonoValue } from "@/components/mono-value";
import { PageHeader } from "@/components/page-header";
import { QueryBoundary } from "@/components/query-boundary";
import type { TaskSummary } from "@/lib/api/definitions";
import { BuiltinBadge } from "../agents/agent-parts";
import { useIsAdmin } from "../definition-page";
import { useTaskList } from "../definition-queries";
import { AgentLink, TASK_TYPE_LABELS, taskHref, TriggerBadges } from "./task-parts";

export type { TaskSummary };

const TASK_TYPE_DESCRIPTIONS: Record<TaskType, string> = {
  query: "One session that answers or writes something, no code changes.",
  review: "Review a pull or merge request and report findings.",
  coding: "Change code on a branch and open a pull request.",
};

function TaskTable({ tasks }: { tasks: TaskSummary[] }) {
  if (tasks.length === 0) return <Muted>No tasks of this type.</Muted>;
  return (
    <Table className="list-table">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead className={WIDE_COLUMN}>ID</TableHead>
          <TableHead className={WIDE_COLUMN}>Agent</TableHead>
          <TableHead className={WIDE_COLUMN}>Triggers</TableHead>
          <TableHead className={WIDE_COLUMN}>Sink</TableHead>
          <TableHead className={WIDE_COLUMN}>Pool</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tasks.map((task) => (
          <TableRow key={task.id}>
            <TableCell>
              <Stack gap={1}>
                <div className="definition-name-row">
                  <Link href={taskHref(task.id)} className="text-sm text-text-primary">
                    {task.name}
                  </Link>
                  {task.builtin && <BuiltinBadge />}
                </div>
                {task.description && <Muted className="text-xs">{task.description}</Muted>}
              </Stack>
              <PhoneMeta>
                <AgentLink id={task.agentId} name={task.agentName} className="list-secondary" />
                <TriggerBadges triggers={task.triggers} />
                <MonoValue value={task.sink} className="text-xs" />
                <Badge variant="neutral">{task.pool}</Badge>
              </PhoneMeta>
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <MonoValue value={task.id} className="text-xs text-text-secondary" />
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <AgentLink id={task.agentId} name={task.agentName} />
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <TriggerBadges triggers={task.triggers} />
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <MonoValue value={task.sink} className="text-xs" />
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <Badge variant="neutral">{task.pool}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The task cards while they load, shaped like them. */
function TasksSkeleton() {
  return (
    <Stack gap={6}>
      {TASK_TYPES.map((taskType) => (
        <Card key={taskType}>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-2/3" />
          </CardHeader>
          <Stack gap={3} asChild>
            <CardContent>
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </CardContent>
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}

/** One card per task type, each listing the organization's tasks of the type. */
export function TaskCards({ tasks }: { tasks: TaskSummary[] }) {
  return TASK_TYPES.map((taskType) => (
    <Card key={taskType} aria-label={`${TASK_TYPE_LABELS[taskType]} tasks`}>
      <CardHeader>
        <CardTitle as="h2">{TASK_TYPE_LABELS[taskType]}</CardTitle>
        <CardDescription>{TASK_TYPE_DESCRIPTIONS[taskType]}</CardDescription>
      </CardHeader>
      <CardContent>
        <TaskTable tasks={tasks.filter((task) => task.taskType === taskType)} />
      </CardContent>
    </Card>
  ));
}

/**
 * The organization's task definitions grouped by task type, live. Every member may look; a
 * task created, changed or deleted elsewhere shows without a reload.
 */
export function TasksView() {
  const isAdmin = useIsAdmin();
  const query = useTaskList();
  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Tasks" }]} />
      <div className="detail-main">
        <PageHeader
          title="Tasks"
          description={
            <>
              What runs on which trigger: each task runs one agent with its prompt template, tool
              settings and sink. Built-in tasks are read-only
              {isAdmin
                ? "; clone one or create a new task to make your own."
                : "; an admin can clone one to customize it."}
            </>
          }
          actions={
            isAdmin && (
              <Button asChild variant="primary">
                <Link href="/settings/tasks/new">
                  <IconPlus size={14} />
                  New task
                </Link>
              </Button>
            )
          }
        />
        <QueryBoundary query={query} skeleton={<TasksSkeleton />} what="the tasks">
          {({ tasks }) => <TaskCards tasks={tasks} />}
        </QueryBoundary>
      </div>
    </>
  );
}
