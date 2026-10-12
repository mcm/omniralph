"use client";

import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Muted,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconPlus } from "@tabler/icons-react";
import { TASK_TYPES, type PoolName, type SinkKind, type TaskType } from "@omniralph/tasks";
import { AppHeader } from "@/components/app-header";
import { PageHeader } from "@/components/page-header";
import { BuiltinBadge } from "../agents/agent-parts";
import { AgentLink, TASK_TYPE_LABELS, taskHref, TriggerBadges } from "./task-parts";

export interface TaskSummary {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  taskType: TaskType;
  agentId: string;
  /** Null when the agent doesn't resolve. */
  agentName: string | null;
  triggers: string[];
  sink: SinkKind;
  pool: PoolName;
}

interface TasksViewProps {
  tasks: TaskSummary[];
  isAdmin: boolean;
}

const TASK_TYPE_DESCRIPTIONS: Record<TaskType, string> = {
  query: "One session that answers or writes something, no code changes.",
  review: "Review a pull or merge request and report findings.",
  coding: "Change code on a branch and open a pull request.",
};

function TaskTable({ tasks }: { tasks: TaskSummary[] }) {
  if (tasks.length === 0) return <Muted>No tasks of this type.</Muted>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>ID</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Triggers</TableHead>
          <TableHead>Sink</TableHead>
          <TableHead>Pool</TableHead>
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
            </TableCell>
            <TableCell>
              <span className="font-mono text-xs text-text-secondary">{task.id}</span>
            </TableCell>
            <TableCell>
              <AgentLink id={task.agentId} name={task.agentName} />
            </TableCell>
            <TableCell>
              <TriggerBadges triggers={task.triggers} />
            </TableCell>
            <TableCell>
              <span className="font-mono text-xs">{task.sink}</span>
            </TableCell>
            <TableCell>
              <Badge variant="neutral">{task.pool}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function TasksView({ tasks, isAdmin }: TasksViewProps) {
  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Tasks" }]} />
      <main className="detail-main">
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
        {TASK_TYPES.map((taskType) => (
          <Card key={taskType} aria-label={`${TASK_TYPE_LABELS[taskType]} tasks`}>
            <CardHeader>
              <CardTitle as="h2">{TASK_TYPE_LABELS[taskType]}</CardTitle>
              <CardDescription>{TASK_TYPE_DESCRIPTIONS[taskType]}</CardDescription>
            </CardHeader>
            <CardContent>
              <TaskTable tasks={tasks.filter((task) => task.taskType === taskType)} />
            </CardContent>
          </Card>
        ))}
      </main>
    </>
  );
}
