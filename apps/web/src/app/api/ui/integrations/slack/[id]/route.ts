import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { disconnectSlack } from "@/lib/integrations/manage";

type Params = { id: string };

/** Disconnects one of the organization's Slack workspaces (and revokes its bot token, best effort). */
export const DELETE = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }) => disconnectSlack(getDb(), user, requireUuid(params.id)),
);
