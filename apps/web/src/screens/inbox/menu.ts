import type { MenuItem } from "@omniralph/ui";
import {
  IconExternalLink,
  IconGitMerge,
  IconLink,
  IconPlayerPlay,
  IconServer,
} from "@tabler/icons-react";
import type { InboxItem } from "@/lib/api/inbox";
import { agentHref, runHref } from "@/lib/runs/hrefs";
import { isGitLab } from "./labels";
import { inboxHref } from "./url";

/** The item's absolute Inbox URL (what Copy link copies). */
export function inboxItemUrl(item: Pick<InboxItem, "tab" | "key">, origin: string): string {
  return `${origin}${inboxHref(item.tab, item.key)}`;
}

/**
 * The detail's ⋯ "More actions" entries, only those that apply: Open in Linear (the work
 * item), Open the run, Open merge request / Open pull request (a PR/MR ready for review),
 * Open agent (agent items, on Fleet) and Copy link.
 */
export function inboxMenuItems(item: InboxItem, onCopyLink: () => void): MenuItem[] {
  const items: MenuItem[] = [];
  if (item.workItem?.url) {
    items.push({ label: "Open in Linear", icon: IconExternalLink, href: item.workItem.url });
  }
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
    items.push({ label: "Open agent", icon: IconServer, href: agentHref(item.agent.id) });
  }
  items.push({ label: "Copy link", icon: IconLink, onSelect: onCopyLink });
  return items;
}
