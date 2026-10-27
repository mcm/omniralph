"use client";

import { BrandMark, ListRow, RowList, TextLink } from "@omniralph/ui";
import { useId, type ReactNode } from "react";
import { useCurrentUser } from "@/components/current-user";
import {
  StartEpicIconButton,
  TriageNowIconButton,
} from "@/components/work-items/start-triage-buttons";
import type { WorkItemRow } from "@/lib/api/work-items";
import { BacklogRowBadges } from "./backlog-view";
import { useBacklogUpNext } from "./queries";
import { backlogItemHref, NO_BACKLOG_FILTERS } from "./url";
import "./up-next.css";

export const UP_NEXT = "Up next";

/** One group of Up next: its header and rows, each with its action beside the row link. */
function UpNextGroup({
  label,
  rows,
  showOrganization,
  action,
}: {
  label: string;
  rows: readonly WorkItemRow[];
  showOrganization: boolean;
  action: (row: WorkItemRow) => ReactNode;
}) {
  const id = useId();
  if (rows.length === 0) return null;
  return (
    <section className="or-upnext__group" aria-labelledby={id}>
      <h4 id={id} className="or-upnext__group-title">
        {label}
      </h4>
      <RowList aria-label={label}>
        {rows.map((row) => (
          <ListRow
            key={row.id}
            href={backlogItemHref(row.id, NO_BACKLOG_FILTERS)}
            mark={<BrandMark brand={row.tracker} />}
            title={row.title}
            meta={<BacklogRowBadges row={row} showOrganization={showOrganization} />}
            actions={action(row)}
          />
        ))}
      </RowList>
    </section>
  );
}

/**
 * Up next in the empty Inbox (Design board InboxEmpty), passed as `InboxView`'s `upNext`:
 * "Up next" with a link to the Backlog, then up to three Ready to start items, each with
 * Start epic, and up to two Needs refining items, each with Triage now. Rows carry the
 * Backlog's badges (organization only under "All organizations", identifier, repo, size,
 * Blocked) and link to the item's Backlog detail. A live query (`GET
 * /api/ui/backlog/up-next`); nothing renders until it loads or when both groups are empty.
 */
export function InboxUpNext() {
  const user = useCurrentUser();
  const upNext = useBacklogUpNext();
  const headingId = useId();
  const data = upNext.data;
  if (!data || (data.readyToStart.length === 0 && data.needsRefining.length === 0)) return null;
  const showOrganization = user.scope === "all";
  return (
    <section className="or-upnext" aria-labelledby={headingId}>
      <div className="or-upnext__head">
        <h3 id={headingId} className="or-upnext__title">
          {UP_NEXT}
        </h3>
        <TextLink href="/backlog">Backlog</TextLink>
      </div>
      <UpNextGroup
        label="Ready to start"
        rows={data.readyToStart}
        showOrganization={showOrganization}
        action={(row) => <StartEpicIconButton item={row} />}
      />
      <UpNextGroup
        label="Needs refining"
        rows={data.needsRefining}
        showOrganization={showOrganization}
        action={(row) => <TriageNowIconButton item={row} />}
      />
    </section>
  );
}
