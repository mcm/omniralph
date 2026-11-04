import { apiHandler } from "@/lib/api/handler";
import { updateSprintBodySchema, type SavedSprint, type SprintRow } from "@/lib/api/sprints";
import { getDb } from "@/lib/db";
import { deleteSprint, loadSprint, updateSprint } from "@/lib/sprints/manage";

type Params = { id: string };

/** One sprint of the organization; another organization's or an unknown ID is 404. */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<SprintRow> => loadSprint(getDb(), user, params.id),
);

/**
 * Renames a draft sprint, switches merge together, or saves its whole order (admins):
 * `{ name?, mergeTogether?, epics? }`. A started sprint is refused (409), as is an epic
 * already in another active sprint; an item that isn't an open epic or an order that puts an
 * epic before one that blocks it answers 400.
 */
export const PATCH = apiHandler<"admin", typeof updateSprintBodySchema, undefined, Params>(
  { access: "admin", body: updateSprintBodySchema },
  async ({ user, params, body }): Promise<SavedSprint> =>
    updateSprint({ db: getDb() }, user, params.id, body),
);

/** Deletes a draft sprint and its order (admins); a started sprint is refused (409). */
export const DELETE = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }) => deleteSprint(getDb(), user, params.id),
);
