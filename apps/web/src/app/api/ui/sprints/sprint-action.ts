import { apiHandler } from "@/lib/api/handler";
import type { SavedSprint, SprintActionName } from "@/lib/api/sprints";
import { getDb } from "@/lib/db";
import { runSprintAction } from "@/lib/sprints/manage";

/** `POST /api/ui/sprints/{id}/{action}` (members): answers the saved sprint. */
export function sprintActionHandler(action: SprintActionName) {
  return apiHandler<"member", undefined, undefined, { id: string }>(
    {},
    async ({ user, params }): Promise<SavedSprint> =>
      runSprintAction({ db: getDb() }, user, params.id, action),
  );
}
