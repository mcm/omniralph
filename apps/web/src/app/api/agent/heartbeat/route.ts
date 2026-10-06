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
import { getDb } from "@/lib/db";
import { agentTopics, publishRegion } from "@/lib/dispatch";
import { getLinearGatewayOrDisconnected } from "@/lib/linear/client";
import { exchangeJobMessages } from "@/lib/ralph/messages";

/**
 * Agent heartbeat (every 20s). Records the reported version and capabilities,
 * applies the acknowledged job messages and returns the central
 * configuration, the running jobs the agent must cancel, fresh job tokens and
 * undelivered messages (`jobMessages`) for the ones it keeps running.
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
  });
  if (!agent) return badRequest("unknown_agent");
  const [pinnedRepoIds, running] = await Promise.all([
    listAgentPinnedRepositoryIds(db, agentId),
    classifyAgentRunningJobs(db, agentId, body.data.runningJobIds),
  ]);
  const jobTokens = await Promise.all(running.keep.map((job) => signJobToken(job, agentId)));
  let jobMessages: JobMessageDelivery[] = [];
  try {
    jobMessages = await exchangeJobMessages(
      { db, linear: () => getLinearGatewayOrDisconnected({ db }) },
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
    topics: agentTopics(agent),
    queueRegion: publishRegion(),
    cancelJobIds: running.cancel,
    jobTokens,
    jobMessages,
  } satisfies HeartbeatResponse);
}
