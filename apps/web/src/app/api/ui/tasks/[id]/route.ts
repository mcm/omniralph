import { z } from "zod";
import { decodeId, type TaskDetail } from "@/lib/api/definitions";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { deleteTask, loadTaskDetail, updateTask } from "@/lib/definitions/manage";

type Params = { id: string };

/** One task of the organization (a built-in or one of its rows); unknown IDs, another organization's too, are 404. */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<TaskDetail> => {
    const detail = await loadTaskDetail(getDb(), user, decodeId(params.id));
    if (!detail) throw ApiRouteError.notFound();
    return detail;
  },
);

/** Replaces one of the organization's tasks (admins). */
export const PUT = apiHandler<"admin", z.ZodUnknown, undefined, Params>(
  { access: "admin", body: z.unknown() },
  async ({ user, params, body }) => updateTask(getDb(), user, decodeId(params.id), body),
);

/** Deletes one of the organization's tasks (admins). */
export const DELETE = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }) => deleteTask(getDb(), user, decodeId(params.id)),
);
