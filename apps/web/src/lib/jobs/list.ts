/** Client-safe helpers of the Jobs list: its URL params, links to a job, job IDs. */
import { parsePage } from "@/lib/pagination";

export interface JobListParams {
  /** A job status, or null for all (validated by the page against the enum). */
  status: string | null;
  /** 1-based. */
  page: number;
  /** A job to show: the page holding it is opened and its row highlighted. */
  jobId: string | null;
}

type SearchParams = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The list's filter, page and targeted job from URL search params. */
export function parseJobListParams(params: SearchParams): JobListParams {
  const job = single(params.job);
  return {
    status: single(params.status) || null,
    page: parsePage(params.page),
    jobId: job && UUID.test(job) ? job.toLowerCase() : null,
  };
}

/** `pathname` with the filter and page as search params (defaults omitted). */
export function jobListHref(
  pathname: string,
  params: Pick<JobListParams, "status" | "page">,
): string {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.page > 1) search.set("page", String(params.page));
  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** A job's row on the Jobs page, opened on the page that holds it. */
export function jobPageHref(jobId: string): string {
  return `/jobs?job=${encodeURIComponent(jobId)}#job-${jobId}`;
}

/** The job ID of a `#job-<id>` fragment, or null. */
export function jobIdFromHash(hash: string): string | null {
  const match = /^#job-(.+)$/.exec(hash);
  return match && UUID.test(match[1]!) ? match[1]!.toLowerCase() : null;
}

/** A job's UUID cut in the middle (`0f3c2a1b…3a4b`); the full ID goes in its title. */
export function shortJobId(jobId: string): string {
  return jobId.length > 13 ? `${jobId.slice(0, 8)}…${jobId.slice(-4)}` : jobId;
}
