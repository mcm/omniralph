"use client";

import { Button } from "@iamthemcmaster/ui";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import type { UseQueryResult } from "@tanstack/react-query";
import * as React from "react";
import { Timestamp } from "./list-table";
import { useNow } from "./relative-time";

/** How long refetches may fail before the indicator turns into a warning. */
export const STALE_WARNING_AFTER_MS = 30_000;

/** The parts of a query `Freshness` reads. */
export type FreshnessQuery = Pick<
  UseQueryResult<unknown, Error>,
  "dataUpdatedAt" | "isError" | "failureCount" | "isFetching" | "refetch"
>;

/**
 * "Updated 3s ago", ticking on the browser's clock, for the page header of a list or
 * detail of in-flight entities. When refetching has failed for `STALE_WARNING_AFTER_MS`
 * it turns into a warning that the data has stopped updating, with a Retry.
 */
export function Freshness({ query }: { query: FreshnessQuery }) {
  const now = useNow();
  const failing = query.isError || query.failureCount > 0;
  // When the current run of failures started (the clock time it was first seen).
  const [failingSince, setFailingSince] = React.useState<number | null>(null);
  if (failing && failingSince === null) setFailingSince(now);
  if (!failing && failingSince !== null) setFailingSince(null);

  if (!query.dataUpdatedAt) return null;
  const updated = <Timestamp iso={new Date(query.dataUpdatedAt).toISOString()} now={now} inline />;

  if (failingSince !== null && now - failingSince >= STALE_WARNING_AFTER_MS) {
    return (
      <span className="freshness freshness-warning" role="status">
        <IconAlertTriangle size={14} aria-hidden />
        <span>Not updating: last updated {updated}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <IconRefresh size={14} />
          {query.isFetching ? "Retrying…" : "Retry"}
        </Button>
      </span>
    );
  }
  return <span className="freshness">Updated {updated}</span>;
}
