"use client";

import {
  Button,
  EmptyState,
  ListRow,
  RowList,
  SplitView,
  TabPanel,
  Tabs,
  type TabItem,
} from "@omniralph/ui";
import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";
import { useCurrentUser } from "@/components/current-user";
import type { InboxCountsResponse, InboxItem, InboxTabParam } from "@/lib/api/inbox";
import { useClock } from "../clock";
import { InboxRowBadges } from "./inbox-badges";
import { InboxDetail, InboxItemHandled } from "./inbox-detail";
import { compactAge, inboxItemLabel } from "./labels";
import { useInboxCounts, useInboxFeed } from "./queries";
import { inboxHref, parseInboxParams } from "./url";
import "./inbox.css";

/** The Inbox's list column: 400 px from a 1200 px viewport, 340 px below. */
export const INBOX_LIST_WIDTH = { wide: 400, narrow: 340 } as const;

const TAB_LABELS: Record<InboxTabParam, string> = {
  "needs-you": "Needs you",
  problems: "Problems",
  running: "Running",
};

const COUNT_OF: Record<InboxTabParam, keyof InboxCountsResponse> = {
  "needs-you": "needsYou",
  problems: "problems",
  running: "running",
};

const EMPTY_TAB: Record<InboxTabParam, string> = {
  "needs-you": "Nothing needs you",
  problems: "No problems",
  running: "Nothing is running",
};

/**
 * When the selected item leaves the feed (a change event), the item to select instead:
 * the next one after it that is still there, else the one before it, else none.
 */
export function nextSelection(
  previous: readonly InboxItem[],
  current: readonly InboxItem[],
  removedKey: string,
): string | null {
  const present = new Set(current.map((item) => item.key));
  const index = previous.findIndex((item) => item.key === removedKey);
  const after = previous.slice(index + 1).find((item) => present.has(item.key));
  const before = previous
    .slice(0, Math.max(index, 0))
    .reverse()
    .find((item) => present.has(item.key));
  return (after ?? before ?? current[0])?.key ?? null;
}

/**
 * The Inbox at `/` (Design boards Main and InboxUVL): the title, the Needs you, Problems
 * and Running tabs with their counts, the tab's items, and the selected item's detail
 * beside them. The tab and the selected item live in the URL (`?tab=&item=`); without an
 * item the tab's first is selected. Every query is live (change events refetch them).
 */
export function InboxView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { tab, item: itemParam } = parseInboxParams(searchParams);
  const user = useCurrentUser();
  const showOrganization = user.scope === "all";
  const now = useClock();

  const counts = useInboxCounts();
  const feed = useInboxFeed(tab);
  const items = feed.data?.items;

  // The selected item left the feed: select the next one (in render, then in the URL).
  const [seen, setSeen] = React.useState(items);
  const [moved, setMoved] = React.useState<{ from: string; to: string | null } | null>(null);
  if (items !== seen) {
    setSeen(items);
    if (
      itemParam &&
      items &&
      seen &&
      seen.some((item) => item.key === itemParam) &&
      !items.some((item) => item.key === itemParam)
    ) {
      setMoved({ from: itemParam, to: nextSelection(seen, items, itemParam) });
    }
  }
  const movedFrom = moved?.from === itemParam ? moved : null;
  React.useEffect(() => {
    if (movedFrom) router.replace(inboxHref(tab, movedFrom.to), { scroll: false });
  }, [movedFrom, router, tab]);

  const selectedKey = movedFrom ? movedFrom.to : itemParam;
  const selected = selectedKey ? items?.find((item) => item.key === selectedKey) : items?.[0];
  const handled = Boolean(selectedKey && items && !selected);

  const tabs: TabItem<InboxTabParam>[] = (Object.keys(TAB_LABELS) as InboxTabParam[]).map(
    (value) => ({
      value,
      label: TAB_LABELS[value],
      count: counts.data?.[COUNT_OF[value]],
      countTone: value === "needs-you" ? "need" : value === "problems" ? "fail" : "default",
    }),
  );

  const list = (
    <div className="or-inbox__list">
      <h1 className="or-inbox__title">Inbox</h1>
      <Tabs
        tabs={tabs}
        value={tab}
        onValueChange={(next) => router.push(inboxHref(next), { scroll: false })}
        aria-label="Inbox"
      >
        <TabPanel value={tab} className="or-inbox__panel">
          {feed.isError ? (
            <EmptyState
              headingLevel={2}
              title="Couldn't load the Inbox"
              description={feed.error.message}
              action={
                <Button variant="outline" onClick={() => void feed.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : items === undefined ? null : items.length === 0 ? (
            <EmptyState headingLevel={2} title={EMPTY_TAB[tab]} />
          ) : (
            <RowList aria-label={TAB_LABELS[tab]}>
              {items.map((item) => {
                const label = inboxItemLabel(item, now);
                return (
                  <ListRow
                    key={item.key}
                    href={inboxHref(tab, item.key)}
                    title={item.title}
                    kindLabel={label.rowLabel}
                    tone={label.tone}
                    time={<time dateTime={item.since}>{compactAge(item.since, now)}</time>}
                    meta={<InboxRowBadges item={item} showOrganization={showOrganization} />}
                    selected={item.key === selected?.key}
                  />
                );
              })}
            </RowList>
          )}
        </TabPanel>
      </Tabs>
    </div>
  );

  const detail = selected ? (
    <InboxDetail item={selected} now={now} showOrganization={showOrganization} />
  ) : handled ? (
    <InboxItemHandled />
  ) : null;

  return (
    <SplitView
      className="or-inbox"
      list={list}
      detail={detail}
      view={itemParam ? "detail" : "list"}
      backLink={{ label: "Inbox", href: inboxHref(tab) }}
      listLabel="Inbox"
      detailLabel="Item"
      listWidth={INBOX_LIST_WIDTH}
    />
  );
}
