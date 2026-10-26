"use client";

import { useState, type ReactNode } from "react";
import { Button } from "../actions/button.js";

export interface ActivityEntry {
  id: string;
  /** When it happened (a `Date` or an ISO timestamp). */
  at: Date | string;
  /** The entry as a sentence (Design rule 4). */
  text: ReactNode;
}

export interface ActivityListProps {
  /** In display order (normally newest first). */
  entries: readonly ActivityEntry[];
  /** Names the list. Defaults to "Activity". */
  "aria-label"?: string;
  /** How many entries show before "Show all {n}". Defaults to 10. */
  limit?: number;
  className?: string;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** The date column's text in local time, e.g. "Oct 24 14:02". */
export function activityDate(at: Date | string): string {
  const date = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) return "";
  return `${DATE_FORMAT.format(date)} ${TIME_FORMAT.format(date)}`;
}

/**
 * A dated activity list: a fixed-width mono date column and a sentence per entry. The
 * first `limit` entries show, then a "Show all {n}" button reveals the rest.
 */
export function ActivityList({
  entries,
  "aria-label": label = "Activity",
  limit = 10,
  className,
}: ActivityListProps) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? entries : entries.slice(0, limit);
  return (
    <div className={["or-activity", className].filter(Boolean).join(" ")}>
      <ol className="or-activity__list" aria-label={label}>
        {shown.map((entry) => {
          const date = typeof entry.at === "string" ? entry.at : entry.at.toISOString();
          return (
            <li key={entry.id} className="or-activity__entry">
              <time className="or-activity__date or-mono" dateTime={date}>
                {activityDate(entry.at)}
              </time>
              <span className="or-activity__text">{entry.text}</span>
            </li>
          );
        })}
      </ol>
      {!expanded && entries.length > limit ? (
        <Button
          variant="ghost"
          size="sm"
          className="or-activity__more"
          onClick={() => setExpanded(true)}
        >
          {`Show all ${entries.length}`}
        </Button>
      ) : null}
    </div>
  );
}
