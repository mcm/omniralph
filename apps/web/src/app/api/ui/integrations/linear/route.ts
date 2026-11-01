import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { disconnectTracker } from "@/lib/integrations/manage";

/** Disconnects the organization's Linear workspace (and revokes its token, best effort). */
export const DELETE = apiHandler({ access: "admin" }, async ({ user }) =>
  disconnectTracker(getDb(), user, "linear"),
);
