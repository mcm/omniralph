import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { disconnectLinear } from "@/lib/integrations/manage";

/** Disconnects the organization's Linear workspace (and revokes its token, best effort). */
export const DELETE = apiHandler({ access: "admin" }, async ({ user }) =>
  disconnectLinear(getDb(), user),
);
