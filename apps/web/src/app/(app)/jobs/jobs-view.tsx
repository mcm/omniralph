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
import { ListErrorRow } from "@/components/list-error";
import { MonoValue } from "@/components/mono-value";
import { PageHeader } from "@/components/page-header";
import { useAction } from "@/components/use-action";
import type { JobRow } from "@/lib/harnesses/rows";
import { jobIdFromHash, jobListHref, jobPageHref, shortJobId } from "@/lib/jobs/list";
import { pageRange, totalPages } from "@/lib/pagination";
import { JobStatusBadge } from "@/components/ralph-badges";
import { cancelJob } from "./actions";
import { EmptyValue } from "@/components/empty-value";
import { stateLabel } from "@/lib/state-variants";

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
  /** The current year, which created times leave out. */
  year: number;
}

export function isCancelable(job: Pick<JobRow, "status" | "cancelRequested">): boolean {
  return job.status === "queued" || (job.status === "running" && !job.cancelRequested);
}

/** The jobs table's column count without the admin actions, which a failed job's reason row spans. */
const JOB_COLUMNS = 7;

function JobTableRow({
  job,
  isAdmin,
  targeted,
  year,
}: {
  job: JobRow;
  isAdmin: boolean;
  targeted: boolean;
  year: number;
}) {
  const { pending, run } = useAction();
  return (
    <>
      {/* Target of the job links on the Ralph run pages and in chat (`#job-<id>`). */}
      <TableRow
        id={`job-${job.id}`}
        className="job-row"
        data-targeted={targeted || undefined}
        data-has-error={job.error ? true : undefined}
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
            <JobStatusBadge job={job} />
            <Timestamp iso={job.finishedAt ?? job.createdAt} />
            <span className="list-time text-numeric">{job.type}</span>
          </PhoneMeta>
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <div className="jobs-type-line">
            <span className="list-time list-text-primary text-numeric">{job.type}</span>
            <Badge variant="neutral">{stateLabel(job.taskType)}</Badge>
          </div>
        </TableCell>
        <TableCell className={`${WIDE_COLUMN} jobs-col-target`}>
          {job.target ? (
            job.target.url ? (
              <a
                href={job.target.url}
                target="_blank"
                rel="noreferrer"
                className="list-secondary jobs-target"
                aria-label={`Open ${job.target.label} on the code host`}
              >
                <MonoValue value={job.target.label} />
                <IconExternalLink size={12} />
              </a>
            ) : (
              <MonoValue value={job.target.label} className="list-secondary jobs-target" />
            )
          ) : (
            <EmptyValue />
          )}
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <JobStatusBadge job={job} />
        </TableCell>
        <TableCell className={WIDE_COLUMN} numeric>
          {job.deliveryCount}
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          {job.agent ? (
            isAdmin ? (
              <Link
                href={`/harnesses/${job.agent.id}`}
                className="list-text list-text-primary list-nowrap"
              >
                {job.agent.name}
              </Link>
            ) : (
              <span className="list-text list-nowrap">{job.agent.name}</span>
            )
          ) : (
            <EmptyValue />
          )}
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <span className="list-time">
            <Timestamp iso={job.createdAt} year={year} /> →{" "}
            {job.finishedAt ? (
              <Timestamp iso={job.finishedAt} after={job.createdAt} />
            ) : (
              <EmptyValue />
            )}
          </span>
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
                    title="Cancel job"
                  >
                    <IconX size={14} />
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
      {job.error && (
        <ListErrorRow error={job.error} colSpan={isAdmin ? JOB_COLUMNS + 1 : JOB_COLUMNS} />
      )}
    </>
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
  year,
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
      <main className="detail-main">
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
                    {stateLabel(s)}
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
              <Table className="list-table jobs-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Job</TableHead>
                    <TableHead className={WIDE_COLUMN}>Type</TableHead>
                    <TableHead className={`${WIDE_COLUMN} jobs-col-target`}>Target</TableHead>
                    <TableHead className={WIDE_COLUMN}>Status</TableHead>
                    <TableHead className={WIDE_COLUMN} numeric aria-label="Deliveries">
                      <abbr title="Deliveries">Deliv.</abbr>
                    </TableHead>
                    <TableHead className={WIDE_COLUMN}>Harness</TableHead>
                    <TableHead className={WIDE_COLUMN}>Created → finished</TableHead>
                    {isAdmin && <TableHead aria-label="Actions" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => (
                    <JobTableRow
                      key={job.id}
                      job={job}
                      isAdmin={isAdmin}
                      year={year}
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
