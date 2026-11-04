import { apiHandler } from "@/lib/api/handler";
import type { SavedSprint, SprintActionName } from "@/lib/api/sprints";
import { getDb } from "@/lib/db";
import { runSprintAction } from "@/lib/sprints/manage";

/** `POST /api/ui/sprints/{id}/{action}` (admins): answers the saved sprint. */
export function sprintActionHandler(action: SprintActionName) {
  return apiHandler<"admin", undefined, undefined, { id: string }>(
    { access: "admin" },
    async ({ user, params }): Promise<SavedSprint> =>
      runSprintAction({ db: getDb() }, user, params.id, action),
  );
}
