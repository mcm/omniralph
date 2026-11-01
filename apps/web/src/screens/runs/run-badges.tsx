"use client";

import { ChangeBadge, IssueBadge, MetaBadge, OrgBadge, RepoBadge } from "@omniralph/ui";
import type { RunRow } from "@/lib/api/runs";
import { runRowLabel } from "./labels";

/**
 * A run row's badges, in order (Design rules 1, 8 and 13): the organization (only under
 * "All organizations"), a running epic's story ("Story 2 of 4"), the work item, the repo and
 * the PR/MR. Plain badges: the row link
 * covers the row.
 */
export function RunRowBadges({
  run,
  showOrganization,
}: {
  run: RunRow;
  showOrganization: boolean;
}) {
  const { story } = runRowLabel(run);
  return (
    <>
      {showOrganization ? <OrgBadge name={run.organization.name} /> : null}
      {story ? <MetaBadge text={story} /> : null}
      {run.workItem ? (
        <IssueBadge tracker={run.workItem.tracker} id={run.workItem.identifier} />
      ) : null}
      {run.repository ? (
        <RepoBadge host={run.repository.provider} name={run.repository.fullPath} />
      ) : null}
      {run.pullRequest ? (
        <ChangeBadge host={run.pullRequest.provider} number={run.pullRequest.number} />
      ) : null}
    </>
  );
}
