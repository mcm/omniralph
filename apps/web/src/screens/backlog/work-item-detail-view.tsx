"use client";

import { Button, EmptyState, IssueBadge, OrgBadge, SizeBadge } from "@omniralph/ui";
import { useCurrentUser } from "@/components/current-user";
import { BlockedByLine } from "@/components/work-items/blocked";
import { PrdView } from "@/components/work-items/prd-view";
import { useWorkItemDetail } from "@/components/work-items/use-work-item-detail";
import { ApiError } from "@/lib/api/client";

export const WORK_ITEM_NOT_FOUND = "This work item doesn't exist or you can't see it.";
export const WORK_ITEM_LOAD_FAILED = "Couldn't load the work item.";

/**
 * The open work item beside the Backlog list: the bar with its organization (only under
 * "All organizations"), identifier and size, its title, the "Blocked by" line and its PRD
 * (`PrdView`, editable). A live query shared with `PrdView` (one fetch).
 */
export function WorkItemDetailView({ workItemId }: { workItemId: string }) {
  const user = useCurrentUser();
  const detail = useWorkItemDetail(workItemId);

  if (detail.isError && !detail.data) {
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return <EmptyState className="or-backlog-detail" title={WORK_ITEM_NOT_FOUND} />;
    }
    return (
      <EmptyState
        className="or-backlog-detail"
        title={WORK_ITEM_LOAD_FAILED}
        description={detail.error.message}
        action={
          <Button variant="outline" onClick={() => void detail.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  const item = detail.data;
  if (!item) return <div className="or-backlog-detail" aria-busy="true" />;

  return (
    <article className="or-backlog-detail" aria-labelledby={`${workItemId}-title`}>
      <div className="or-backlog-detail__bar">
        {user.scope === "all" ? <OrgBadge name={item.organization.name} /> : null}
        <IssueBadge tracker={item.tracker} id={item.identifier} />
        {item.size ? <SizeBadge size={item.size} /> : null}
      </div>
      <h2 id={`${workItemId}-title`} className="or-backlog-detail__title">
        {item.title}
      </h2>
      <BlockedByLine blockers={item.blockedBy} />
      <PrdView workItemId={workItemId} mode="editable" />
    </article>
  );
}
