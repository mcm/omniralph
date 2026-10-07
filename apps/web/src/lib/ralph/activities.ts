import "server-only";
import { getRun, type Database, type Job } from "@omniralph/db";
import { RALPH_CAPABILITY, type RalphActivity } from "@omniralph/shared";
import type { ActivityContent, LinearGateway } from "@/lib/linear/gateway";
import { FINISHED_RUN_STATUSES } from "./run";

/** The Linear activity content of an activity an agent relays. */
export function activityContent(activity: RalphActivity): ActivityContent {
  return activity.type === "thought"
    ? { type: "thought", body: activity.body }
    : { type: "action", action: activity.body, parameter: activity.parameter ?? "" };
}

/** Whether a job may relay activities: only ralph jobs do. */
export function isRalphJob(job: Pick<Job, "capability" | "type">): boolean {
  return job.capability === RALPH_CAPABILITY && job.type.startsWith(`${RALPH_CAPABILITY}.`);
}

export type RelayOutcome =
  | { forwarded: true; sessionId: string }
  /** No run, or the run is over (e.g. stopped): the activity is dropped. */
  | { forwarded: false; reason: "no_run" | "run_finished" };

/**
 * Forwards an activity of a ralph job to its run's Linear agent session.
 * Activities of a finished run are dropped, so a stopped run stays quiet.
 */
export async function relayActivity(
  /** `linear` gives the gateway of an organization's workspace. */
  deps: { db: Database; linear: (organizationId: string) => Promise<LinearGateway> },
  job: Pick<Job, "ralphRunId">,
  activity: RalphActivity,
): Promise<RelayOutcome> {
  const run = job.ralphRunId ? await getRun(deps.db, job.ralphRunId) : null;
  if (!run) return { forwarded: false, reason: "no_run" };
  if (FINISHED_RUN_STATUSES.has(run.status)) return { forwarded: false, reason: "run_finished" };
  const linear = await deps.linear(run.organizationId);
  await linear.createActivity(run.linearAgentSessionId, activityContent(activity), {
    ephemeral: activity.ephemeral,
  });
  return { forwarded: true, sessionId: run.linearAgentSessionId };
}
