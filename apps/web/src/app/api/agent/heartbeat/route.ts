import {
  classifyAgentRunningJobs,
  listAgentPinnedRepositoryIds,
  recordAgentHeartbeat,
} from "@omniralph/db";
import { Heartbeat, effectiveCapabilityLimits, type HeartbeatResponse } from "@omniralph/shared";
import { badRequest, readJson } from "@/lib/agent-auth/request";
import { requireAgent } from "@/lib/agent-auth/verify";
import { signJobToken } from "@/lib/agent-api/jobs";
import { getDb } from "@/lib/db";
import { agentTopics, publishRegion } from "@/lib/dispatch";

/**
 * Agent heartbeat (every 20s). Records the reported version and capabilities
 * and returns the central configuration, the running jobs the agent must
 * cancel and fresh job tokens for the ones it keeps running.
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
  } satisfies HeartbeatResponse);
}
