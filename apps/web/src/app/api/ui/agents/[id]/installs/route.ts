import { apiHandler } from "@/lib/api/handler";
import { installRequestSchema } from "@/lib/api/agents";
import { requireAgentAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { installInstallable } from "@/lib/agents/manage";

/**
 * Starts an install job of an installable on the agent; answers its id. For admins of the
 * agent's own organization (any of the user's).
 */
export const POST = apiHandler<"member", typeof installRequestSchema, undefined, { id: string }>(
  { body: installRequestSchema },
  async ({ user, params, body }) => {
    const organization = await requireAgentAccess(user, params.id, "admin");
    return installInstallable(getDb(), getDispatcher(), organization.id, params.id, body);
  },
);
