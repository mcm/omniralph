import type { Metadata } from "next";
import { TasksView } from "./tasks-view";

export const metadata: Metadata = { title: "Tasks · Omniralph" };

/** The organization's task definitions, grouped by task type. Every member may look. */
export default function TasksPage() {
  return <TasksView />;
}
