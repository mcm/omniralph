import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireRunAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { stopRalphRun } from "@/lib/ralph/stop";
import { RUN_ACTION_ROLES } from "@/lib/runs/actions";
import { userDisplayName } from "@/lib/user-display";

/** Stops an epic or request run (admins of its organization): see `stopRalphRun`. */
export const POST = apiHandler<"admin", undefined, undefined, { id: string }>(
  { access: RUN_ACTION_ROLES.stop },
  async ({ user, params }) => {
    const { run } = await requireRunAccess(user, params.id, {
      role: RUN_ACTION_ROLES.stop,
      notFoundMessage: "That run doesn't exist.",
    });
    if (run.kind !== "epic" && run.kind !== "request") {
      throw new ApiRouteError(400, "Only epic and request runs can be stopped.", "not_stoppable");
    }
    return stopRalphRun(getDb(), run.organizationId, run.id, userDisplayName(user));
  },
);
