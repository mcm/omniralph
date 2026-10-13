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
import { PhoneMeta, Timestamp, WIDE_COLUMN } from "@/components/list-table";
import { PageHeader } from "@/components/page-header";
import type { HarnessRow } from "@/lib/harnesses/rows";
import {
  HarnessStatusBadge,
  HarnessVersion,
  formatPoolLimits,
  JobTargetLink,
  RepositoryBadges,
  TaskTypeBadges,
  UpdateStatusBadge,
} from "./harness-parts";
import { EnrollHarnessDialog } from "./enroll-harness-dialog";

interface HarnessesViewProps {
  harnesses: HarnessRow[];
  /** When the page was rendered (ms since epoch), for relative times. */
  now: number;
}

/** The last heartbeat, relative to the render time. */
function Heartbeat({ harness, now }: { harness: HarnessRow; now: number }) {
  return harness.lastHeartbeatAt ? (
    <Timestamp iso={harness.lastHeartbeatAt} now={now} />
  ) : (
    <span className="list-time">No heartbeat yet</span>
  );
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
        <div className="list-cell-stack">
          {isAdmin ? (
            <Link href={`/harnesses/${harness.id}`} className="list-title font-medium">
              {harness.name}
            </Link>
          ) : (
            <span className="list-title font-medium">{harness.name}</span>
          )}
          <span className="list-label-wide">
            <HarnessStatusBadge harness={harness} />
          </span>
        </div>
        <PhoneMeta>
          <HarnessStatusBadge harness={harness} />
          {!harness.revoked && <UpdateStatusBadge harness={harness} />}
          <Heartbeat harness={harness} now={now} />
        </PhoneMeta>
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <div className="list-cell-stack">
          <HarnessVersion harness={harness} />
          {!harness.revoked && <UpdateStatusBadge harness={harness} />}
        </div>
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <TaskTypeBadges accepted={harness.acceptedTaskTypes} />
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <div className="list-cell-stack">
          <span className="list-text text-numeric list-nowrap">
            {harness.runningJobs.length} / {harness.maxConcurrency}
          </span>
          <span className="list-secondary">
            Pools: {formatPoolLimits(harness.effectivePoolLimits)}
          </span>
          {harness.runningJobs.map((job) => (
            <JobTargetLink key={job.id} job={job} />
          ))}
        </div>
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <RepositoryBadges repositories={harness.pinnedRepositories} />
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <Heartbeat harness={harness} now={now} />
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
              <Table className="list-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Harness</TableHead>
                    <TableHead className={WIDE_COLUMN}>Version</TableHead>
                    <TableHead className={WIDE_COLUMN}>Task types</TableHead>
                    <TableHead className={WIDE_COLUMN}>Running jobs</TableHead>
                    <TableHead className={WIDE_COLUMN}>Pinned repositories</TableHead>
                    <TableHead className={WIDE_COLUMN}>Last heartbeat</TableHead>
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
