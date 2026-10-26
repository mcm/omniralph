"use client";

import { TextLink } from "@omniralph/ui";
import { IconInbox } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { InboxItem } from "@/lib/api/inbox";
import { runHref } from "@/lib/runs/hrefs";
import "./inbox.css";

export const NOTHING_NEEDS_YOU = "Nothing needs you";

/** The newest running run, linked from the empty Inbox. */
export interface InboxEmptyRunning {
  /** How many runs are running. */
  count: number;
  newest: { id: string; title: string };
}

export interface InboxEmptyStateProps {
  /** What's running; nothing shows when no run is running. */
  running?: InboxEmptyRunning | null;
  /** Shown under the running line: the Backlog epic's Up next module. */
  upNext?: ReactNode;
}

/** "1 run in progress", "3 runs in progress". */
export function runsInProgress(count: number): string {
  return `${count} ${count === 1 ? "run" : "runs"} in progress`;
}

/**
 * From the Running tab's items (newest first), what the empty Inbox says is running:
 * their count and the run that started last.
 */
export function inboxEmptyRunning(items: readonly InboxItem[]): InboxEmptyRunning | null {
  let newest: InboxItem | undefined;
  for (const item of items) {
    if (!item.run) continue;
    if (!newest || Date.parse(item.since) > Date.parse(newest.since)) newest = item;
  }
  if (!newest?.run) return null;
  return { count: items.length, newest: { id: newest.run.id, title: newest.title } };
}

/**
 * The Inbox when nothing needs you (Design board InboxEmpty): the glyph, "Nothing needs
 * you", what's running with a link to the newest run, and the `upNext` slot below.
 */
export function InboxEmptyState({ running, upNext }: InboxEmptyStateProps) {
  return (
    <div className="or-inbox-empty">
      <IconInbox className="or-inbox-empty__glyph" size={32} stroke={1.5} aria-hidden="true" />
      <h2 className="or-inbox-empty__title">{NOTHING_NEEDS_YOU}</h2>
      {running ? (
        <p className="or-inbox-empty__running">
          {runsInProgress(running.count)}
          {" · "}
          <TextLink className="or-inbox-empty__run" href={runHref(running.newest.id)}>
            {running.newest.title}
          </TextLink>
        </p>
      ) : null}
      {upNext !== undefined && upNext !== null ? (
        <div className="or-inbox-empty__up-next">{upNext}</div>
      ) : null}
    </div>
  );
}
