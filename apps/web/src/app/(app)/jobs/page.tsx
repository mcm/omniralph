import type { Metadata } from "next";
import { jobStatus, listRecentJobs, type JobStatus } from "@omniralph/db";
import { jobRow } from "@/lib/agents/rows";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { JobsView } from "./jobs-view";

export const metadata: Metadata = { title: "Jobs · Omniralph" };

/** Jobs shown per page load. */
const JOB_LIMIT = 200;

function parseStatus(value: string | undefined): JobStatus | null {
  return (jobStatus.enumValues as readonly string[]).includes(value ?? "")
    ? (value as JobStatus)
    : null;
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requirePageUser();
  const status = parseStatus((await searchParams).status);
  const jobs = await listRecentJobs(getDb(), {
    statuses: status ? [status] : undefined,
    limit: JOB_LIMIT,
  });
  return (
    <JobsView
      jobs={jobs.map(jobRow)}
      status={status}
      statuses={[...jobStatus.enumValues]}
      limit={JOB_LIMIT}
    />
  );
}
