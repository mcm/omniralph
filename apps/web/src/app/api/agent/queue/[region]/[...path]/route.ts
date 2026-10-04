import { getAgent } from "@omniralph/db";
import { getVercelOidcToken } from "@vercel/oidc";
import { requireAgent } from "@/lib/agent-auth/verify";
import { getDb } from "@/lib/db";
import { agentTopics, proxyQueueRequest, queueRegions } from "@/lib/dispatch";

/**
 * Vercel Queues proxy for agents (`PollingQueueClient` with `resolveBaseUrl`
 * = `<APP_URL>/api/agent/queue/<region>`). Only ReceiveMessages,
 * AcknowledgeMessage and ExtendLease on the agent's topics in consumer group
 * `agents` are forwarded, with the control panel's OIDC token; everything else
 * gets 403. See `lib/dispatch/queue-proxy.ts`.
 */
async function handler(req: Request): Promise<Response> {
  const principal = await requireAgent(req);
  if (principal instanceof Response) return principal;
  const agent = await getAgent(getDb(), principal.agentId);
  return proxyQueueRequest(req, {
    regions: queueRegions(),
    allowedTopics: agent ? agentTopics(agent) : [],
    getOidcToken: () => getVercelOidcToken(),
  });
}

// Every method is routed here so that disallowed ones get 403 too.
export { handler as DELETE, handler as GET, handler as PATCH, handler as POST, handler as PUT };
