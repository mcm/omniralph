import type { Metadata } from "next";
import { findJobPage, JOB_PAGE_SIZE, jobStatus, listJobs, type JobStatus } from "@omniralph/db";
import { jobRow } from "@/lib/harnesses/rows";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { parseJobListParams } from "@/lib/jobs/list";
import { JobsView } from "./jobs-view";

export const metadata: Metadata = { title: "Jobs · Omniralph" };

function parseStatus(value: string | null): JobStatus | null {
  return (jobStatus.enumValues as readonly string[]).includes(value ?? "")
    ? (value as JobStatus)
    : null;
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageUser();
  const organizationId = user.organization.id;
  const db = getDb();
  const params = parseJobListParams(await searchParams);
  const status = parseStatus(params.status);
  // A link to one job (`?job=<id>`) opens the unfiltered page that holds it.
  const targetPage =
    params.jobId && !status
      ? await findJobPage(db, organizationId, params.jobId, JOB_PAGE_SIZE)
      : null;
  const page = await listJobs(db, organizationId, {
    statuses: status ? [status] : undefined,
    page: targetPage ?? params.page,
    pageSize: JOB_PAGE_SIZE,
  });
  return (
    <JobsView
      jobs={page.jobs.map(jobRow)}
      status={status}
      statuses={[...jobStatus.enumValues]}
      page={page.page}
      pageSize={page.pageSize}
      total={page.total}
      targetJobId={targetPage ? params.jobId : null}
    />
  );
}
