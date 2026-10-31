import type { MenuItem } from "@omniralph/ui";
import { IconExternalLink, IconListDetails } from "@tabler/icons-react";
import { backlogItemHref } from "@/screens/backlog/url";

/**
 * A work item's page in Omniralph, the internal equivalent of its Linear issue: its detail on
 * the Backlog (`/backlog/{id}`). `workItemId` is its URL ID (`linear-<issue id>`).
 */
export function workItemHref(workItemId: string): string {
  return backlogItemHref(workItemId);
}

/** A work item reference: its URL ID (null when unknown) and its Linear URL (null: none). */
export interface WorkItemLinkRef {
  id?: string | null;
  url: string | null;
}

/**
 * "Open work item" (its Backlog page) and "Open in Linear", the pair every ⋯ menu that opens
 * a work item in Linear offers; each only when its link is known.
 */
export function workItemLinkMenuItems(workItem: WorkItemLinkRef | null): MenuItem[] {
  if (!workItem) return [];
  const items: MenuItem[] = [];
  if (workItem.id) {
    items.push({ label: "Open work item", icon: IconListDetails, href: workItemHref(workItem.id) });
  }
  if (workItem.url) {
    items.push({ label: "Open in Linear", icon: IconExternalLink, href: workItem.url });
  }
  return items;
}
