"use client";

import { Link } from "@/components/link";
import {
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
import { AppHeader } from "@/components/app-header";
import { PhoneMeta, WIDE_COLUMN } from "@/components/list-table";
import { MonoValue } from "@/components/mono-value";
import { PageHeader } from "@/components/page-header";
import { QueryBoundary } from "@/components/query-boundary";
import type { AgentSummary } from "@/lib/api/definitions";
import { useIsAdmin } from "../definition-page";
import { useAgentList } from "../definition-queries";
import { agentHref, BuiltinBadge, ModelName } from "./agent-parts";

export type { AgentSummary };

/** The agents table while it loads, shaped like it. */
function AgentsSkeleton() {
  return (
    <Stack gap={3}>
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </Stack>
  );
}

/**
 * The organization's agent definitions, live: built-ins first, then its own. Every member
 * may look; an agent created, changed or deleted elsewhere shows without a reload.
 */
export function AgentsView() {
  const isAdmin = useIsAdmin();
  const query = useAgentList();
  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Agents" }]} />
      <div className="detail-main">
        <PageHeader
          title="Agents"
          description={
            <>
              The personas tasks run on: system prompt, tools and model. Built-in agents are
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
            <QueryBoundary query={query} skeleton={<AgentsSkeleton />} what="the agents">
              {({ agents }) => <AgentsTable agents={agents} />}
            </QueryBoundary>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

/** One row per agent: name, ID, task types and model. */
export function AgentsTable({ agents }: { agents: AgentSummary[] }) {
  return (
    <Table className="list-table">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead className={WIDE_COLUMN}>ID</TableHead>
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
                {agent.description && <Muted className="text-xs">{agent.description}</Muted>}
              </Stack>
              <PhoneMeta>
                <ModelName model={agent.model} />
              </PhoneMeta>
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <MonoValue value={agent.id} className="text-xs text-text-secondary" />
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <ModelName model={agent.model} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
