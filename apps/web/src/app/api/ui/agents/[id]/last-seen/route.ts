import { z } from "zod";
import { readAgentLastSeen } from "@/lib/agents/last-seen";
import { readAgentOrganization } from "@/lib/agents/organization";
import type { AgentLastSeen } from "@/lib/api/agents";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { membership } from "@/lib/api/scope";
import { getDb } from "@/lib/db";

type Params = { id: string };

/**
 * The agent's last heartbeat from Redis, which the open agent panel polls every 10 s
 * (steady heartbeats publish no change event, and the row's can be a day old). For every
 * member of the agent's organization (any of the user's); an agent of an organization the
 * user isn't a member of is not found. Its organization comes from the Redis cache and the
 * active organization's membership needs no query, so with warm caches it doesn't touch
 * Postgres (unlike `requireAgentAccess`). Null when Redis has no last-seen.
 */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<AgentLastSeen> => {
    if (!z.uuid().safeParse(params.id).success) throw ApiRouteError.notFound();
    const organizationId = await readAgentOrganization(getDb(), params.id);
    if (!organizationId || !(await membership(user, organizationId))) {
      throw ApiRouteError.notFound();
    }
    const lastSeen = (await readAgentLastSeen([params.id])).get(params.id);
    return { lastHeartbeatAt: lastSeen?.toISOString() ?? null };
  },
);
