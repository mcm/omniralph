import type { WorkItemGroup } from "@/lib/api/work-items";
import type { WorkItem } from "./tracker";

/**
 * The Backlog group of a work item, from its readiness alone (the tracker integration's
 * state mapping; nothing is derived from its description): Ready to start (`ready`), Needs
 * refining (`refine`), or null when it isn't listed.
 */
export function groupFor(item: Pick<WorkItem, "readiness">): WorkItemGroup | null {
  switch (item.readiness) {
    case "ready":
      return "ready";
    case "needs_refining":
      return "refine";
    default:
      return null;
  }
}
