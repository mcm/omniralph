import type { MenuItem } from "@omniralph/ui";
import { IconFileText, IconGitMerge, IconLink, IconPlayerPlay } from "@tabler/icons-react";
import { AGENT_ICON } from "@/components/row-avatars";
import { workItemLinkMenuItems } from "@/components/work-items/work-item-links";
import { VIEW_PRD } from "@/components/work-items/view-prd-sheet";
import type { InboxItem } from "@/lib/api/inbox";
import { agentHref, runHref } from "@/lib/runs/hrefs";
import { isGitLab } from "./labels";
import { inboxHref } from "./url";

/** The item's absolute Inbox URL (what Copy link copies). */
export function inboxItemUrl(item: Pick<InboxItem, "tab" | "key">, origin: string): string {
  return `${origin}${inboxHref(item.tab, item.key)}`;
}

/**
 * The detail's ⋯ "More actions" entries, only those that apply: Open work item (its Backlog
 * page) and Open in Linear, View PRD (`onViewPrd`, when the item has a PRD to show), Open
 * the run, Open merge request / Open pull request (a PR/MR ready for review), Open agent
 * (agent items, on Fleet) and Copy link.
 */
export function inboxMenuItems(
  item: InboxItem,
  onCopyLink: () => void,
  onViewPrd?: () => void,
): MenuItem[] {
  const items: MenuItem[] = [...workItemLinkMenuItems(item.workItem)];
  if (onViewPrd) items.push({ label: VIEW_PRD, icon: IconFileText, onSelect: onViewPrd });
  if (item.run)
    items.push({ label: "Open the run", icon: IconPlayerPlay, href: runHref(item.run.id) });
  if (item.kind === "pr_waiting" && item.pullRequest?.url) {
    items.push({
      label: isGitLab(item) ? "Open merge request" : "Open pull request",
      icon: IconGitMerge,
      href: item.pullRequest.url,
    });
  }
  if ((item.kind === "agent_offline" || item.kind === "agent_update_failed") && item.agent) {
    items.push({ label: "Open agent", icon: AGENT_ICON, href: agentHref(item.agent.id) });
  }
  items.push({ label: "Copy link", icon: IconLink, onSelect: onCopyLink });
  return items;
}
