import { apiHandler } from "@/lib/api/handler";
import { requireAgentAccess } from "@/lib/api/scope";
import { clientIp } from "@/lib/agents/request";
import { revokeAgent } from "@/lib/agents/manage";

/**
 * Revokes the agent: its tokens stop working and its running jobs are redelivered; its
 * pins stay, ignored until it's re-enrolled. For admins of the agent's own organization
 * (any of the user's).
 */
export const POST = apiHandler<"member", undefined, undefined, { id: string }>(
  {},
  async ({ user, params, request }) => {
    const organization = await requireAgentAccess(user, params.id, "admin");
    return revokeAgent(params.id, {
      organizationId: organization.id,
      userId: user.id,
      ip: clientIp(request.headers),
    });
  },
);
