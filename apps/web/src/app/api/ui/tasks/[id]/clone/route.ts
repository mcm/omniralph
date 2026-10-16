import { decodeId } from "@/lib/api/definitions";
import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { cloneTask } from "@/lib/definitions/manage";

type Params = { id: string };

/** Copies a task (a built-in or one of the organization's) into a new one (admins); answers its ID. */
export const POST = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }) => cloneTask(getDb(), user, decodeId(params.id)),
);
