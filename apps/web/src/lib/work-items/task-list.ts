/**
 * Task lists in a work item's description (markdown checkboxes): `- [ ] Do it`,
 * `* [x] Done`, `+ [ ]` and `1. [ ]`, also nested and inside block quotes. Lines in fenced
 * code blocks are never tasks. Shared by the checklist (client) and the toggle endpoint
 * (server), so both count the same tasks in the same order.
 */

export interface TaskListItem {
  /** Its position among the description's tasks, from 0. */
  index: number;
  checked: boolean;
  /** Its text after the checkbox, trimmed (markdown, single line). */
  text: string;
  /** How deeply it's nested: 0 at the top level, one per two columns of indent. */
  depth: number;
}

/** The checkbox's prefix (indent, quote marks, bullet, `[`), mark and the rest of the line. */
const TASK_LINE = /^((?:\s*>\s?)*(\s*)(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])\]\s+(\S.*)$/;
const FENCE = /^(?:\s*>\s?)*\s*(`{3,}|~{3,})/;

interface TaskLine extends TaskListItem {
  /** The line's index among the description's lines. */
  line: number;
  prefix: string;
}

function lines(markdown: string): string[] {
  return markdown.split(/\r?\n/);
}

function taskLines(markdown: string): TaskLine[] {
  const tasks: TaskLine[] = [];
  let fence: string | null = null;
  lines(markdown).forEach((text, line) => {
    const opener = FENCE.exec(text)?.[1];
    if (fence) {
      // A fence closes on the same character, at least as long as it opened.
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
      return;
    }
    if (opener) {
      fence = opener;
      return;
    }
    const match = TASK_LINE.exec(text);
    if (!match) return;
    const [, prefix, indent, mark, rest] = match;
    tasks.push({
      index: tasks.length,
      checked: mark !== " ",
      text: rest!.trim(),
      depth: Math.floor(indent!.replace(/\t/g, "  ").length / 2),
      line,
      prefix: prefix!,
    });
  });
  return tasks;
}

/** The description's tasks, in order. */
export function parseTaskList(markdown: string): TaskListItem[] {
  return taskLines(markdown).map(({ index, checked, text, depth }) => ({
    index,
    checked,
    text,
    depth,
  }));
}

/**
 * The description with task `index` checked or unchecked; everything else, line endings
 * included, as it was. Unchanged when there is no such task or it's already so.
 */
export function setTaskChecked(markdown: string, index: number, checked: boolean): string {
  const task = taskLines(markdown)[index];
  if (!task || task.checked === checked) return markdown;
  const parts = markdown.split(/(\r?\n)/);
  // `parts` alternates lines and their separators: line n is at 2n.
  const at = task.line * 2;
  const line = parts[at]!;
  parts[at] = `${task.prefix}${checked ? "x" : " "}${line.slice(task.prefix.length + 1)}`;
  return parts.join("");
}

/**
 * Which task of `tasks` a toggle made on `target` means, now that the description may have
 * changed since it was read: the same position when its text still matches, else the one
 * task with that text. Null when it's gone, or its text is ambiguous.
 */
export function locateTask(
  tasks: readonly TaskListItem[],
  target: { index: number; text: string },
): number | null {
  if (tasks[target.index]?.text === target.text) return target.index;
  const same = tasks.filter((task) => task.text === target.text);
  return same.length === 1 ? same[0]!.index : null;
}

/** How many tasks are checked. */
export function checkedCount(tasks: readonly TaskListItem[]): number {
  return tasks.filter((task) => task.checked).length;
}
