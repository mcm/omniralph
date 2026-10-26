import {
  classifyHarnessRunningJobs,
  listHarnessHostTools,
  listHarnessPinnedRepositoryIds,
  recordHarnessHostTools,
  renewJobLeases,
  resolveHarnessConfig,
  type Database,
} from "@omniralph/db";
import {
  Heartbeat,
  JOB_LEASE_SECONDS,
  LEGACY_POLL_INTERVAL_SECONDS,
  effectivePoolLimits,
  type HeartbeatResponse,
  type JobMessageDelivery,
} from "@omniralph/shared";
import { getAblyConfig, heartbeatAblyToken } from "@/lib/ably/token";
import { badRequest, readJson } from "@/lib/harness-auth/request";
import { requireHarness } from "@/lib/harness-auth/verify";
import { heartbeatClaimable } from "@/lib/harness-api/claimable";
import { signJobTokens } from "@/lib/harness-api/jobs";
import { organizationHarnessVersion } from "@/lib/harnesses/desired-version";
import {
  cachedHeartbeatResponse,
  heartbeatRequestKey,
  readHeartbeatChanges,
  storeHeartbeatResponse,
  type CachedHeartbeatResponse,
  type HeartbeatChanges,
} from "@/lib/harnesses/heartbeat-cache";
import { recordHeartbeat, type HeartbeatReport } from "@/lib/harnesses/last-seen";
import { noteAgentOnline } from "@/lib/harnesses/liveness";
import { readHarnessOrganization } from "@/lib/harnesses/organization";
import { hasDueJob, renewJobsDue } from "@/lib/dispatch/due";
import { hotStateEnabled } from "@/lib/hot-state";
import { getDb } from "@/lib/db";
import { getLinearGatewayOrDisconnected } from "@/lib/linear/client";
import { exchangeJobMessages } from "@/lib/ralph/messages";
import { liveRoute } from "@/lib/live/request";

/** Longest a heartbeat waits for npm when the organization's `latest` is due to be read again. */
const NPM_TIMEOUT_MS = 5_000;

/**
 * Harness heartbeat (every 20s). Records the reported version, accepted task types and
 * self-update state (last-seen in Redis; the harness row only when the report
 * changed or once a day: `recordHeartbeat`), renews the leases of the running jobs the harness keeps,
 * applies the acknowledged job messages and returns the central configuration,
 * the running jobs the harness must cancel, fresh job tokens and undelivered
 * messages (`jobMessages`) for the ones it keeps running, and the version it
 * should run (its override, else its organization's setting, with `latest`
 * resolved), an admin's pending "Update now" (cleared once the harness reports
 * it handled) and the organization's host tools with this harness's configured
 * paths, plus a subscribe-only Ably token for its wake channels when Ably is
 * on and the harness's token is missing or expires within the hour (`ably:
 * null` when Ably is off), and, when the request carries `claimablePools`,
 * whether a claim for them would find a job right now (`claimable`). The
 * harness's report on those host tools is stored first.
 *
 * A heartbeat with no running jobs or acknowledgements is answered from Redis when
 * nothing its last response was built from changed (`heartbeat-cache`): no Postgres
 * query, unless it asked about `claimablePools` and its organization has a due job.
 * Either way, an agent the live change events last had offline is announced online
 * (`noteAgentOnline`: a Redis read while it stays online).
 */
