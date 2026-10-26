import { findJobPage, JOB_PAGE_SIZE, jobStatus, listJobs, type JobStatus } from "@omniralph/db";
import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import type { JobList } from "@/lib/api/jobs";
import { getDb } from "@/lib/db";
import { jobRow } from "@/lib/agents/rows";
import { parseJobListParams } from "@/lib/jobs/list";

const listQuery = z.object({
  status: z.string().optional(),
  page: z.string().optional(),
  job: z.string().optional(),
});

function parseStatus(value: string | null): JobStatus | null {
  return (jobStatus.enumValues as readonly string[]).includes(value ?? "")
    ? (value as JobStatus)
    : null;
}

/**
 * A page of the active organization's jobs, newest first, filtered by status (an unknown one
 * is ignored): the Jobs page, polled. `?job=<id>` (a link to one job) answers the unfiltered
 * page that holds it, and names it as `targetJobId`.
 */
export const GET = apiHandler({ query: listQuery }, async ({ user, query }): Promise<JobList> => {
  const db = getDb();
  const organizationId = user.organization.id;
  const params = parseJobListParams(query);
  const status = parseStatus(params.status);
  const targetPage =
    params.jobId && !status
      ? await findJobPage(db, organizationId, params.jobId, JOB_PAGE_SIZE)
      : null;
  const page = await listJobs(db, organizationId, {
    statuses: status ? [status] : undefined,
    page: targetPage ?? params.page,
    pageSize: JOB_PAGE_SIZE,
  });
  return {
    jobs: page.jobs.map(jobRow),
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    targetJobId: targetPage ? params.jobId : null,
  };
});
