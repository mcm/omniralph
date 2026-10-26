"use client";

import { EmptyState, StatusLine, toast, Toolbar } from "@omniralph/ui";
import type { InboxItem } from "@/lib/api/inbox";
import { InboxHeaderBadges } from "./inbox-badges";
import { inboxItemLabel } from "./labels";
import { inboxItemUrl, inboxMenuItems } from "./menu";

/** Shown in the detail pane when the URL's item no longer derives an item. */
export const ITEM_HANDLED = "This item was already handled.";

async function copyLink(item: InboxItem) {
  try {
    await navigator.clipboard.writeText(inboxItemUrl(item, window.location.origin));
    toast("Link copied");
  } catch {
    toast("Couldn't copy the link.", { variant: "danger" });
  }
}

/**
 * The selected item's detail: its header badges and ⋯ menu, its status line, the title as
 * the pane's heading, and why it's here.
 */
export function InboxDetail({
  item,
  now,
  showOrganization,
}: {
  item: InboxItem;
  now: number;
  showOrganization: boolean;
}) {
  const label = inboxItemLabel(item, now);
  return (
    <article className="or-inbox-detail" aria-labelledby="or-inbox-detail-title">
      <header className="or-inbox-detail__head">
        <div className="or-inbox-detail__badges">
          <InboxHeaderBadges item={item} showOrganization={showOrganization} />
        </div>
        <Toolbar label="Item actions" menu={inboxMenuItems(item, () => void copyLink(item))} />
      </header>
      <StatusLine tone={label.tone} dotLabel={label.rowLabel}>
        {label.statusLine}
      </StatusLine>
      <h2 id="or-inbox-detail-title" className="or-inbox-detail__title">
        {item.title}
      </h2>
      <p className="or-inbox-detail__reason">{item.reason}</p>
    </article>
  );
}

/** The detail pane when the selected item is gone (decided elsewhere, or by someone else). */
export function InboxItemHandled() {
  return <EmptyState className="or-inbox-detail__empty" title={ITEM_HANDLED} />;
}
