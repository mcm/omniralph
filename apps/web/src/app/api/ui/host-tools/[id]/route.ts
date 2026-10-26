import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { removeHostTool } from "@/lib/agents/defaults";

/** Removes a host tool from the catalog, with every agent's configured path for it. */
export const DELETE = apiHandler<"admin", undefined, undefined, { id: string }>(
  { access: "admin" },
  async ({ user, params }) => removeHostTool(getDb(), user.organization.id, params.id),
);
