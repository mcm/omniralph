"use client";

import Link from "next/link";
import {
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
import type { TaskType } from "@omniralph/tasks";
import { AppHeader } from "@/components/app-header";
import { PhoneMeta, WIDE_COLUMN } from "@/components/list-table";
import { MonoValue } from "@/components/mono-value";
import { PageHeader } from "@/components/page-header";
import { agentHref, BuiltinBadge, ModelName, TaskTypeBadges } from "./agent-parts";

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  taskTypes: TaskType[];
  model: string | null;
}

interface AgentsViewProps {
  agents: AgentSummary[];
  isAdmin: boolean;
}

export function AgentsView({ agents, isAdmin }: AgentsViewProps) {
  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Agents" }]} />
      <main className="detail-main">
        <PageHeader
          title="Agents"
          description={
            <>
              The personas tasks run on: system prompt, tools, skills and model. Built-in agents are
              read-only
              {isAdmin
                ? "; clone one or create a new agent to make your own."
                : "; an admin can clone one to customize it."}
            </>
          }
          actions={
            isAdmin && (
              <Button asChild variant="primary">
                <Link href="/settings/agents/new">
                  <IconPlus size={14} />
                  New agent
                </Link>
              </Button>
            )
          }
        />
        <Card>
          <CardHeader>
            <CardTitle as="h2">Agent definitions</CardTitle>
            <CardDescription>Built-in agents first, then your organization&apos;s.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table className="list-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className={WIDE_COLUMN}>ID</TableHead>
                  <TableHead className={WIDE_COLUMN}>Task types</TableHead>
                  <TableHead className={WIDE_COLUMN}>Model</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell>
                      <Stack gap={1}>
                        <div className="definition-name-row">
                          <Link href={agentHref(agent.id)} className="text-sm text-text-primary">
                            {agent.name}
                          </Link>
                          {agent.builtin && <BuiltinBadge />}
                        </div>
                        {agent.description && (
                          <Muted className="text-xs">{agent.description}</Muted>
                        )}
                      </Stack>
                      <PhoneMeta>
                        <TaskTypeBadges taskTypes={agent.taskTypes} />
                        <ModelName model={agent.model} />
                      </PhoneMeta>
                    </TableCell>
                    <TableCell className={WIDE_COLUMN}>
                      <MonoValue value={agent.id} className="text-xs text-text-secondary" />
                    </TableCell>
                    <TableCell className={WIDE_COLUMN}>
                      <TaskTypeBadges taskTypes={agent.taskTypes} />
                    </TableCell>
                    <TableCell className={WIDE_COLUMN}>
                      <ModelName model={agent.model} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
