import { apiHandler } from "@/lib/api/handler";
import { createSprintBodySchema, type SavedSprint, type SprintList } from "@/lib/api/sprints";
import { getDb } from "@/lib/db";
import { createSprint, loadSprintList } from "@/lib/sprints/manage";

/** The organization's sprints, newest first, each with its repo and its epics in order. Every member may look. */
export const GET = apiHandler({}, async ({ user }): Promise<SprintList> =>
  loadSprintList(getDb(), user),
);

/**
 * Creates a draft sprint (admins): `{ repositoryId, name, mergeTogether?, epics? }`, `epics`
 * the work item URL IDs in order. 400 when an item isn't an open epic or the order puts an
 * epic before one that blocks it, 409 when an epic is already in another active sprint.
 */
export const POST = apiHandler(
  { access: "admin", body: createSprintBodySchema },
  async ({ user, body }): Promise<SavedSprint> => createSprint({ db: getDb() }, user, body),
);
