"use client";

import { Button, Card, Checkbox, Markdown } from "@omniralph/ui";
import { IconCheck } from "@tabler/icons-react";
import type { WorkItemDetail } from "@/lib/api/work-items";
import { checkedCount, parseTaskList, type TaskListItem } from "@/lib/work-items/task-list";
import { useWorkItemDetail } from "./use-work-item-detail";
import { useMarkWorkItemDone, useToggleTask } from "./use-work-item-tasks";
import "./manual-task-checklist.css";

export const YOUR_TASKS = "Your tasks";
export const MARK_DONE = "Mark done";
export const NO_TASKS = "This task has no checklist. Do what it describes, then mark it done.";
export const TASKS_LOAD_FAILED = "Couldn't load the tasks.";

/** "2 of 5 done". */
export function tasksProgress(tasks: readonly TaskListItem[]): string {
  return `${checkedCount(tasks)} of ${tasks.length} done`;
}

/** A task's text without its markdown marks: links keep their text, emphasis and code go. */
export function plainTaskText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`|~~)/g, "")
    .trim();
}

export interface ManualTaskChecklistProps {
  /** The work item's URL ID (`<tracker>-<issue id>`). */
  workItemId: string;
  /**
   * Offers Mark done (the item moves to Done in its tracker). Off where another control finishes
   * the work, like the Inbox's "Done, resume epic".
   */
  markDone?: boolean;
  /** Shows the description when it has no task list (off where the PRD already shows it). */
  showDescription?: boolean;
  headingLevel?: 2 | 3;
}

/**
 * What a person is expected to do for a manual work item: the task list (`- [ ]`) of its
 * description as real checkboxes, each written back to the tracker when toggled (optimistic; a
 * failure puts the box back with a toast). Without a task list it shows the description.
 * Mark done is primary once every task is checked (or when there are none).
 */
export function ManualTaskChecklist({
  workItemId,
  markDone = false,
  showDescription = true,
  headingLevel = 3,
}: ManualTaskChecklistProps) {
  const detail = useWorkItemDetail(workItemId);
  if (detail.isPending) {
    return (
      <Card title={YOUR_TASKS} headingLevel={headingLevel} className="or-tasks">
        <div className="or-tasks__skeleton" aria-busy="true" data-testid="tasks-skeleton" />
      </Card>
    );
  }
  if (detail.isError) {
    return (
      <Card title={YOUR_TASKS} headingLevel={headingLevel} className="or-tasks">
        <p className="or-tasks__error" role="alert">
          {TASKS_LOAD_FAILED}
          <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
            Retry
          </Button>
        </p>
      </Card>
    );
  }
  return (
    <Checklist
      item={detail.data}
      markDone={markDone}
      showDescription={showDescription}
      headingLevel={headingLevel}
    />
  );
}

function Checklist({
  item,
  markDone,
  showDescription,
  headingLevel,
}: {
  item: WorkItemDetail;
  markDone: boolean;
  showDescription: boolean;
  headingLevel: 2 | 3;
}) {
  const toggle = useToggleTask(item);
  const done = useMarkWorkItemDone(item);
  const tasks = parseTaskList(item.description);
  const isDone = item.state.category === "done";
  const allChecked = tasks.every((task) => task.checked);

  return (
    <Card
      title={YOUR_TASKS}
      headingLevel={headingLevel}
      className="or-tasks"
      titleAddon={
        tasks.length > 0 ? <span className="or-tasks__progress">{tasksProgress(tasks)}</span> : null
      }
      actions={
        markDone ? (
          <Button
            variant={allChecked && !isDone ? "primary" : "outline"}
            size="sm"
            icon={IconCheck}
            disabled={isDone || done.isPending}
            disabledReason={isDone ? `${item.identifier} is done` : undefined}
            onClick={() => done.mutate()}
          >
            {MARK_DONE}
          </Button>
        ) : undefined
      }
    >
      {tasks.length > 0 ? (
        <ul className="or-tasks__list">
          {tasks.map((task) => (
            <li
              key={`${task.index}:${task.text}`}
              className="or-tasks__item"
              style={{ paddingInlineStart: `${task.depth * 20}px` }}
            >
              <Checkbox
                label={plainTaskText(task.text)}
                checked={task.checked}
                onCheckedChange={(checked) =>
                  toggle.mutate({ index: task.index, text: task.text, checked })
                }
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className="or-tasks__empty">
          {showDescription && item.description.trim() ? (
            <Markdown>{item.description}</Markdown>
          ) : null}
          <p className="or-tasks__hint">{NO_TASKS}</p>
        </div>
      )}
    </Card>
  );
}
