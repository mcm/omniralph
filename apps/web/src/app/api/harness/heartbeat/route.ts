import {
  classifyHarnessRunningJobs,
  listHarnessPinnedRepositoryIds,
  listPoolNames,
  recordHarnessHeartbeat,
  renewJobLeases,
} from "@omniralph/db";
import {
  DEFAULT_POOLS,
  Heartbeat,
  LEGACY_POLL_INTERVAL_SECONDS,
  effectivePoolLimits,
  isJobTaskType,
  type HeartbeatResponse,
  type JobMessageDelivery,
} from "@omniralph/shared";
import { badRequest, readJson } from "@/lib/harness-auth/request";
import { requireHarness } from "@/lib/harness-auth/verify";
import { signJobToken } from "@/lib/harness-api/jobs";
import { organizationHarnessVersion } from "@/lib/harnesses/desired-version";
import { getDb } from "@/lib/db";
import { getLinearGatewayOrDisconnected } from "@/lib/linear/client";
import { exchangeJobMessages } from "@/lib/ralph/messages";

/** Longest a heartbeat waits for npm when the organization's `latest` is due to be read again. */
const NPM_TIMEOUT_MS = 5_000;

/**
 * Harness heartbeat (every 20s). Records the reported version, capabilities and
 * self-update state, renews the leases of the running jobs the harness keeps,
 * applies the acknowledged job messages and returns the central configuration,
 * the running jobs the harness must cancel, fresh job tokens and undelivered
 * messages (`jobMessages`) for the ones it keeps running, and the version it
 * should run (its override, else its organization's setting, with `latest`
 * resolved) and an admin's pending "Update now" (cleared once the harness reports
 * it handled).
 */
export async function POST(req: Request): Promise<Response> {
  const principal = await requireHarness(req);
  if (principal instanceof Response) return principal;
  const body = Heartbeat.safeParse(await readJson(req));
  if (!body.success) return badRequest();

  const db = getDb();
  const { harnessId } = principal;
  const agent = await recordHarnessHeartbeat(db, harnessId, {
    version: body.data.version,
    capabilities: body.data.capabilities,
    selfUpdate: body.data.selfUpdate,
    update: body.data.update,
    failedVersions: body.data.failedVersions,
    handledUpdateRequestId: body.data.handledUpdateRequestId,
  });
  if (!agent) return badRequest("unknown_agent");
  const [pinnedRepoIds, poolNames, running, organizationVersion] = await Promise.all([
    listHarnessPinnedRepositoryIds(db, harnessId),
    listPoolNames(db, agent.organizationId),
    classifyHarnessRunningJobs(db, harnessId, body.data.runningJobIds),
    agent.desiredVersion
      ? null
      : organizationHarnessVersion(db, agent.organizationId, { timeoutMs: NPM_TIMEOUT_MS }),
  ]);
  const keepIds = running.keep.map((job) => job.id);
  // The heartbeat is the lease: a job of a live harness is never taken over.
  await renewJobLeases(db, harnessId, keepIds);
  const jobTokens = await Promise.all(running.keep.map((job) => signJobToken(job, harnessId)));
  let jobMessages: JobMessageDelivery[] = [];
  try {
    jobMessages = await exchangeJobMessages(
      {
        db,
        linear: (organizationId) => getLinearGatewayOrDisconnected({ db, organizationId }),
      },
      harnessId,
      keepIds,
      body.data,
    );
  } catch (error) {
    // The acknowledgements stay unapplied: messages are settled when their job ends.
    console.error(`Exchanging job messages with agent ${harnessId} failed`, error);
  }

  return Response.json({
    maxConcurrency: agent.maxConcurrency,
    // Legacy fields: old harnesses require them; `topics: []` stops their polling.
    pollIntervalSeconds: LEGACY_POLL_INTERVAL_SECONDS,
    acceptedTaskTypes: agent.acceptedTaskTypes.filter(isJobTaskType),
    // `short` and `long` always exist (seeded per organization).
    poolLimits: effectivePoolLimits(agent.poolLimits, agent.maxConcurrency, [
      ...new Set([...DEFAULT_POOLS, ...poolNames]),
    ]),
    pinnedRepoIds,
    organizationId: agent.organizationId,
    topics: [],
    queueRegion: "",
    cancelJobIds: running.cancel,
    jobTokens,
    jobMessages,
    desiredVersion: agent.desiredVersion ?? organizationVersion?.version ?? null,
    updateRequest:
      agent.updateRequestId && agent.updateRequestVersion
        ? { id: agent.updateRequestId, version: agent.updateRequestVersion }
        : null,
  } satisfies HeartbeatResponse);
}
