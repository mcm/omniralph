import type { TaskFormOptions } from "@/lib/api/definitions";
import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { loadTaskFormOptions } from "@/lib/definitions/manage";

/** What the task form picks from (admins). */
export const GET = apiHandler({ access: "admin" }, async ({ user }): Promise<TaskFormOptions> =>
  loadTaskFormOptions(getDb(), user),
);
