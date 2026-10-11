import { getJobForHarness } from "@omniralph/db";
import { RalphPermissionRequest } from "@omniralph/shared";
import { badRequest, readJson } from "@/lib/harness-auth/request";
import { requireJob } from "@/lib/harness-auth/verify";
import { jobIdParam, notFound, type JobRouteContext } from "@/lib/harness-api/jobs";
import { getDb } from "@/lib/db";
import { getLinearGateway } from "@/lib/linear/client";
import { isRalphJob } from "@/lib/ralph/activities";
import { askPermission } from "@/lib/ralph/permissions";

function forbidden(error: string): Response {
  return Response.json({ error }, { status: 403 });
}

/**
 * Asks the run's Linear agent session to approve a tool call of a running
 * ralph job's session (the repository's Claude Code settings `ask` about it;
 * see `lib/ralph/permissions.ts`). Needs the job's own token with
 * `ralph:activity`; the body is a `RalphPermissionRequest`. The harness then
 * polls `GET …/permissions/{requestId}`. 410 when the run is over (the harness
 * denies the call); 502 when Linear fails.
 */
export async function POST(req: Request, ctx: JobRouteContext): Promise<Response> {
  const principal = await requireJob(req, "ralph:activity");
  if (principal instanceof Response) return principal;
  const jobId = await jobIdParam(ctx);
  if (!jobId) return notFound();
  if (jobId !== principal.jobId) return forbidden("job_mismatch");
  const db = getDb();
  const job = await getJobForHarness(db, jobId, principal.harnessId);
  if (!job) return notFound();
  if (!isRalphJob(job)) return forbidden("not_a_ralph_job");
  const request = RalphPermissionRequest.safeParse(await readJson(req));
  if (!request.success) return badRequest();

  try {
    const outcome = await askPermission(
      { db, linear: (organizationId) => getLinearGateway({ db, organizationId }) },
      job,
      request.data,
    );
    if (outcome.status === "no_run") return Response.json({ error: "run_over" }, { status: 410 });
    return Response.json({ status: "pending" });
  } catch (error) {
    console.error("asking for a tool permission in Linear failed", error);
    return Response.json({ error: "linear_unavailable" }, { status: 502 });
  }
}
