import type { TrackerLabels } from "@omniralph/db";
import { DEFAULT_MANUAL_LABELS } from "@omniralph/ralph";
import type { WorkItemRow } from "@/lib/api/work-items";
import { blockingLabels } from "@/lib/ralph/blocked-labels";
import type { WorkItem } from "./tracker";

/** What keeps Om from a work item, as the Backlog row and the detail expose it. */
export type WorkItemHolds = Pick<
  WorkItemRow,
  "blocked" | "blockers" | "blockedLabels" | "manual" | "manualLabels"
>;

/**
 * Classifies a top-level work item with the organization's tracker labels (matched ignoring
 * case): blocked when it has open blockers or carries a blocked label; manual when it carries
 * a manual label (`DEFAULT_MANUAL_LABELS` when the organization's list is empty). An item can
 * be both: the Backlog lists it as manual, which takes precedence.
 */
export function workItemHolds(
  item: Pick<WorkItem, "labels" | "blockedBy">,
  labels: TrackerLabels,
): WorkItemHolds {
  const blockedLabels = blockingLabels([item], labels.blockedLabels);
  const manualLabels = labels.manualLabels.length > 0 ? labels.manualLabels : DEFAULT_MANUAL_LABELS;
  const manual = blockingLabels([item], manualLabels);
  return {
    blocked: item.blockedBy.length > 0 || blockedLabels.length > 0,
    blockers: item.blockedBy.map((blocker) => blocker.identifier),
    blockedLabels,
    manual: manual.length > 0,
    manualLabels: manual,
  };
}
