import type { Metadata } from "next";
import { NewTaskView } from "../task-editor-view";

export const metadata: Metadata = { title: "New task · Omniralph" };

/** Creates one of the organization's tasks. Admins only. */
export default function NewTaskPage() {
  return <NewTaskView />;
}
