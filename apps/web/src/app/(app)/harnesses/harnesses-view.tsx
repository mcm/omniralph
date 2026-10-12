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
  Stack,
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
import { PageHeader } from "@/components/page-header";
import type { HarnessRow } from "@/lib/harnesses/rows";
import { formatRelative } from "@/lib/format-date";
import {
  HarnessStatusBadge,
  HarnessVersionCell,
  formatPoolLimits,
  JobTargetLink,
  RepositoryBadges,
  TaskTypeBadges,
} from "./harness-parts";
import { EnrollHarnessDialog } from "./enroll-harness-dialog";

interface HarnessesViewProps {
  harnesses: HarnessRow[];
  /** When the page was rendered (ms since epoch), for relative times. */
  now: number;
}

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
        <Stack gap={1}>
          {isAdmin ? (
            <Link href={`/harnesses/${harness.id}`} className="list-text-primary font-medium">
              {harness.name}
            </Link>
          ) : (
            <span className="text-text-primary font-medium">{harness.name}</span>
          )}
          <HarnessStatusBadge harness={harness} />
        </Stack>
      </TableCell>
      <TableCell>
        <HarnessVersionCell harness={harness} />
      </TableCell>
      <TableCell>
        <TaskTypeBadges accepted={harness.acceptedTaskTypes} />
      </TableCell>
      <TableCell>
        <Stack gap={1}>
          <span className="list-text">
            {harness.runningJobs.length} / {harness.maxConcurrency}
          </span>
          <Muted>Pools: {formatPoolLimits(harness.effectivePoolLimits)}</Muted>
          {harness.runningJobs.map((job) => (
            <JobTargetLink key={job.id} job={job} />
          ))}
        </Stack>
      </TableCell>
      <TableCell>
        <RepositoryBadges repositories={harness.pinnedRepositories} />
      </TableCell>
      <TableCell>
        {harness.lastHeartbeatAt ? (
          <span className="list-text">{formatRelative(harness.lastHeartbeatAt, now)}</span>
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
      <main className="detail-main">
        <PageHeader
          title="Harnesses"
          description={
            <>
              Hosts running <InlineCode>omniralph-harness</InlineCode>. Their concurrency, accepted
              task types, pool limits and pinned repositories are configured here and reach them
              with their next heartbeat.
            </>
          }
          actions={isAdmin && <EnrollHarnessDialog />}
        />

        <Card>
          <CardHeader>
            <CardTitle as="h2">Fleet</CardTitle>
            <CardDescription>
              A harness is online while its last heartbeat is less than 60 seconds old.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {harnesses.length === 0 ? (
              <Empty
                icon={<IconServer size={24} />}
                title="No harnesses yet"
                titleAs="h3"
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
                    <TableHead>Task types</TableHead>
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
