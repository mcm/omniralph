"use client";

import { IssueBadge, OrgBadge, RepoBadge, SizeBadge } from "@omniralph/ui";
import { BlockedBadge } from "@/components/work-items/blocked";
import { KindBadge } from "@/components/work-items/kind";
import type { WorkItemRow } from "@/lib/api/work-items";

/**
 * A Backlog row's badges, in order (Design rules 1, 2 and 13): the organization (only under
 * "All organizations"), the identifier, the kind (a task's Fix or Story), the repo, the size
 * (when known) and "Blocked" (when blocked). Plain badges: the row link covers the row.
 */
export function BacklogRowBadges({
  row,
  showOrganization,
}: {
  row: WorkItemRow;
  showOrganization: boolean;
}) {
  return (
    <>
      {showOrganization ? <OrgBadge name={row.organization.name} /> : null}
      <IssueBadge tracker={row.tracker} id={row.identifier} />
      <KindBadge kind={row.kind} />
      {row.repository ? (
        <RepoBadge host={row.repository.provider} name={row.repository.fullPath} />
      ) : null}
      {row.size ? <SizeBadge size={row.size} /> : null}
      {row.blocked ? <BlockedBadge /> : null}
    </>
  );
}
