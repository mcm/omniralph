"use client";

import * as React from "react";
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
import { ListPagination } from "@/components/list-pagination";
import { PhoneMeta, Timestamp, WIDE_COLUMN } from "@/components/list-table";
import { PageHeader } from "@/components/page-header";
import { useAction } from "@/components/use-action";
import type { JobRow } from "@/lib/harnesses/rows";
import { jobIdFromHash, jobListHref, jobPageHref, shortJobId } from "@/lib/jobs/list";
import { pageRange, totalPages } from "@/lib/pagination";
import { JOB_STATUS_VARIANTS } from "@/lib/state-variants";
import { cancelJob } from "./actions";

type JobStatus = JobRow["status"];

interface JobsViewProps {
  jobs: JobRow[];
  /** The status filter, or null for all. */
  status: JobStatus | null;
  statuses: JobStatus[];
  /** 1-based. */
  page: number;
  pageSize: number;
  /** Matching jobs across all pages. */
  total: number;
  /** The job a `?job=<id>` link opened this page for. */
  targetJobId: string | null;
}

export function isCancelable(job: Pick<JobRow, "status" | "cancelRequested">): boolean {
  return job.status === "queued" || (job.status === "running" && !job.cancelRequested);
}

function JobStatusBadge({ job }: { job: JobRow }) {
  return (
    <Badge variant={JOB_STATUS_VARIANTS[job.status]} dot>
      {job.status}
      {job.status === "running" && job.cancelRequested ? " (canceling)" : ""}
    </Badge>
  );
}

function JobTableRow({
  job,
  isAdmin,
  targeted,
}: {
  job: JobRow;
  isAdmin: boolean;
  targeted: boolean;
}) {
  const { pending, run } = useAction();
  return (
    // Target of the job links on the Ralph run pages and in chat (`#job-<id>`).
    <TableRow
      id={`job-${job.id}`}
      className="job-row"
      data-targeted={targeted || undefined}
      aria-current={targeted || undefined}
    >
      <TableCell>
        <a
          href={`#job-${job.id}`}
          className="list-title text-numeric list-nowrap"
          title={job.id}
          aria-label={`Job ${job.id}`}
        >
          {shortJobId(job.id)}
        </a>
        <PhoneMeta>
          <span className="list-time text-numeric">{job.type}</span>
          <JobStatusBadge job={job} />
          <Timestamp iso={job.finishedAt ?? job.createdAt} />
        </PhoneMeta>
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <div className="list-cell-stack">
          <span className="list-filters">
            <span className="list-time list-text-primary text-numeric">{job.type}</span>
            <Badge variant="neutral">{job.taskType}</Badge>
          </span>
          {job.target &&
            (job.target.url ? (
              <a
                href={job.target.url}
                target="_blank"
                rel="noreferrer"
                className="list-secondary text-numeric"
                aria-label={`Open ${job.target.label} on the code host`}
              >
                {job.target.label}
                <IconExternalLink size={12} />
              </a>
            ) : (
              <span className="list-secondary text-numeric">{job.target.label}</span>
            ))}
        </div>
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <div className="list-cell-stack">
          <JobStatusBadge job={job} />
          {job.error && (
            <Muted title={job.error} className="list-error">
              {job.error.length > 80 ? `${job.error.slice(0, 80)}…` : job.error}
            </Muted>
          )}
        </div>
      </TableCell>
      <TableCell className={WIDE_COLUMN} numeric>
        {job.deliveryCount}
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        {job.agent ? (
          isAdmin ? (
            <Link href={`/harnesses/${job.agent.id}`} className="list-text list-text-primary">
              {job.agent.name}
            </Link>
          ) : (
            <span className="list-text">{job.agent.name}</span>
          )
        ) : (
          <Muted>—</Muted>
        )}
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <Timestamp iso={job.createdAt} />
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        {job.finishedAt ? <Timestamp iso={job.finishedAt} /> : <Muted>—</Muted>}
      </TableCell>
      {isAdmin && (
        <TableCell className="list-actions">
          {isCancelable(job) && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  aria-label={`Cancel job ${shortJobId(job.id)}`}
                >
                  <IconX size={14} />
                  <span className="list-label-wide">Cancel</span>
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

const subscribeToHash = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

/** The job of the URL's `#job-<id>` fragment (null on the server). */
function useHashJobId(): string | null {
  return React.useSyncExternalStore(
    subscribeToHash,
    () => jobIdFromHash(window.location.hash),
    () => null,
  );
}

export function JobsView({
  jobs,
  status,
  statuses,
  page,
  pageSize,
  total,
  targetJobId,
}: JobsViewProps) {
  const isAdmin = useCurrentUser().role === "admin";
  const router = useRouter();
  const pathname = usePathname();
  const hashJobId = useHashJobId();
  const pageCount = totalPages(total, pageSize);
  const { first, last } = pageRange(page, pageSize, jobs.length);
  const targeted = targetJobId ?? hashJobId;

  // A bare `/jobs#job-<id>` link (chat replies) whose job isn't on this page:
  // reload with `?job=<id>`, which opens the page that holds it.
  React.useEffect(() => {
    if (!hashJobId || targetJobId || jobs.some((job) => job.id === hashJobId)) return;
    if (new URLSearchParams(window.location.search).has("job")) return;
    router.replace(jobPageHref(hashJobId));
  }, [hashJobId, targetJobId, jobs, router]);

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
            <div className="list-card-header">
              <div>
                <CardTitle as="h2">Jobs</CardTitle>
                <CardDescription>
                  {total === 0
                    ? "Newest first."
                    : `Newest first. Showing ${first}–${last} of ${total.toLocaleString()}.`}
                </CardDescription>
              </div>
              <NativeSelect
                aria-label="Filter by status"
                value={status ?? ""}
                onChange={(e) =>
                  router.push(jobListHref(pathname, { status: e.target.value || null, page: 1 }))
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
          <CardContent className="list-card-content">
            {jobs.length === 0 ? (
              <Empty
                icon={<IconListCheck size={24} />}
                title={
                  total > 0 ? "No jobs on this page" : status ? `No ${status} jobs` : "No jobs yet"
                }
                titleAs="h3"
                description={
                  total > 0
                    ? "The page is past the last one."
                    : "Jobs appear here when reviews are triggered or repositories are pinned."
                }
              />
            ) : (
              <Table className="list-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Job</TableHead>
                    <TableHead className={WIDE_COLUMN}>Type</TableHead>
                    <TableHead className={WIDE_COLUMN}>Status</TableHead>
                    <TableHead className={WIDE_COLUMN} numeric>
                      Deliveries
                    </TableHead>
                    <TableHead className={WIDE_COLUMN}>Harness</TableHead>
                    <TableHead className={WIDE_COLUMN}>Created</TableHead>
                    <TableHead className={WIDE_COLUMN}>Finished</TableHead>
                    {isAdmin && <TableHead aria-label="Actions" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => (
                    <JobTableRow
                      key={job.id}
                      job={job}
                      isAdmin={isAdmin}
                      targeted={job.id === targeted}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
            <ListPagination
              page={page}
              pageCount={pageCount}
              hrefFor={(p) => jobListHref(pathname, { status, page: p })}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
