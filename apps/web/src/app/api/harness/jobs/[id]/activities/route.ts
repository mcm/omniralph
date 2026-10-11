import { getJobForHarness } from "@omniralph/db";
import { RalphActivity } from "@omniralph/shared";
import { badRequest, readJson } from "@/lib/harness-auth/request";
import { requireJob } from "@/lib/harness-auth/verify";
import { jobIdParam, notFound, type JobRouteContext } from "@/lib/harness-api/jobs";
import { getDb } from "@/lib/db";
import { getLinearGateway } from "@/lib/linear/client";
import { isRalphJob, relayActivity } from "@/lib/ralph/activities";

function forbidden(error: string): Response {
  return Response.json({ error }, { status: 403 });
}

/**
 * Relays a session activity of a running ralph job (Claude's text as a
 * thought, a tool call as an ephemeral action) to its run's Linear agent
 * session, so harnesses never hold Linear credentials. Needs the job's own token
 * with `run:activity` (only ralph jobs get it) and a `ralph.*` job; the body
 * is a `RalphActivity`. An activity of a finished run is accepted and dropped.
 * 502 when Linear fails (the harness logs it and carries on).
 */
export async function POST(req: Request, ctx: JobRouteContext): Promise<Response> {
  const principal = await requireJob(req, "run:activity");
  if (principal instanceof Response) return principal;
  const jobId = await jobIdParam(ctx);
  if (!jobId) return notFound();
  if (jobId !== principal.jobId) return forbidden("job_mismatch");
  const db = getDb();
  const job = await getJobForHarness(db, jobId, principal.harnessId);
  if (!job) return notFound();
  if (!isRalphJob(job)) return forbidden("not_a_ralph_job");
  const activity = RalphActivity.safeParse(await readJson(req));
  if (!activity.success) return badRequest();

  try {
    const outcome = await relayActivity(
      { db, linear: (organizationId) => getLinearGateway({ db, organizationId }) },
      job,
      activity.data,
    );
    return Response.json({ forwarded: outcome.forwarded });
  } catch (error) {
    console.error("relaying a ralph activity to Linear failed", error);
    return Response.json({ error: "linear_unavailable" }, { status: 502 });
  }
}
