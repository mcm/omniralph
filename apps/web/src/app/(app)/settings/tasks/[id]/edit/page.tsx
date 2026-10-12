import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getTaskDefinition } from "@/lib/definitions";
import { decodeId } from "../../../agents/[id]/decode-id";
import { TaskForm } from "../../task-form";
import { taskFormOptions } from "../../task-form-options";

export const metadata: Metadata = { title: "Edit task · Omniralph" };

/**
 * Edits one of the organization's tasks. Admins only; built-ins (read-only)
 * and unknown IDs, including another organization's, are not found.
 */
export default async function EditTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser("admin");
  const id = decodeId((await params).id);
  const db = getDb();
  const task = await getTaskDefinition(db, user.organization.id, id);
  if (!task || task.builtin) notFound();
  const options = await taskFormOptions(db, user.organization.id);
  return <TaskForm task={task.definition} {...options} />;
}
