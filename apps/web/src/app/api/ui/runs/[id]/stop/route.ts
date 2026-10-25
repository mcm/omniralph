import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireRunAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { stopRalphRun } from "@/lib/ralph/stop";
import { userDisplayName } from "@/lib/user-display";

/** Stops an epic or request run (admins of its organization): see `stopRalphRun`. */
export const POST = apiHandler<"admin", undefined, undefined, { id: string }>(
  { access: "admin" },
  async ({ user, params }) => {
    const { run } = await requireRunAccess(user, params.id, {
      role: "admin",
      notFoundMessage: "That run doesn't exist.",
    });
    if (run.kind !== "epic" && run.kind !== "request") {
      throw new ApiRouteError(400, "Only epic and request runs can be stopped.", "not_stoppable");
    }
    return stopRalphRun(getDb(), run.organizationId, run.id, userDisplayName(user));
  },
);
