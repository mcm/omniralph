"use client";

import { IssueBadge, StatusText } from "@omniralph/ui";
import type { WorkItemBlocker, WorkItemDetail } from "@/lib/api/work-items";
import "./blocked.css";

/**
 * A blocked work item's status badge (open work items block it): "Blocked" in the neutral
 * status tone, named "Blocked". The one blocked badge of the Backlog list, the work item
 * detail and Up next; nothing else draws its own.
 */
export function BlockedBadge() {
  return (
    <span className="or-wi-blocked" role="img" aria-label="Blocked">
      <StatusText tone="neutral">Blocked</StatusText>
    </span>
  );
}

/**
 * A manual task's status badge (one of the organization's manual labels: a person's job, not
 * Om's): "Manual" in the neutral status tone, named "Manual", drawn like `BlockedBadge`.
 */
export function ManualBadge() {
  return (
    <span className="or-wi-blocked" role="img" aria-label="Manual">
      <StatusText tone="neutral">Manual</StatusText>
    </span>
  );
}

/** Where a blocker leads: its Backlog detail when the Backlog lists it, else its tracker page. */
export function blockerHref(blocker: WorkItemBlocker): string | undefined {
  if (blocker.backlogId) return `/backlog/${encodeURIComponent(blocker.backlogId)}`;
  return blocker.url ?? undefined;
}

/**
 * "Blocked by" and one `IssueBadge` per open blocker, each linking to `/backlog/{id}` when
 * the Backlog lists it, else to the tracker (a plain badge when neither is known). Blockers are
 * in the blocked item's tracker (`tracker`). Nothing renders without blockers.
 */
export function BlockedByLine({
  tracker,
  blockers,
}: {
  tracker: WorkItemDetail["tracker"];
  blockers: readonly WorkItemBlocker[];
}) {
  if (blockers.length === 0) return null;
  return (
    <p className="or-wi-blocked-by">
      <span className="or-wi-blocked-by__label">Blocked by</span>
      {blockers.map((blocker) => (
        <IssueBadge
          key={blocker.identifier}
          tracker={tracker}
          id={blocker.identifier}
          href={blockerHref(blocker)}
        />
      ))}
    </p>
  );
}
