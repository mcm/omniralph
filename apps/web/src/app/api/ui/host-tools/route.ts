import { apiHandler } from "@/lib/api/handler";
import { addHostToolSchema } from "@/lib/api/agent-defaults";
import { getDb } from "@/lib/db";
import { addHostTool, loadHostToolCatalog } from "@/lib/agents/defaults";

/** The host tool catalog (admins): the organization's catalog. */
export const GET = apiHandler({ access: "admin" }, async ({ user }) => ({
  hostTools: await loadHostToolCatalog(getDb(), user.organization.id),
}));

/** Adds a host tool (`{ name, description? }`); answers its `hostToolId`. */
export const POST = apiHandler(
  { access: "admin", body: addHostToolSchema },
  async ({ user, body }) => addHostTool(getDb(), user.organization.id, body),
);
