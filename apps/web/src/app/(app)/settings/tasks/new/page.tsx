import type { Metadata } from "next";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { TaskForm } from "../task-form";
import { taskFormOptions } from "../task-form-options";

export const metadata: Metadata = { title: "New task · Omniralph" };

/** Creates one of the organization's tasks. Admins only. */
export default async function NewTaskPage() {
  const user = await requirePageUser("admin");
  const options = await taskFormOptions(getDb(), user.organization.id);
  return <TaskForm task={null} {...options} />;
}
