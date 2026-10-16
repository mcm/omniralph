import { z } from "zod";
import type { TaskList } from "@/lib/api/definitions";
import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { createTask, loadTaskList } from "@/lib/definitions/manage";

/** Settings › Tasks: the organization's tasks, built-ins first. Every member may look. */
export const GET = apiHandler({}, async ({ user }): Promise<TaskList> =>
  loadTaskList(getDb(), user),
);

/** Creates one of the organization's tasks (admins); answers its ID. */
export const POST = apiHandler({ access: "admin", body: z.unknown() }, async ({ user, body }) =>
  createTask(getDb(), user, body),
);
