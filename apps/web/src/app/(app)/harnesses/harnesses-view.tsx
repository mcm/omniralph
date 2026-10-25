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
import { harnessListSchema } from "@/lib/api/harnesses";
import type { HarnessRow } from "@/lib/harnesses/rows";
import {
  HarnessStatusBadge,
  HarnessVersion,
  formatPoolLimits,
  JobTargetLink,
  RepositoryBadges,
  TaskTypeBadges,
  UpdateStatusBadge,
  withClientOnline,
} from "./harness-parts";
import { EnrollHarnessDialog } from "./enroll-harness-dialog";

/** The organization's harnesses, live (`GET /api/ui/harnesses`). */
export function useHarnessList() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.harnesses.list(),
    queryFn: ({ signal }) =>
      api.get("/api/ui/harnesses", harnessListSchema, { organizationId: organization.id, signal }),
  });
}

/** The last heartbeat, relative to the browser's ticking clock. */
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

function FleetTable({ harnesses, isAdmin }: { harnesses: HarnessRow[]; isAdmin: boolean }) {
  const now = useNow();
  if (harnesses.length === 0) {
    return (
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
    );
  }
  return (
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
            harness={withClientOnline(harness, now)}
            isAdmin={isAdmin}
            now={now}
          />
        ))}
      </TableBody>
    </Table>
  );
}

export function HarnessesView() {
  const isAdmin = useCurrentUser().role === "admin";
  const harnesses = useHarnessList();
  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Harnesses" }]} />
      <div className="detail-main">
        <PageHeader
          title="Harnesses"
          description={
            <>
              Hosts running <InlineCode>omniralph-harness</InlineCode>. Their concurrency, accepted
              task types, pool limits and pinned repositories are configured here and reach them
              with their next heartbeat.
            </>
          }
          meta={<Freshness query={harnesses} />}
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
            <QueryBoundary query={harnesses} skeleton={<FleetSkeleton />} what="harnesses">
              {(data) => <FleetTable harnesses={data.harnesses} isAdmin={isAdmin} />}
            </QueryBoundary>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
