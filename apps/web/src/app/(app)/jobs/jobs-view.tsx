"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  Muted,
  NativeSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconExternalLink, IconListCheck, IconX } from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { PageHeader } from "@/components/page-header";
import { useAction } from "@/components/use-action";
import type { JobRow } from "@/lib/harnesses/rows";
import { formatDateTime } from "@/lib/format-date";
import { JOB_STATUS_VARIANTS } from "@/lib/state-variants";
import { cancelJob } from "./actions";

type JobStatus = JobRow["status"];

interface JobsViewProps {
  jobs: JobRow[];
  /** The status filter, or null for all. */
  status: JobStatus | null;
  statuses: JobStatus[];
  limit: number;
}

const cellText = { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } as const;
const mono = { fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" } as const;

export function isCancelable(job: Pick<JobRow, "status" | "cancelRequested">): boolean {
  return job.status === "queued" || (job.status === "running" && !job.cancelRequested);
}

function JobTableRow({ job, isAdmin }: { job: JobRow; isAdmin: boolean }) {
  const { pending, run } = useAction();
  return (
    // Target of the job links on the Ralph run pages.
    <TableRow id={`job-${job.id}`}>
      <TableCell>
        <Badge variant="neutral">{job.taskType}</Badge>
      </TableCell>
      <TableCell>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
          <span style={{ ...mono, color: "var(--text-primary)" }}>{job.type}</span>
          {job.target &&
            (job.target.url ? (
              <a
                href={job.target.url}
                target="_blank"
                rel="noreferrer"
                style={{
                  ...mono,
                  color: "var(--text-secondary)",
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--space-1)",
                }}
              >
                {job.target.label}
                <IconExternalLink size={12} />
              </a>
            ) : (
              <span style={{ ...mono, color: "var(--text-secondary)" }}>{job.target.label}</span>
            ))}
        </div>
      </TableCell>
      <TableCell>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
          <Badge variant={JOB_STATUS_VARIANTS[job.status]} dot>
            {job.status}
            {job.status === "running" && job.cancelRequested ? " (canceling)" : ""}
          </Badge>
          {job.error && (
            <Muted title={job.error} style={{ maxWidth: "calc(var(--space-8) * 10)" }}>
              {job.error.length > 80 ? `${job.error.slice(0, 80)}…` : job.error}
            </Muted>
          )}
        </div>
      </TableCell>
      <TableCell>
        <span style={cellText}>{job.deliveryCount}</span>
      </TableCell>
      <TableCell>
        {job.agent ? (
          isAdmin ? (
            <Link
              href={`/harnesses/${job.agent.id}`}
              style={{ ...cellText, color: "var(--text-primary)", textDecoration: "none" }}
            >
              {job.agent.name}
            </Link>
          ) : (
            <span style={cellText}>{job.agent.name}</span>
          )
        ) : (
          <Muted>—</Muted>
        )}
      </TableCell>
      <TableCell>
        <span style={cellText}>{formatDateTime(job.createdAt)}</span>
      </TableCell>
      <TableCell>
        {job.finishedAt ? (
          <span style={cellText}>{formatDateTime(job.finishedAt)}</span>
        ) : (
          <Muted>—</Muted>
        )}
      </TableCell>
      {isAdmin && (
        <TableCell style={{ textAlign: "right" }}>
          {isCancelable(job) && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="ghost" disabled={pending}>
                  <IconX size={14} />
                  Cancel
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Cancel this {job.type} job?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {job.status === "queued"
                      ? "It won't run: harnesses skip it when its message arrives."
                      : "Its agent stops it after its next heartbeat (within about 20 seconds)."}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction
                    variant="danger"
                    onClick={() => run(() => cancelJob(job.id), "Job canceled")}
                  >
                    Cancel job
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </TableCell>
      )}
    </TableRow>
  );
}

export function JobsView({ jobs, status, statuses, limit }: JobsViewProps) {
  const isAdmin = useCurrentUser().role === "admin";
  const router = useRouter();
  const pathname = usePathname();

  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Jobs" }]} />
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-8)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-6)",
        }}
      >
        <PageHeader title="Jobs" description="Queued, running and finished jobs of every type." />

        <Card>
          <CardHeader>
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: "var(--space-4)",
              }}
            >
              <div>
                <CardTitle as="h2">Recent jobs</CardTitle>
                <CardDescription>The {limit} most recent jobs, newest first.</CardDescription>
              </div>
              <NativeSelect
                aria-label="Filter by status"
                value={status ?? ""}
                onChange={(e) =>
                  router.push(
                    e.target.value
                      ? `${pathname}?status=${encodeURIComponent(e.target.value)}`
                      : pathname,
                  )
                }
              >
                <option value="">All statuses</option>
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </CardHeader>
          <CardContent>
            {jobs.length === 0 ? (
              <Empty
                icon={<IconListCheck size={24} />}
                title={status ? `No ${status} jobs` : "No jobs yet"}
                titleAs="h3"
                description="Jobs appear here when reviews are triggered or repositories are pinned."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Task type</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Deliveries</TableHead>
                    <TableHead>Harness</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Finished</TableHead>
                    {isAdmin && <TableHead aria-label="Actions" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => (
                    <JobTableRow key={job.id} job={job} isAdmin={isAdmin} />
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
