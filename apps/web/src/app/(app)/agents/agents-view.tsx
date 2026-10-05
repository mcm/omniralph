"use client";

import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  InlineCode,
  Muted,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconServer } from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import type { AgentRow } from "@/lib/agents/rows";
import { formatRelative } from "@/lib/format-date";
import { AgentStatusBadge, CapabilityBadges, JobTargetLink, RepositoryBadges } from "./agent-parts";
import { EnrollAgentDialog } from "./enroll-agent-dialog";

interface AgentsViewProps {
  agents: AgentRow[];
  /** When the page was rendered (ms since epoch), for relative times. */
  now: number;
}

const cellText = { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } as const;

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
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
          {isAdmin ? (
            <Link
              href={`/agents/${agent.id}`}
              style={{ color: "var(--text-primary)", fontWeight: 500, textDecoration: "none" }}
            >
              {agent.name}
            </Link>
          ) : (
            <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{agent.name}</span>
          )}
          <AgentStatusBadge agent={agent} />
        </div>
      </TableCell>
      <TableCell>
        {agent.version ? (
          <span style={{ ...cellText, fontFamily: "var(--font-mono)" }}>{agent.version}</span>
        ) : (
          <Muted>Unknown</Muted>
        )}
      </TableCell>
      <TableCell>
        <CapabilityBadges
          reported={agent.reportedCapabilities}
          enabled={agent.enabledCapabilities}
        />
      </TableCell>
      <TableCell>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
          <span style={cellText}>
            {agent.runningJobs.length} / {agent.maxConcurrency}
          </span>
          {agent.runningJobs.map((job) => (
            <JobTargetLink key={job.id} job={job} />
          ))}
        </div>
      </TableCell>
      <TableCell>
        <RepositoryBadges repositories={agent.pinnedRepositories} />
      </TableCell>
      <TableCell>
        {agent.lastHeartbeatAt ? (
          <span style={cellText}>{formatRelative(agent.lastHeartbeatAt, now)}</span>
        ) : (
          <Muted>Never</Muted>
        )}
      </TableCell>
    </TableRow>
  );
}

export function AgentsView({ agents, now }: AgentsViewProps) {
  const isAdmin = useCurrentUser().role === "admin";
  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Agents" }]} />
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-6)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-4)" }}>
          <div style={{ flex: 1 }}>
            <h1 style={{ margin: 0, fontSize: "var(--text-2xl)", fontWeight: 600 }}>Agents</h1>
            <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
              Hosts running <InlineCode>omniralph-agent</InlineCode>. Their concurrency, poll
              interval, capabilities and pinned repositories are configured here and reach them with
              their next heartbeat.
            </Muted>
          </div>
          {isAdmin && <EnrollAgentDialog />}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Fleet</CardTitle>
            <CardDescription>
              An agent is online while its last heartbeat is less than 60 seconds old.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {agents.length === 0 ? (
              <Empty
                icon={<IconServer size={24} />}
                title="No agents yet"
                description={
                  isAdmin
                    ? "Enroll an agent on a Coder instance to start running jobs."
                    : "An admin hasn't enrolled any agents yet."
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Capabilities</TableHead>
                    <TableHead>Running jobs</TableHead>
                    <TableHead>Pinned repositories</TableHead>
                    <TableHead>Last heartbeat</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agents.map((agent) => (
                    <AgentTableRow key={agent.id} agent={agent} isAdmin={isAdmin} now={now} />
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>
    </>
  );
}
