import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import type { AgentDetail } from "@/lib/api/agents";
import { requireAgentAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { clientIp } from "@/lib/agents/request";
import { deleteAgent } from "@/lib/agents/manage";
import { loadAgentDetail } from "@/lib/fleet/load";

type Params = { id: string };

/**
 * One agent of any of the user's organizations, for every member there: its Fleet row,
 * what it runs now and did recently, its reports, security line and audit log. An agent
 * of an organization the user isn't a member of is not found.
 */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<AgentDetail> => {
    const organization = await requireAgentAccess(user, params.id);
    const detail = await loadAgentDetail(getDb(), params.id, organization);
    if (!detail) throw ApiRouteError.notFound();
    return detail;
  },
);

/** Deletes the agent (revoking it first if it isn't), removing it from the Agents pages. */
export const DELETE = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params, request }) =>
    deleteAgent(params.id, {
      organizationId: user.organization.id,
      userId: user.id,
      ip: clientIp(request.headers),
    }),
);
