"use client";

import { Button, InfoPopover } from "@omniralph/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import * as React from "react";
import { api } from "@/lib/api/client";
import { settingsHistoryKeys } from "@/lib/api/keys";
import {
  settingsHistorySchema,
  type SettingsHistory,
  type SettingsHistoryEntry,
} from "@/lib/api/settings-history";
import { formatDateTime, formatRelative } from "@/lib/format-date";
import type { SettingsSection } from "@/lib/live/events";
import { useCurrentUser } from "./current-user";
import { useQueryKeys } from "./query-provider";
import "./change-history-popover.css";

/** Shown when the section has no recorded change. */
export const NO_CHANGES = "No changes recorded yet";

/** Shown when the history can't load. */
export const HISTORY_FAILED = "Couldn't load the change history.";

type SettingsValue = SettingsHistoryEntry["changes"][number]["before"];

/** A recorded value in words: switches on/off, lists joined, nothing as "None". */
export function settingsValueText(value: SettingsValue): string {
  if (value === null || value === "") return "None";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value)) return value.length === 0 ? "None" : value.join(", ");
  return String(value);
}

/** "Last changed by Ada, 5 min ago, 3 runs since". */
export function lastChangedText(entry: SettingsHistoryEntry, now: number): string {
  const runs = entry.runsSince === 1 ? "1 run since" : `${entry.runsSince} runs since`;
  return `Last changed by ${entry.actor.name}, ${formatRelative(entry.changedAt, now)}, ${runs}`;
}

export interface ChangeHistoryPopoverProps {
  /** The settings section, e.g. `repository.reviews`. */
  section: SettingsSection;
  /** The section's subject (a repository or connection ID), when it has one. */
  subject?: string;
  /** The subject's organization, when it isn't the active one (the active one by default). */
  organization?: string;
  /** The section's latest change, from the screen's own query; null before any. */
  latest: SettingsHistoryEntry | null;
}

/**
 * A settings card's ⓘ (Design rule 11): who changed the card last, when, and how many runs
 * started since, then on demand every recorded change, newest first, each with its fields'
 * before and after values, a page at a time (`GET /api/ui/settings-history`). A live query
 * while open: the section's `settings` events and its subject's `repository` events refetch
 * it.
 */
export function ChangeHistoryPopover(props: ChangeHistoryPopoverProps) {
  return (
    <InfoPopover label="Change history">
      <ChangeHistory {...props} />
    </InfoPopover>
  );
}

/** The popover's content: mounted (and fetched) only while it is open. */
function ChangeHistory({ section, subject, organization, latest }: ChangeHistoryPopoverProps) {
  const keys = useQueryKeys();
  const user = useCurrentUser();
  const [now] = React.useState(() => Date.now());
  const history = useInfiniteQuery({
    queryKey: settingsHistoryKeys(keys).history(section, subject, organization),
    queryFn: ({ pageParam, signal }) =>
      api.get("/api/ui/settings-history", settingsHistorySchema, {
        params: { section, subject, organization, cursor: pageParam },
        organizationId: user.organization.id,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: SettingsHistory) => page.next ?? undefined,
  });

  const newest = history.data?.pages[0]?.latest ?? latest;
  const entries = history.data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <div className="or-change-history">
      <p className="or-change-history__latest">
        {newest ? lastChangedText(newest, now) : NO_CHANGES}
      </p>
      {history.isError ? (
        <p className="or-change-history__error" role="alert">
          {HISTORY_FAILED}{" "}
          <Button variant="outline" size="sm" onClick={() => void history.refetch()}>
            Retry
          </Button>
        </p>
      ) : history.isPending ? (
        <p className="or-change-history__loading" aria-busy="true">
          Loading changes…
        </p>
      ) : entries.length > 0 ? (
        <ol className="or-change-history__entries" aria-label="Changes">
          {entries.map((entry) => (
            <li key={entry.id} className="or-change-history__entry">
              <p className="or-change-history__meta">
                <time dateTime={entry.changedAt}>{formatDateTime(entry.changedAt)}</time>
                {" · "}
                <span>{entry.actor.name}</span>
              </p>
              <ul className="or-change-history__changes">
                {entry.changes.map((change) => (
                  <li key={change.field}>
                    {change.label}: {settingsValueText(change.before)} →{" "}
                    {settingsValueText(change.after)}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      ) : null}
      {history.hasNextPage ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? "Loading…" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}
