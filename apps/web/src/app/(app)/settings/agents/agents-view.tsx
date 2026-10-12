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
import {
  agentHref,
  BuiltinBadge,
  ModelName,
  mono,
  pageMain,
  pageTitle,
  TaskTypeBadges,
} from "./agent-parts";

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
      <AppHeader breadcrumbs={[{ label: "Settings" }, { label: "Agents" }]} />
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
            <h1 style={pageTitle}>Agents</h1>
            <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
              The personas tasks run on: system prompt, tools, skills and model. Built-in agents are
              read-only
              {isAdmin
                ? "; clone one or create a new agent to make your own."
                : "; an admin can clone one to customize it."}
            </Muted>
          </div>
          {isAdmin && (
            <Button asChild variant="primary">
              <Link href="/settings/agents/new">
                <IconPlus size={14} />
                New agent
              </Link>
            </Button>
          )}
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Agent definitions</CardTitle>
            <CardDescription>Built-in agents first, then your organization&apos;s.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>Task types</TableHead>
                  <TableHead>Model</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell>
                      <div
                        style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}
                      >
                        <div
                          style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
                        >
                          <Link
                            href={agentHref(agent.id)}
                            style={{ color: "var(--text-primary)", fontSize: "var(--text-sm)" }}
                          >
                            {agent.name}
                          </Link>
                          {agent.builtin && <BuiltinBadge />}
                        </div>
                        {agent.description && (
                          <Muted style={{ fontSize: "var(--text-xs)" }}>{agent.description}</Muted>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span style={{ ...mono, color: "var(--text-secondary)" }}>{agent.id}</span>
                    </TableCell>
                    <TableCell>
                      <TaskTypeBadges taskTypes={agent.taskTypes} />
                    </TableCell>
                    <TableCell>
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
