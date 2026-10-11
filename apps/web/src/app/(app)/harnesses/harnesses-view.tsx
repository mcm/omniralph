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
import type { HarnessRow } from "@/lib/harnesses/rows";
import { formatRelative } from "@/lib/format-date";
import {
  HarnessStatusBadge,
  HarnessVersionCell,
  CapabilityBadges,
  JobTargetLink,
  RepositoryBadges,
} from "./harness-parts";
import { EnrollHarnessDialog } from "./enroll-harness-dialog";

interface HarnessesViewProps {
  harnesses: HarnessRow[];
  /** When the page was rendered (ms since epoch), for relative times. */
  now: number;
}

const cellText = { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } as const;

function HarnessTableRow({
  harness,
  isAdmin,
  now,
}: {
  harness: HarnessRow;
  isAdmin: boolean;
  now: number;
}) {
  return (
    <TableRow>
      <TableCell>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
          {isAdmin ? (
            <Link
              href={`/harnesses/${harness.id}`}
              style={{ color: "var(--text-primary)", fontWeight: 500, textDecoration: "none" }}
            >
              {harness.name}
            </Link>
          ) : (
            <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{harness.name}</span>
          )}
          <HarnessStatusBadge harness={harness} />
        </div>
      </TableCell>
      <TableCell>
        <HarnessVersionCell harness={harness} />
      </TableCell>
      <TableCell>
        <CapabilityBadges
          reported={harness.reportedCapabilities}
          enabled={harness.enabledCapabilities}
        />
      </TableCell>
      <TableCell>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
          <span style={cellText}>
            {harness.runningJobs.length} / {harness.maxConcurrency}
          </span>
          {harness.runningJobs.map((job) => (
            <JobTargetLink key={job.id} job={job} />
          ))}
        </div>
      </TableCell>
      <TableCell>
        <RepositoryBadges repositories={harness.pinnedRepositories} />
      </TableCell>
      <TableCell>
        {harness.lastHeartbeatAt ? (
          <span style={cellText}>{formatRelative(harness.lastHeartbeatAt, now)}</span>
        ) : (
          <Muted>Never</Muted>
        )}
      </TableCell>
    </TableRow>
  );
}

export function HarnessesView({ harnesses, now }: HarnessesViewProps) {
  const isAdmin = useCurrentUser().role === "admin";
  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Harnesses" }]} />
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
            <h1 style={{ margin: 0, fontSize: "var(--text-2xl)", fontWeight: 600 }}>Harnesses</h1>
            <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
              Hosts running <InlineCode>omniralph-harness</InlineCode>. Their concurrency,
              capabilities and pinned repositories are configured here and reach them with their
              next heartbeat.
            </Muted>
          </div>
          {isAdmin && <EnrollHarnessDialog />}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Fleet</CardTitle>
            <CardDescription>
              A harness is online while its last heartbeat is less than 60 seconds old.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {harnesses.length === 0 ? (
              <Empty
                icon={<IconServer size={24} />}
                title="No harnesses yet"
                description={
                  isAdmin
                    ? "Enroll a harness on a Coder instance to start running jobs."
                    : "An admin hasn't enrolled any harnesses yet."
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Harness</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Capabilities</TableHead>
                    <TableHead>Running jobs</TableHead>
                    <TableHead>Pinned repositories</TableHead>
                    <TableHead>Last heartbeat</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {harnesses.map((harness) => (
                    <HarnessTableRow
                      key={harness.id}
                      harness={harness}
                      isAdmin={isAdmin}
                      now={now}
                    />
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
