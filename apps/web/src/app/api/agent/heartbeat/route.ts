import {
  classifyAgentRunningJobs,
  listAgentPinnedRepositoryIds,
  recordAgentHeartbeat,
} from "@omniralph/db";
import {
  Heartbeat,
  effectiveCapabilityLimits,
  type HeartbeatResponse,
  type JobMessageDelivery,
} from "@omniralph/shared";
import { badRequest, readJson } from "@/lib/agent-auth/request";
import { requireAgent } from "@/lib/agent-auth/verify";
import { signJobToken } from "@/lib/agent-api/jobs";
import { organizationAgentVersion } from "@/lib/agents/desired-version";
import { getDb } from "@/lib/db";
import { agentTopics, publishRegion } from "@/lib/dispatch";
import { getLinearGatewayOrDisconnected } from "@/lib/linear/client";
import { exchangeJobMessages } from "@/lib/ralph/messages";

/** Longest a heartbeat waits for npm when the organization's `latest` is due to be read again. */
const NPM_TIMEOUT_MS = 5_000;

/**
 * Agent heartbeat (every 20s). Records the reported version, capabilities and
 * self-update state, applies the acknowledged job messages and returns the central
 * configuration, the running jobs the agent must cancel, fresh job tokens and
 * undelivered messages (`jobMessages`) for the ones it keeps running, and the
 * version it should run (its override, else its organization's setting, with `latest`
 * resolved) and
 * an admin's pending "Update now" (cleared once the agent reports it handled).
 */
export async function POST(req: Request): Promise<Response> {
  const principal = await requireAgent(req);
  if (principal instanceof Response) return principal;
  const body = Heartbeat.safeParse(await readJson(req));
  if (!body.success) return badRequest();

  const db = getDb();
  const { agentId } = principal;
  const agent = await recordAgentHeartbeat(db, agentId, {
    version: body.data.version,
    capabilities: body.data.capabilities,
    selfUpdate: body.data.selfUpdate,
    update: body.data.update,
    failedVersions: body.data.failedVersions,
    handledUpdateRequestId: body.data.handledUpdateRequestId,
  });
  if (!agent) return badRequest("unknown_agent");
  const [pinnedRepoIds, running, organizationVersion] = await Promise.all([
    listAgentPinnedRepositoryIds(db, agentId),
    classifyAgentRunningJobs(db, agentId, body.data.runningJobIds),
    agent.desiredVersion
      ? null
      : organizationAgentVersion(db, agent.organizationId, { timeoutMs: NPM_TIMEOUT_MS }),
  ]);
  const jobTokens = await Promise.all(running.keep.map((job) => signJobToken(job, agentId)));
  let jobMessages: JobMessageDelivery[] = [];
  try {
    jobMessages = await exchangeJobMessages(
      {
        db,
        linear: (organizationId) => getLinearGatewayOrDisconnected({ db, organizationId }),
      },
      agentId,
      running.keep.map((job) => job.id),
      body.data,
    );
  } catch (error) {
    // The acknowledgements stay unapplied: messages are settled when their job ends.
    console.error(`Exchanging job messages with agent ${agentId} failed`, error);
  }

  return Response.json({
    maxConcurrency: agent.maxConcurrency,
    pollIntervalSeconds: agent.pollIntervalSeconds,
    enabledCapabilities: agent.enabledCapabilities,
    capabilityLimits: effectiveCapabilityLimits(
      agent.enabledCapabilities,
      agent.capabilityLimits,
      agent.maxConcurrency,
    ),
    pinnedRepoIds,
    organizationId: agent.organizationId,
    topics: agentTopics(agent),
    queueRegion: publishRegion(),
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
