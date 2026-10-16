import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { stopRalphRun } from "@/lib/ralph/stop";
import { userDisplayName } from "@/lib/user-display";

/** Stops the run (admins): see `stopRalphRun`. */
export const POST = apiHandler<"admin", undefined, undefined, { id: string }>(
  { access: "admin" },
  async ({ user, params }) =>
    stopRalphRun(getDb(), user.organization.id, requireUuid(params.id), userDisplayName(user)),
);
