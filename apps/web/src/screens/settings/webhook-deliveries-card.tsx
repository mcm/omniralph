"use client";

import {
  Button,
  Card,
  DataTable,
  EmptyState,
  IconButton,
  RepoBadge,
  SegmentedControl,
  useLinkComponent,
  type DataTableColumn,
} from "@omniralph/ui";
import { IconRotate } from "@tabler/icons-react";
import { createElement, useState, type ReactNode } from "react";
import type { Connection } from "@/lib/api/connections";
import {
  deliveryEventLabel,
  deliveryOutcomeText,
  deliveryReceivedText,
} from "@/lib/connections/deliveries";
import { runHref } from "@/lib/runs/links";
import { useDeliveries } from "./queries";
import { useReplayDelivery, type DeliveryFilter, type ListedDelivery } from "./replay";
import "./deliveries.css";

/** Under the table: how long payloads stay and what a replay does. */
export const DELIVERIES_RETENTION_NOTE =
  "Payloads are kept for 14 days. Replay runs the event through today's routing and settings.";

/** The empty log, per filter. */
export const NO_DELIVERIES: Record<DeliveryFilter, string> = {
  all: "No deliveries in the last 14 days",
  failed: "No failed deliveries in the last 14 days",
  ignored: "No ignored deliveries in the last 14 days",
};

/** A replay the server hasn't answered yet. */
export const REPLAYING = "Replaying…";

function AppLink({ href, children }: { href: string; children: ReactNode }) {
  const link = useLinkComponent();
  return createElement(link, { href, className: "or-link" }, children);
}

const cx = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(" ");

function Outcome({ delivery }: { delivery: ListedDelivery }) {
  const failed = !delivery.replaying && delivery.outcome === "failed";
  const text = (
    <span className={cx("or-deliveries__outcome", failed && "or-deliveries__outcome--fail")}>
      {delivery.replaying ? REPLAYING : deliveryOutcomeText(delivery)}
    </span>
  );
  return delivery.run && !delivery.replaying ? (
    <AppLink href={runHref(delivery.run.id)}>{text}</AppLink>
  ) : (
    text
  );
}

/**
 * A code-host or Linear connection's webhook deliveries (Design board Settings): "All /
 * Failed N / Ignored" (N: the connection's failures not yet replayed, coral above zero),
 * then a table of when each came in, the event and repo in plain words and what it did,
 * linked to its run. Failed rows offer Replay; the other rows show it on hover or keyboard
 * focus, and phone cards only on failed ones. More rows load a page at a time. Live: a
 * delivery recorded or replayed (`webhook_event`) shows at once, and so does a replay.
 */
export function WebhookDeliveriesCard({ connection }: { connection: Connection }) {
  const [filter, setFilter] = useState<DeliveryFilter>("all");
  const query = useDeliveries(
    { kind: connection.provider === "linear" ? "linear" : "scm", id: connection.id },
    filter,
  );
  const replay = useReplayDelivery();
  const failed = connection.failedDeliveries;
  const rows: ListedDelivery[] = query.data?.pages.flatMap((page) => page.deliveries) ?? [];
  // oxlint-disable-next-line react/purity -- relative times are as of this render
  const now = new Date();

  const columns: DataTableColumn<ListedDelivery>[] = [
    {
      id: "received",
      header: "Received",
      card: "time",
      mono: true,
      cell: (row) => (
        <time dateTime={row.receivedAt}>{deliveryReceivedText(row.receivedAt, now)}</time>
      ),
    },
    {
      id: "event",
      header: "Event",
      card: "title",
      cell: (row) => deliveryEventLabel(row.provider, row.event),
    },
    {
      id: "repo",
      header: "Repo",
      cell: (row) =>
        row.repository ? (
          <RepoBadge host={row.repository.provider} name={row.repository.fullPath} />
        ) : null,
    },
    { id: "outcome", header: "Outcome", cell: (row) => <Outcome delivery={row} /> },
    {
      id: "actions",
      header: <span className="or-sr-only">Actions</span>,
      align: "end",
      cell: (row) =>
        row.replaying ? null : (
          <IconButton
            label="Replay"
            icon={IconRotate}
            size="sm"
            className={cx(
              "or-deliveries__replay",
              row.outcome !== "failed" && "or-deliveries__replay--reveal",
            )}
            disabled={replay.isPending && replay.variables?.id === row.id}
            onClick={() => replay.mutate(row)}
          />
        ),
    },
  ];

  let body: ReactNode;
  if (query.isError && !query.data) {
    body = (
      <EmptyState
        headingLevel={3}
        title="Couldn't load the deliveries"
        description={query.error.message}
        action={
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      />
    );
  } else if (!query.data) {
    body = null;
  } else if (rows.length === 0) {
    body = <EmptyState headingLevel={3} title={NO_DELIVERIES[filter]} />;
  } else {
    body = (
      <>
        <DataTable
          className="or-deliveries"
          caption="Webhook deliveries"
          rows={rows}
          getRowId={(row) => row.id}
          columns={columns}
        />
        {query.hasNextPage ? (
          <div className="or-deliveries__more">
            <Button
              variant="outline"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? "Loading…" : "Show more"}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <Card
      title="Webhook deliveries"
      titleId="connection-deliveries"
      actions={
        <SegmentedControl<DeliveryFilter>
          aria-label="Show deliveries"
          size="sm"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "failed", label: `Failed ${failed}`, tone: failed > 0 ? "fail" : undefined },
            { value: "ignored", label: "Ignored" },
          ]}
        />
      }
    >
      {body}
      <p className="or-deliveries__note">{DELIVERIES_RETENTION_NOTE}</p>
    </Card>
  );
}
