"use client";

import { Link } from "@/components/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  InlineCode,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconServer } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { Freshness } from "@/components/freshness";
import { PhoneMeta, Timestamp, WIDE_COLUMN } from "@/components/list-table";
import { PageHeader } from "@/components/page-header";
import { QueryBoundary } from "@/components/query-boundary";
import { useQueryKeys } from "@/components/query-provider";
import { useNow } from "@/components/relative-time";
import { api } from "@/lib/api/client";
import { agentListSchema } from "@/lib/api/agents";
import type { AgentRow } from "@/lib/agents/rows";
import {
  AgentStatusBadge,
  AgentVersion,
  formatPoolLimits,
  JobTargetLink,
  RepositoryBadges,
  TaskTypeBadges,
  UpdateStatusBadge,
  withClientOnline,
} from "./agent-parts";
import { EnrollAgentDialog } from "./enroll-agent-dialog";

/** The organization's agents, live (`GET /api/ui/agents`). */
export function useAgentList() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.agents.list(),
    queryFn: ({ signal }) =>
      api.get("/api/ui/agents", agentListSchema, { organizationId: organization.id, signal }),
  });
}

/** The last heartbeat, relative to the browser's ticking clock. */
function Heartbeat({ agent, now }: { agent: AgentRow; now: number }) {
  return agent.lastHeartbeatAt ? (
    <Timestamp iso={agent.lastHeartbeatAt} now={now} />
  ) : (
    <span className="list-time">No heartbeat yet</span>
  );
}

function AgentTableRow({
  agent,
  isAdmin,
  now,
}: {
  agent: AgentRow;
  isAdmin: boolean;
  now: number;
}) {
  return (
    <TableRow>
      <TableCell>
        <div className="list-cell-stack">
          {isAdmin ? (
            <Link href={`/agents/${agent.id}`} className="list-title font-medium">
              {agent.name}
            </Link>
          ) : (
            <span className="list-title font-medium">{agent.name}</span>
          )}
          <span className="list-label-wide">
            <AgentStatusBadge agent={agent} />
          </span>
        </div>
        <PhoneMeta>
          <AgentStatusBadge agent={agent} />
          {!agent.revoked && <UpdateStatusBadge agent={agent} />}
          <Heartbeat agent={agent} now={now} />
        </PhoneMeta>
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <div className="list-cell-stack">
          <AgentVersion agent={agent} />
          {!agent.revoked && <UpdateStatusBadge agent={agent} />}
        </div>
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <TaskTypeBadges accepted={agent.acceptedTaskTypes} />
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <div className="list-cell-stack">
          <span className="list-text text-numeric list-nowrap">
            {agent.runningJobs.length} / {agent.maxConcurrency}
          </span>
          <span className="list-secondary">
            Pools: {formatPoolLimits(agent.effectivePoolLimits)}
          </span>
          {agent.runningJobs.map((job) => (
            <JobTargetLink key={job.id} job={job} />
          ))}
        </div>
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <RepositoryBadges repositories={agent.pinnedRepositories} />
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <Heartbeat agent={agent} now={now} />
      </TableCell>
    </TableRow>
  );
}

const SKELETON_ROWS = 3;

/** The fleet table while it first loads: a title, a status and the wide columns per row. */
function FleetSkeleton() {
  return (
    <Table className="list-table">
      <TableBody>
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <TableRow key={index}>
            <TableCell>
              <div className="list-cell-stack">
                <Skeleton width={`${50 + ((index * 17) % 30)}%`} />
                <Skeleton width={16} height="1.25rem" radius="full" />
              </div>
            </TableCell>
            {Array.from({ length: 5 }, (_, column) => (
              <TableCell key={column} className={WIDE_COLUMN}>
                <Skeleton width={`${45 + (((index + column) * 13) % 40)}%`} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function FleetTable({ agents, isAdmin }: { agents: AgentRow[]; isAdmin: boolean }) {
  const now = useNow();
  if (agents.length === 0) {
    return (
      <Empty
        icon={<IconServer size={24} />}
        title="No agents yet"
        titleAs="h3"
        description={
          isAdmin
            ? "Enroll an agent on a Coder instance to start running jobs."
            : "An admin hasn't enrolled any agents yet."
        }
      />
    );
  }
  return (
    <Table className="list-table">
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead className={WIDE_COLUMN}>Version</TableHead>
          <TableHead className={WIDE_COLUMN}>Task types</TableHead>
          <TableHead className={WIDE_COLUMN}>Running jobs</TableHead>
          <TableHead className={WIDE_COLUMN}>Pinned repositories</TableHead>
          <TableHead className={WIDE_COLUMN}>Last heartbeat</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((agent) => (
          <AgentTableRow
            key={agent.id}
            agent={withClientOnline(agent, now)}
            isAdmin={isAdmin}
            now={now}
          />
        ))}
      </TableBody>
    </Table>
  );
}

export function AgentsView() {
  const isAdmin = useCurrentUser().role === "admin";
  const agents = useAgentList();
  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Agents" }]} />
      <div className="detail-main">
        <PageHeader
          title="Agents"
          description={
            <>
              Hosts running <InlineCode>omniralph-agent</InlineCode>. Their concurrency and pool
              limits are configured here and reach them with their next heartbeat. Each host sets
              the task types it runs in its own config.
            </>
          }
          meta={<Freshness query={agents} />}
          actions={isAdmin && <EnrollAgentDialog />}
        />

        <Card>
          <CardHeader>
            <CardTitle as="h2">Fleet</CardTitle>
            <CardDescription>
              An agent is online while its last heartbeat is less than 60 seconds old.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <QueryBoundary query={agents} skeleton={<FleetSkeleton />} what="agents">
              {(data) => <FleetTable agents={data.agents} isAdmin={isAdmin} />}
            </QueryBoundary>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
