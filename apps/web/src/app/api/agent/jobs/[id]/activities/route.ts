import { getJobForAgent, insertRunActivity } from "@omniralph/db";
import { RalphActivity } from "@omniralph/shared";
import { badRequest, readJson } from "@/lib/agent-auth/request";
import { requireJob } from "@/lib/agent-auth/verify";
import { jobIdParam, notFound, type JobRouteContext } from "@/lib/agent-api/jobs";
import { getDb } from "@/lib/db";
import { getTrackerGateway } from "@/lib/tracker/client";
import { relayActivity } from "@/lib/ralph/activities";
import { liveRoute } from "@/lib/live/request";

function forbidden(error: string): Response {
  return Response.json({ error }, { status: 403 });
}

/**
 * Stores a session activity of a running job (Claude's text as a thought, a
 * tool call as an action) in `run_activities`. A ralph job's activity is also
 * relayed to its run's conversation (Linear agent session or chat thread), so
 * agents never hold Linear credentials; an activity of a finished ralph
 * run is stored but not relayed. Needs the job's own token (session or
 * legacy) with `run:activity`; the body is a `RalphActivity`. 502 when Linear
 * fails, after the activity is stored (the agent logs it and carries on).
 */
async function post(req: Request, ctx: JobRouteContext): Promise<Response> {
  const principal = await requireJob(req, "run:activity");
  if (principal instanceof Response) return principal;
  const jobId = await jobIdParam(ctx);
  if (!jobId) return notFound();
  if (jobId !== principal.jobId) return forbidden("job_mismatch");
  const db = getDb();
  const job = await getJobForAgent(db, jobId, principal.agentId);
  if (!job) return notFound();
  const activity = RalphActivity.safeParse(await readJson(req));
  if (!activity.success) return badRequest();
  await insertRunActivity(db, {
    jobId: job.id,
    organizationId: job.organizationId,
    type: activity.data.type,
    body: activity.data.body,
    parameter: activity.data.parameter,
  });
  if (!job.ralphRunId) return Response.json({ forwarded: false });

  try {
    const outcome = await relayActivity(
      { db, tracker: (organizationId) => getTrackerGateway({ db, organizationId }) },
      job,
      activity.data,
    );
    return Response.json({ forwarded: outcome.forwarded });
  } catch (error) {
    console.error("relaying a ralph activity to Linear failed", error);
    return Response.json({ error: "linear_unavailable" }, { status: 502 });
  }
}

export const POST = liveRoute(post);