async function post(req: Request): Promise<Response> {
  const principal = await requireHarness(req);
  if (principal instanceof Response) return principal;
  const body = Heartbeat.safeParse(await readJson(req));
  if (!body.success) return badRequest();

  const db = getDb();
  const { harnessId } = principal;
  const report: HeartbeatReport = {
    version: body.data.version,
    selfUpdate: body.data.selfUpdate,
    update: body.data.update,
    failedVersions: body.data.failedVersions,
    handledUpdateRequestId: body.data.handledUpdateRequestId,
    installables: body.data.installables,
    models: body.data.models,
    acceptedTaskTypes: body.data.acceptedTaskTypes,
  };
  // Running jobs (leases, tokens, cancels, messages) and acknowledgements need Postgres.
  const cacheable =
    hotStateEnabled() &&
    body.data.runningJobIds.length === 0 &&
    body.data.deliveredMessageIds.length === 0 &&
    body.data.rejectedMessageIds.length === 0;
  if (cacheable) {
    const cached = await cachedHeartbeatResponse(harnessId, report, body.data.hostTools, {
      timeoutMs: NPM_TIMEOUT_MS,
    });
    // A due job may be claimable: Postgres tells (`hasDueJob` is false when none is due).
    if (
      cached &&
      (body.data.claimablePools === undefined || !(await hasDueJob(db, cached.organizationId)))
    ) {
      const claimable = body.data.claimablePools === undefined ? undefined : false;
      await announceOnline(db, harnessId);
      return Response.json(await withRequestFields(cached, harnessId, body.data, claimable));
    }
  }
  // Read before anything the response is built from: a change committed meanwhile then
  // bumps a counter past the one cached, and the next heartbeat takes this path again.
  let changes: HeartbeatChanges | null = null;
  if (cacheable) {
    const organizationId = await readHarnessOrganization(db, harnessId);
    if (organizationId) changes = await readHeartbeatChanges(harnessId, organizationId);
  }
  const agent = await recordHeartbeat(db, harnessId, report);
  if (!agent) return badRequest("unknown_agent");
  await announceOnline(db, harnessId);
  await recordHarnessHostTools(db, agent.organizationId, harnessId, body.data.hostTools);
  const [pinnedRepoIds, running, organizationVersion, hostTools, config] = await Promise.all([
    listHarnessPinnedRepositoryIds(db, harnessId),
    classifyHarnessRunningJobs(db, harnessId, body.data.runningJobIds),
    agent.desiredVersion
      ? null
      : organizationHarnessVersion(db, agent.organizationId, { timeoutMs: NPM_TIMEOUT_MS }),
    listHarnessHostTools(db, agent.organizationId, harnessId),
    // Its own max concurrency, else the organization's default, and its reported task types.
    resolveHarnessConfig(db, agent),
  ]);
  const keepIds = running.keep.map((job) => job.id);
  // The heartbeat is the lease: a job of a live harness is never taken over.
  const renewedAt = new Date();
  const renewed = await renewJobLeases(db, harnessId, keepIds, renewedAt, JOB_LEASE_SECONDS);
  await renewJobsDue(
    agent.organizationId,
    renewed,
    new Date(renewedAt.getTime() + JOB_LEASE_SECONDS * 1000),
  );
  // Both tokens of a run-spec job are refreshed; a legacy job's single token too.
  const jobTokens = (
    await Promise.all(running.keep.map((job) => signJobTokens(job, harnessId)))
  ).flatMap(({ jobToken, sessionToken }) => (sessionToken ? [jobToken, sessionToken] : [jobToken]));
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

  const claimable = await heartbeatClaimable(
    db,
    // The task types it reports now, else (older agents) the ones it last reported.
    { ...agent, acceptedTaskTypes: body.data.acceptedTaskTypes ?? config.acceptedTaskTypes },
    body.data.claimablePools,
  );

  const response: CachedHeartbeatResponse = {
    maxConcurrency: config.maxConcurrency,
    // Legacy fields: old harnesses require them; `topics: []` stops their polling.
    pollIntervalSeconds: LEGACY_POLL_INTERVAL_SECONDS,
    // Only older agents, which don't report their task types, take (and require) these.
    ...(body.data.acceptedTaskTypes === undefined && {
      acceptedTaskTypes: config.acceptedTaskTypes,
    }),
    // The `short` and `long` pools (a job's pool follows from its task type).
    poolLimits: effectivePoolLimits(agent.poolLimits, config.maxConcurrency),
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
    hostTools: hostTools.map(({ name, configuredPath }) => ({ name, configuredPath })),
  };
  if (changes) {
    const latest = organizationVersion?.tracksLatest ? organizationVersion : null;
    await storeHeartbeatResponse(
      harnessId,
      {
        changes,
        request: heartbeatRequestKey(report, body.data.hostTools),
        ...(latest && { latestVersion: latest.version }),
        response,
      },
      latest?.latestCheckedAt
        ? {
            organizationId: agent.organizationId,
            version: latest.version,
            checkedAt: latest.latestCheckedAt,
          }
        : undefined,
    );
  }
  return Response.json(await withRequestFields(response, harnessId, body.data, claimable));
}

/**
 * Announces the agent online in the live change events when it was offline (a steady
 * heartbeat publishes nothing). A failure never fails the heartbeat.
 */
async function announceOnline(db: Database, harnessId: string): Promise<void> {
  try {
    await noteAgentOnline(db, harnessId);
  } catch (error) {
    console.error(`Announcing agent ${harnessId} online failed`, error);
  }
}

/** The response with the fields that depend on the request: `ably` and `claimable`. */
async function withRequestFields(
  response: CachedHeartbeatResponse,
  harnessId: string,
  request: Pick<Heartbeat, "ablyTokenExpiresAt">,
  claimable: boolean | undefined,
): Promise<HeartbeatResponse> {
  const ably = await heartbeatAblyToken(getAblyConfig(), {
    harnessId,
    organizationId: response.organizationId,
    tokenExpiresAt: request.ablyTokenExpiresAt,
  });
  return {
    ...response,
    // Omitted while the harness's Ably token is good for another hour.
    ...(ably === undefined ? {} : { ably }),
    // Only when the harness asked (`claimablePools`): it then claims on `true`.
    ...(claimable === undefined ? {} : { claimable }),
  } satisfies HeartbeatResponse;
}

export const POST = liveRoute(post);
