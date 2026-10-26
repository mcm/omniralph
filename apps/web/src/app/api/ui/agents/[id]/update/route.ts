import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { requestAgentUpdate } from "@/lib/agents/manage";

/** "Update now": the agent updates with its next heartbeat; answers the version requested. */
export const POST = apiHandler<"admin", undefined, undefined, { id: string }>(
  { access: "admin" },
  async ({ user, params }) => requestAgentUpdate(getDb(), user.organization.id, params.id),
);
