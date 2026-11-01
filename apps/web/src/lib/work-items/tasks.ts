import "server-only";
import { ApiRouteError } from "@/lib/api/handler";
import type { WorkItemTaskBody, WorkItemTaskResult } from "@/lib/api/work-items";
import { trackerName } from "@/lib/tracker/adapters";
import { trackerCall, type ResolvedWorkItem } from "./item";
import { locateTask, parseTaskList, setTaskChecked } from "./task-list";
import { WorkItemConflictError, type TrackerKind } from "./tracker";

/** The task the person toggled isn't in the description any more (or is there twice). */
export const taskGoneMessage = (identifier: string) =>
  `That task changed in ${identifier}. Reload to see the current list.`;

/** The tracker kept changing under the toggle (both tries were stale). */
export const taskConflictMessage = (identifier: string, tracker: TrackerKind) =>
  `${identifier} changed in ${trackerName(tracker)} while saving. Try again.`;

/**
 * Checks or unchecks one task of a work item's description and writes it to the tracker.
 * The description is the tracker's current one (read when the item was resolved), not the
 * client's copy: the task is found again there by its position and text (`locateTask`), so
 * someone else's edit elsewhere in the description is kept. The write only lands if the item
 * hasn't changed since that read; when it has, it reads the item again and tries once more.
 * Setting a task to the state it already has writes nothing. 409 when the task is gone.
 */
export async function setWorkItemTask(
  resolved: ResolvedWorkItem,
  input: WorkItemTaskBody,
): Promise<WorkItemTaskResult> {
  const { tracker } = resolved;
  let item = resolved.item;
  for (let attempt = 0; ; attempt += 1) {
    const tasks = parseTaskList(item.description);
    const index = locateTask(tasks, input);
    if (index === null) {
      throw new ApiRouteError(409, taskGoneMessage(item.identifier), "task_changed");
    }
    if (tasks[index]!.checked === input.checked) {
      return { description: item.description, updatedAt: item.updatedAt };
    }
    const description = setTaskChecked(item.description, index, input.checked);
    try {
      await tracker.update(item.id, { description }, { ifUpdatedAt: item.updatedAt });
    } catch (error) {
      if (!(error instanceof WorkItemConflictError)) {
        return trackerCall(tracker, `Saving a task of ${item.identifier}`, () =>
          Promise.reject(error),
        );
      }
      if (attempt > 0) {
        throw new ApiRouteError(
          409,
          taskConflictMessage(item.identifier, tracker.kind),
          "conflict",
        );
      }
      const id = item.id;
      item = await trackerCall(tracker, `Reading ${item.identifier}`, () => tracker.get(id));
      continue;
    }
    const saved = await trackerCall(tracker, `Reading ${item.identifier}`, () =>
      tracker.get(item.id),
    );
    return { description, updatedAt: saved.updatedAt };
  }
}

/** Mark done: moves a work item to its team's first Done state. */
export async function markWorkItemDone(resolved: ResolvedWorkItem): Promise<void> {
  const { item, tracker } = resolved;
  await trackerCall(tracker, `Marking ${item.identifier} done`, () =>
    tracker.setState(item.id, "done"),
  );
}
