import { INBOX_TABS, type InboxTabParam } from "@/lib/api/inbox";

/** The Inbox's URL state: `/?tab=needs-you|problems|running&item={key}`. */
export interface InboxUrlState {
  tab: InboxTabParam;
  /** The selected item's key; null selects the tab's first item. */
  item: string | null;
}

/** Reads the Inbox's URL state; an unknown or missing `tab` opens Needs you. */
export function parseInboxParams(params: Pick<URLSearchParams, "get">): InboxUrlState {
  const tab = params.get("tab");
  return {
    tab: (INBOX_TABS as readonly string[]).includes(tab ?? "")
      ? (tab as InboxTabParam)
      : "needs-you",
    item: params.get("item") || null,
  };
}

/** The Inbox's URL for a tab and, optionally, a selected item. */
export function inboxHref(tab: InboxTabParam, item?: string | null): string {
  const search = new URLSearchParams({ tab });
  if (item) search.set("item", item);
  return `/?${search}`;
}
