"use client";

import { notFound } from "next/navigation";
import { DefinitionLoading, notFoundOn404, useDefinitionId, useIsAdmin } from "../definition-page";
import { useTaskDetail, useTaskFormOptions } from "../definition-queries";
import { TaskForm } from "./task-form";
import { taskHref } from "./task-parts";

/** Creates one of the organization's tasks. Admins only. */
export function NewTaskView() {
  const isAdmin = useIsAdmin({ required: true });
  const options = useTaskFormOptions({ enabled: isAdmin });
  if (options.data) return <TaskForm task={null} {...options.data} />;
  return (
    <DefinitionLoading
      breadcrumbs={[{ label: "Tasks", href: "/settings/tasks" }, { label: "New" }]}
      query={options}
      what="the task form"
    />
  );
}

/**
 * Edits one of the organization's tasks, seeded from the live task: a change saved
 * elsewhere shows while the form isn't edited, never over an edit. Admins only; built-ins
 * (read-only) and unknown IDs, another organization's too, are not found.
 */
export function EditTaskView() {
  const id = useDefinitionId();
  const isAdmin = useIsAdmin({ required: true });
  const detail = useTaskDetail(id, { enabled: isAdmin });
  const options = useTaskFormOptions({ enabled: isAdmin });
  if (detail.data?.builtin) notFound();
  if (detail.data && options.data) {
    return <TaskForm task={detail.data.task} {...options.data} />;
  }
  if (!detail.data) notFoundOn404(detail.error);
  return (
    <DefinitionLoading
      breadcrumbs={[
        { label: "Tasks", href: "/settings/tasks" },
        { label: detail.data?.task.name ?? "Task", href: taskHref(id) },
        { label: "Edit" },
      ]}
      query={detail.data ? options : detail}
      what="the task"
    />
  );
}
