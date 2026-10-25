"use client";

import * as React from "react";
import { Link } from "@/components/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutationState } from "@tanstack/react-query";
import { REVIEW_TASK_JOB_TYPE } from "@omniralph/shared";
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
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconExternalLink, IconListCheck, IconRefresh, IconX } from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { Freshness } from "@/components/freshness";
import { ListPagination } from "@/components/list-pagination";
import { PhoneMeta, Timestamp, WIDE_COLUMN } from "@/components/list-table";
import { ListErrorRow, useListErrorId } from "@/components/list-error";
import { MonoValue } from "@/components/mono-value";
import { PageHeader } from "@/components/page-header";
import { QueryBoundary } from "@/components/query-boundary";
import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import { JOB_STATUSES, type JobList } from "@/lib/api/jobs";
import { mutationResultSchema } from "@/lib/api/schemas";
import type { JobRow } from "@/lib/harnesses/rows";
import {
  jobIdFromHash,
  jobListHref,
  jobPageHref,
  parseJobListParams,
  shortJobId,
  type JobListParams,
} from "@/lib/jobs/list";
import { pageRange, totalPages } from "@/lib/pagination";
import { JobStatusBadge } from "@/components/ralph-badges";
import { useJobList } from "./job-queries";
import { EmptyValue } from "@/components/empty-value";
import { stateLabel } from "@/lib/state-variants";
import { triageRunHref } from "@/lib/triage/display";

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
  onCancel,
  rerunning,
  onRerun,
}: {
  job: JobRow;
  isAdmin: boolean;
  targeted: boolean;
  year: number;
  onCancel: (job: JobRow) => void;
  rerunning: boolean;
  onRerun: (job: JobRow) => void;
}) {
  const errorId = useListErrorId(job.error);
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
        <TableCell className="jobs-col-job">
          <a
            href={`#job-${job.id}`}
            className="list-title text-numeric list-nowrap"
            title={job.id}
            aria-label={`Job ${job.id}`}
            aria-describedby={errorId}
          >
            {shortJobId(job.id)}
          </a>
          <PhoneMeta>
            <JobStatusBadge job={job} />
            <Timestamp iso={job.finishedAt ?? job.createdAt} year={year} />
            <span className="list-time text-numeric">{job.type}</span>
            {job.triageRun ? (
              <Link href={triageRunHref(job.triageRun.id)} className="list-time">
                <MonoValue value={job.triageRun.label} />
              </Link>
            ) : (
              job.target && <MonoValue value={job.target.label} className="list-time" />
            )}
          </PhoneMeta>
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <div className="jobs-type-line">
            <span className="list-time list-text-primary text-numeric">{job.type}</span>
            <Badge variant="neutral">{stateLabel(job.taskType)}</Badge>
          </div>
        </TableCell>
        <TableCell className={`${WIDE_COLUMN} jobs-col-target`}>
          {job.triageRun ? (
            <Link
              href={triageRunHref(job.triageRun.id)}
              className="list-secondary jobs-target"
              aria-label={`Open the triage run of ${job.triageRun.label}`}
            >
              <MonoValue value={job.triageRun.label} />
            </Link>
          ) : job.target ? (
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
        <TableCell className={WIDE_COLUMN} aria-describedby={errorId}>
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
                    <AlertDialogAction variant="danger" onClick={() => onCancel(job)}>
                      Cancel job
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {job.rerunnable && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Rerun job ${shortJobId(job.id)}`}
                    title="Rerun job"
                    disabled={rerunning}
                  >
                    <IconRefresh size={14} />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Rerun this {job.type} job?</AlertDialogTitle>
                    <AlertDialogDescription>
                      {job.type === REVIEW_TASK_JOB_TYPE
                        ? "Its review runs again on the PR's current head, with the repository's default profile."
                        : "It's queued again for the harness it ran on."}{" "}
                      This job stays failed; the rerun is a new job.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep it</AlertDialogCancel>
                    <AlertDialogAction onClick={() => onRerun(job)}>Rerun job</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </TableCell>
        )}
      </TableRow>
      {job.error && (
        <ListErrorRow
          error={job.error}
          colSpan={isAdmin ? JOB_COLUMNS + 1 : JOB_COLUMNS}
          id={errorId}
          targeted={targeted}
        />
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

/** Names the cancel mutation, so the rows show it before the server answers. */
const CANCEL_JOB = ["cancel-job"];

/**
 * Cancels jobs. While a cancel is on its way, its job shows what it will become: a queued
 * job canceled, a running one "Cancel requested" (until its harness confirms, with its next
 * heartbeat, and the list's polling shows it canceled). The mutation stays pending until the
 * refetched list has the server's state, so the overlay hands over without a flicker.
 */
function useCancelJob() {
  const cancel = useApiMutation({
    mutationKey: CANCEL_JOB,
    mutationFn: (job: JobRow, { organizationId }) =>
      api.post(`/api/ui/jobs/${job.id}/cancel`, mutationResultSchema, { organizationId }),
    // The job (Jobs pages, its run's or triage run's page) and the harness running it.
    invalidate: (keys) => [
      keys.jobs.all,
      keys.harnesses.all,
      keys.runs.all,
      keys.triage.all,
      keys.reviews.all,
    ],
    success: "Job canceled",
  });
  const pending = useMutationState({
    filters: { mutationKey: CANCEL_JOB, status: "pending" },
    select: (mutation) => (mutation.state.variables as JobRow).id,
  });
  const withPending = (job: JobRow): JobRow => {
    if (!pending.includes(job.id)) return job;
    if (job.status === "queued") return { ...job, status: "canceled", cancelRequested: true };
    if (job.status === "running") return { ...job, cancelRequested: true };
    return job;
  };
  return { cancel: (job: JobRow) => cancel.mutate(job), withPending };
}

/** Names the rerun mutation, so a job's Rerun is disabled while its rerun is on its way. */
const RERUN_JOB = ["rerun-job"];

/**
 * Reruns failed jobs (`POST /api/ui/jobs/{id}/rerun`): the rerun is a new job, which the
 * refetched list shows at its top; the failed job stays as it was.
 */
function useRerunJob() {
  const rerun = useApiMutation({
    mutationKey: RERUN_JOB,
    mutationFn: (job: JobRow, { organizationId }) =>
      api.post(`/api/ui/jobs/${job.id}/rerun`, mutationResultSchema, { organizationId }),
    // The new job (Jobs pages), and the review a review job's rerun starts.
    invalidate: (keys) => [keys.jobs.all, keys.harnesses.all, keys.reviews.all],
    success: "Job rerun",
  });
  const pending = useMutationState({
    filters: { mutationKey: RERUN_JOB, status: "pending" },
    select: (mutation) => (mutation.state.variables as JobRow).id,
  });
  return { rerun: (job: JobRow) => rerun.mutate(job), rerunning: pending };
}

/**
 * The list's filter and page from the URL, and a setter. A chosen filter shows at once,
 * before the navigation that puts it in the URL (bookmarkable, back button) has finished.
 */
function useJobListParams(): [JobListParams, (status: string | null) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const fromUrl = parseJobListParams(Object.fromEntries(searchParams));
  // Chosen on the URL `search`: once the URL changes, it holds the choice.
  const [chosen, setChosen] = React.useState<{ search: string; params: JobListParams } | null>(
    null,
  );
  // Once the URL moves on (the navigation landed, or Back), the choice is spent: a later
  // return to the same URL shows that URL's filter, not the old choice.
  if (chosen && chosen.search !== search) setChosen(null);
  const params = chosen?.search === search ? chosen.params : fromUrl;
  const setStatus = (status: string | null) => {
    const next = { status, page: 1, jobId: null };
    setChosen({ search, params: next });
    router.push(jobListHref(pathname, next), { scroll: false });
  };
  return [params, setStatus];
}

/** The jobs table's skeleton: rows shaped like jobs while the first page loads. */
function JobsSkeleton() {
  return (
    <Table className="list-table jobs-table">
      <TableBody>
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <TableRow key={index}>
            <TableCell className="jobs-col-job">
              <Skeleton width="7rem" />
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <Skeleton width={`${50 + ((index * 13) % 30)}%`} />
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <Skeleton width={`${45 + ((index * 17) % 35)}%`} />
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <Skeleton width="5rem" height="1.25rem" radius="full" />
            </TableCell>
            {Array.from({ length: 3 }, (_, column) => (
              <TableCell key={column} className={WIDE_COLUMN}>
                <Skeleton width={`${40 + (((index + column) * 13) % 40)}%`} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const SKELETON_ROWS = 5;

function JobsTable({
  list,
  params,
  isAdmin,
  targeted,
  withPending,
  onCancel,
  rerunning,
  onRerun,
}: {
  list: JobList;
  params: JobListParams;
  isAdmin: boolean;
  targeted: string | null;
  withPending: (job: JobRow) => JobRow;
  onCancel: (job: JobRow) => void;
  /** The jobs whose rerun is on its way. */
  rerunning: string[];
  onRerun: (job: JobRow) => void;
}) {
  const pathname = usePathname();
  const { jobs, total } = list;
  // Created times leave out the current year, the browser's.
  const year = new Date().getFullYear();
  return (
    <>
      {jobs.length === 0 ? (
        <Empty
          icon={<IconListCheck size={24} />}
          title={
            total > 0
              ? "No jobs on this page"
              : params.status
                ? `No ${params.status} jobs`
                : "No jobs yet"
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
              <TableHead className="jobs-col-job">Job</TableHead>
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
                job={withPending(job)}
                isAdmin={isAdmin}
                year={year}
                targeted={job.id === targeted}
                onCancel={onCancel}
                rerunning={rerunning.includes(job.id)}
                onRerun={onRerun}
              />
            ))}
          </TableBody>
        </Table>
      )}
      <ListPagination
        page={list.page}
        pageCount={totalPages(total, list.pageSize)}
        hrefFor={(page) => jobListHref(pathname, { status: params.status, page })}
      />
    </>
  );
}

/**
 * The Jobs page, live: the jobs for the URL's filter and page poll (`GET /api/ui/jobs`), so
 * they move through their states as harnesses run them; a new filter or page keeps the
 * previous results, dimmed, until its own arrive. `?job=<id>` opens the page holding that job.
 */
export function JobsView() {
  const isAdmin = useCurrentUser().role === "admin";
  const router = useRouter();
  const [params, setStatus] = useJobListParams();
  const list = useJobList(params);
  const data = list.data;
  const hashJobId = useHashJobId();
  const { cancel, withPending } = useCancelJob();
  const { rerun, rerunning } = useRerunJob();
  const total = data?.total ?? 0;
  const { first, last } = pageRange(
    data?.page ?? params.page,
    data?.pageSize ?? 1,
    data?.jobs.length ?? 0,
  );
  const targetJobId = data?.targetJobId ?? null;
  const targeted = targetJobId ?? hashJobId;

  // A bare `/jobs#job-<id>` link (chat replies) whose job isn't on this page:
  // reload with `?job=<id>`, which opens the page that holds it.
  React.useEffect(() => {
    if (!data || list.isPlaceholderData) return;
    if (!hashJobId || targetJobId || data.jobs.some((job) => job.id === hashJobId)) return;
    if (new URLSearchParams(window.location.search).has("job")) return;
    router.replace(jobPageHref(hashJobId));
  }, [hashJobId, targetJobId, data, list.isPlaceholderData, router]);

  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Jobs" }]} />
      <div className="detail-main">
        <PageHeader
          title="Jobs"
          description="Queued, running and finished jobs of every type."
          meta={<Freshness query={list} />}
        />

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
                value={params.status && isJobStatus(params.status) ? params.status : ""}
                onChange={(e) => setStatus(e.target.value || null)}
              >
                <option value="">All statuses</option>
                {JOB_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {stateLabel(s)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </CardHeader>
          <CardContent className="list-card-content">
            <QueryBoundary query={list} skeleton={<JobsSkeleton />} what="jobs">
              {(loaded) => (
                <div className="list-pending" aria-busy={list.isPlaceholderData}>
                  <JobsTable
                    list={loaded}
                    params={params}
                    isAdmin={isAdmin}
                    targeted={targeted}
                    withPending={withPending}
                    onCancel={cancel}
                    rerunning={rerunning}
                    onRerun={rerun}
                  />
                </div>
              )}
            </QueryBoundary>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function isJobStatus(value: string): value is JobRow["status"] {
  return (JOB_STATUSES as readonly string[]).includes(value);
}
