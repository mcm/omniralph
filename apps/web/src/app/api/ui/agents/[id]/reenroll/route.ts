import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireAgentAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { createReenrollment, serverUrl } from "@/lib/agents/enrollment";

/**
 * Creates a one-time enrollment token (valid for 1 hour) bound to the agent: redeeming it
 * re-enrolls the agent in place, keeping its ID, name, pins and history (TOOL-925). For
 * admins of the agent's own organization (any of the user's).
 */
export const POST = apiHandler<"member", undefined, undefined, { id: string }>(
  {},
  async ({ user, params, request }) => {
    const organization = await requireAgentAccess(user, params.id, "admin");
    const created = await createReenrollment(getDb(), {
      organizationId: organization.id,
      agentId: params.id,
      createdBy: user.id,
      serverUrl: serverUrl(request.headers),
    });
    if (!created) throw ApiRouteError.notFound();
    return created;
  },
);
