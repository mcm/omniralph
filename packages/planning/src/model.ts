/**
 * The planning model: what kind of work a work item is (Fix or Story), what
 * role it plays (task, epic or feature), and which blocks relations between
 * work items are allowed. Pure functions over the tracker-neutral issue types;
 * no database, network or tracker adapter.
 */
import type { IssueSummary } from "@omniralph/tracker";

/** A Fix (a bug) or a Story (new development or an enhancement). */
export type WorkItemKind = "fix" | "story";

/** The fix labels a tracker integration uses when none are configured. */
export const DEFAULT_FIX_LABELS: readonly string[] = ["Bug"];

/**
 * A work item's kind: `fix` when any of its labels matches one of the fix labels
 * (ignoring case and surrounding spaces), else `story`.
 */
export function workItemKind(
  labels: readonly string[],
  fixLabels: readonly string[] = DEFAULT_FIX_LABELS,
): WorkItemKind {
  const fix = new Set(fixLabels.map(normalizeLabel).filter((label) => label !== ""));
  return labels.some((label) => fix.has(normalizeLabel(label))) ? "fix" : "story";
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * The role a work item plays: a `task` has no sub-issues, an `epic` has
 * sub-issues none of which have sub-issues of their own, and a `feature` has at
 * least one sub-issue with sub-issues.
 */
export type WorkItemRoleName = "task" | "epic" | "feature";

export type WorkItemRole =
  /** A task; `standalone` when it has no parent (it counts as an epic of one). */
  { role: "task"; standalone: boolean } | { role: "epic" } | { role: "feature" };

/** The fields of a work item its role depends on. */
export type RoleItem = Pick<IssueSummary, "id" | "parentId">;

/**
 * A work item's role from its sub-issues (`children`) and theirs
 * (`grandchildren`; only those whose parent is one of `children` count).
 */
export function workItemRole(
  item: RoleItem,
  children: readonly RoleItem[],
  grandchildren: readonly Pick<IssueSummary, "parentId">[],
): WorkItemRole {
  const childIds = new Set(children.filter((child) => child.id !== item.id).map((c) => c.id));
  if (childIds.size === 0) return { role: "task", standalone: !item.parentId };
  const childHasChildren = grandchildren.some(
    (grandchild) => grandchild.parentId !== undefined && childIds.has(grandchild.parentId),
  );
  return childHasChildren ? { role: "feature" } : { role: "epic" };
}

/** A work item named in a relation. */
export type ItemRef = Pick<IssueSummary, "id" | "identifier">;

/**
 * A work item as the dependency rules see it: its role, and the work item it
 * belongs to (a task's epic), if any.
 */
export interface PlannedItem extends ItemRef {
  role: WorkItemRoleName;
  parent?: ItemRef;
}

/** Why a blocks relation breaks the rules. */
export type ViolationReason =
  /** The blocker is a task in another epic. */
  | "task-in-other-epic"
  /** The blocker is a task inside the blocked epic. */
  | "own-task"
  /** The blocker is the epic the blocked task belongs to. */
  | "own-epic"
  /** The blocker is a feature. */
  | "feature";

/** A blocks relation that breaks the dependency rules, and how to fix it. */
export interface DependencyViolation {
  /** The work item that blocks. */
  blocker: ItemRef;
  /** The work item it blocks. */
  blocked: ItemRef;
  reason: ViolationReason;
  /** The work item to block on instead, when there is one (the blocker's epic). */
  blockOn?: ItemRef;
  /** What to change, e.g. "Block ENG-5 on ENG-2 instead." */
  fix: string;
  /** The bad relation and its fix in one or two sentences. */
  message: string;
}

/**
 * Every blocks relation on `item` that breaks the dependency rules:
 *
 * - A task in an epic may be blocked only by an epic (other than its own), a
 *   standalone task, or a task in its own epic.
 * - An epic may be blocked only by an epic or a standalone task.
 * - A standalone task counts as an epic of one.
 *
 * A feature is never planned through these rules (it isn't run), so it has no
 * violations. Blockers are checked in the order given; a relation of the item
 * to itself is ignored.
 */
export function dependencyViolations(
  item: PlannedItem,
  blockers: readonly PlannedItem[],
): DependencyViolation[] {
  if (item.role === "feature") return [];
  const epic = epicOf(item);
  const violations: DependencyViolation[] = [];
  for (const blocker of blockers) {
    if (blocker.id === item.id) continue;
    const violation = violationFor(item, epic, blocker);
    if (violation) violations.push(violation);
  }
  return violations;
}

/** The epic a work item counts in: a task's parent, else the item itself. */
function epicOf(item: PlannedItem): ItemRef {
  return item.role === "task" && item.parent ? item.parent : item;
}

function violationFor(
  item: PlannedItem,
  epic: ItemRef,
  blocker: PlannedItem,
): DependencyViolation | undefined {
  const blocked = ref(item);
  const by = ref(blocker);
  const inEpic = item.role === "task" && item.parent !== undefined;

  if (blocker.role === "feature") {
    return violation(
      blocked,
      by,
      "feature",
      `${by.identifier} is a feature, and work can't be blocked by a feature.`,
      `Block ${blocked.identifier} on the epic in ${by.identifier} it waits for instead.`,
    );
  }

  if (blocker.role === "epic") {
    if (inEpic && blocker.id === epic.id) {
      return violation(
        blocked,
        by,
        "own-epic",
        `${blocked.identifier} is a task in ${by.identifier}, so it can't be blocked by its own epic.`,
        `Remove the relation.`,
      );
    }
    return undefined;
  }

  // The blocker is a task.
  if (!blocker.parent) return undefined;
  if (inEpic && blocker.parent.id === epic.id) return undefined;
  if (!inEpic && blocker.parent.id === item.id) {
    return violation(
      blocked,
      by,
      "own-task",
      `${by.identifier} is a task in ${blocked.identifier}, so it can't block its own epic.`,
      `Remove the relation.`,
    );
  }
  const blockOn = ref(blocker.parent);
  return violation(
    blocked,
    by,
    "task-in-other-epic",
    `${by.identifier} is a task in another epic, ${blockOn.identifier}.`,
    `Block ${blocked.identifier} on ${blockOn.identifier} instead.`,
    blockOn,
  );
}

function violation(
  blocked: ItemRef,
  blocker: ItemRef,
  reason: ViolationReason,
  why: string,
  fix: string,
  blockOn?: ItemRef,
): DependencyViolation {
  return {
    blocker,
    blocked,
    reason,
    ...(blockOn ? { blockOn } : {}),
    fix,
    message: `${blocked.identifier} is blocked by ${blocker.identifier}: ${why} ${fix}`,
  };
}

function ref(item: ItemRef): ItemRef {
  return { id: item.id, identifier: item.identifier };
}
