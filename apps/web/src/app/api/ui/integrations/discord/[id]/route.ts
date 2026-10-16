import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { disconnectDiscord } from "@/lib/integrations/manage";

type Params = { id: string };

/** Disconnects one of the organization's Discord servers (and makes the bot leave it, best effort). */
export const DELETE = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }) => disconnectDiscord(getDb(), user, requireUuid(params.id)),
);
