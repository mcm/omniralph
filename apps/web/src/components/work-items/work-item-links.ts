import type { MenuItem } from "@omniralph/ui";
import { IconExternalLink, IconListDetails } from "@tabler/icons-react";
import { trackerLabel } from "@/lib/api/trackers";
import type { WorkItemRow } from "@/lib/api/work-items";
import { backlogItemHref } from "@/screens/backlog/url";

/**
 * A work item's page in Omniralph, the internal equivalent of its page in the tracker: its
 * detail on the Backlog (`/backlog/{id}`). `workItemId` is its URL ID (`<tracker>-<issue id>`).
 */
export function workItemHref(workItemId: string): string {
  return backlogItemHref(workItemId);
}

/**
 * A work item reference: its tracker, its URL ID (null when unknown) and its URL in the
 * tracker (null: none).
 */
export interface WorkItemLinkRef {
  tracker: WorkItemRow["tracker"];
  id?: string | null;
  url: string | null;
}

/**
 * "Open work item" (its Backlog page) and "Open in <tracker>" (by its name), the pair
 * every ⋯ menu that opens a work item in its tracker offers; each only when its link is known.
 */
export function workItemLinkMenuItems(workItem: WorkItemLinkRef | null): MenuItem[] {
  if (!workItem) return [];
  const items: MenuItem[] = [];
  if (workItem.id) {
    items.push({ label: "Open work item", icon: IconListDetails, href: workItemHref(workItem.id) });
  }
  if (workItem.url) {
    items.push({
      label: `Open in ${trackerLabel(workItem.tracker)}`,
      icon: IconExternalLink,
      href: workItem.url,
    });
  }
  return items;
}
