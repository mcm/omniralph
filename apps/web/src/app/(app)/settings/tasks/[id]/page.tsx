import type { Metadata } from "next";
import { TaskDetailView } from "./task-detail-view";

export const metadata: Metadata = { title: "Task · Omniralph" };

/**
 * One task definition of the organization (a built-in or one of its rows), what its runs
 * need and what uses it. Unknown IDs, including another organization's, are not found.
 */
export default function TaskPage() {
  return <TaskDetailView />;
}
