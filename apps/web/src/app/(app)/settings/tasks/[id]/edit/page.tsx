import type { Metadata } from "next";
import { EditTaskView } from "../../task-editor-view";

export const metadata: Metadata = { title: "Edit task · Omniralph" };

/**
 * Edits one of the organization's tasks. Admins only; built-ins (read-only) and unknown IDs,
 * including another organization's, are not found.
 */
export default function EditTaskPage() {
  return <EditTaskView />;
}
