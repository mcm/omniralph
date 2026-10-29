"use client";

import {
  ActivityList,
  BrandMark,
  Button,
  ConfirmDialog,
  EmptyState,
  IssueBadge,
  ListLoading,
  MetaBadge,
  OrgBadge,
  RepoBadge,
  SizeBadge,
  StatusText,
  TabPanel,
  Tabs,
  Toolbar,
  type MenuItem,
  type ToolbarAction,
} from "@omniralph/ui";
import {
  IconArrowRight,
  IconArrowsExchange,
  IconExternalLink,
  IconPencil,
  IconPlayerPlay,
  IconShare,
  IconSparkles,
  IconTrash,
  IconArrowBackUp,
  IconRoute,
  IconUserCheck,
} from "@tabler/icons-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState, type ReactNode } from "react";
import { useCurrentUser } from "@/components/current-user";
import { BlockedByLine } from "@/components/work-items/blocked";
import { CHANGE_REPO, ChangeRepoSheet } from "@/components/work-items/change-repo-sheet";
import { PrdView } from "@/components/work-items/prd-view";
import {
  START_BLOCKED_DESCRIPTION,
  START_EPIC,
  TRIAGE_NOW,
  startBlockedTitle,
  startsWhenTooltip,
} from "@/components/work-items/start-triage-buttons";
import {
  triagingTooltip,
  useCancelWorkItem,
  useMoveWorkItem,
  useStartWorkItem,
  useTriageWorkItem,
} from "@/components/work-items/use-work-item-actions";
import { useWorkItemDetail } from "@/components/work-items/use-work-item-detail";
import { ApiError } from "@/lib/api/client";
import type { WorkItemDetail, WorkItemRoute } from "@/lib/api/work-items";
import { backlogItemHref, parseBacklogFilters, parseWorkItemTab, type WorkItemTab } from "./url";
import "./work-item-detail.css";
import { useAskContextRepository } from "@/components/ask/ask-context";

export const WORK_ITEM_NOT_FOUND = "This work item doesn't exist or you can't see it.";
export const WORK_ITEM_LOAD_FAILED = "Couldn't load the work item.";
export const EDIT_PRD = "Edit PRD";
export const SHARE_REVIEW_LINK = "Share review link";
export const MOVE_TO_NEEDS_REFINING = "Move to Needs refining";
export const REMOVE_FROM_BACKLOG = "Remove from backlog…";
export const CHOOSE_A_REPO = "Choose a repo";
export const NO_STORIES = "No stories yet";
export const NO_ACTIVITY = "No activity yet";

/** "Open SOC-412 in Linear": the ⋯ menu's link to the tracker. */
export function openInTracker(identifier: string): string {
  return `Open ${identifier} in Linear`;
}

/** "Remove SOC-412 from the backlog?": Remove from backlog…'s confirm. */
export function removeTitle(identifier: string): string {
  return `Remove ${identifier} from the backlog?`;
}
export const REMOVE_DESCRIPTION = "It's canceled in Linear.";

export interface WorkItemDetailViewProps {
  workItemId: string;
  /**
   * Called just before an action takes the item out of the Backlog (Start epic, Remove
   * from backlog…), so the screen selects the next item.
   */
  onLeave?: () => void;
  /** The Share review link flow, shown while open (`close` ends it). */
  renderShareLink?: (item: WorkItemDetail, close: () => void) => ReactNode;
}

/**
 * The routes line's source: a routing rule carries the route icon and the user's choice a
 * person, while tracker facts (project, team, label, parent, follow-up) carry the tracker mark.
 */
function ViaBadge({ via }: { via: NonNullable<WorkItemRoute["via"]> }) {
  if (via.kind === "rule") return <MetaBadge icon={IconRoute} text={via.label} />;
  if (via.kind === "choice") return <MetaBadge icon={IconUserCheck} text={via.label} />;
  return (
    <MetaBadge mark={<BrandMark brand="linear" className="or-ref__icon" />} text={via.label} />
  );
}

/**
 * "Routes to <repo> via <source>" (the source a `MetaBadge`, see `ViaBadge`), or, while
 * routing asks, "Routes to no repo yet" with "Choose a repo" (opens Change repo…).
 */
export function WorkItemRoutesLine({
  route,
  onChooseRepo,
}: {
  route: WorkItemRoute;
  onChooseRepo?: () => void;
}) {
  return (
    <p className="or-backlog-detail__routes">
      <IconArrowRight
        className="or-backlog-detail__routes-icon"
        size={14}
        stroke={1.75}
        aria-hidden="true"
      />
      {route.repository ? (
        <>
          <span>Routes to</span>
          <RepoBadge host={route.repository.provider} name={route.repository.fullPath} strong />
          {route.via ? (
            <>
              <span>via</span>
              <ViaBadge via={route.via} />
            </>
          ) : null}
        </>
      ) : (
        <>
          <span>Routes to no repo yet</span>
          {onChooseRepo ? (
            <button type="button" className="or-backlog-detail__choose" onClick={onChooseRepo}>
              {CHOOSE_A_REPO}
            </button>
          ) : null}
        </>
      )}
    </p>
  );
}

/** Stories: the sub-issues, or the stories its PRD lists (no identifier or state). */
function WorkItemStories({ item }: { item: WorkItemDetail }) {
  if (item.stories.length === 0) return <EmptyState headingLevel={3} title={NO_STORIES} />;
  return (
    <ol className="or-backlog-detail__stories" aria-label="Stories">
      {item.stories.map((story, index) => (
        <li key={story.identifier ?? `story-${index}`} className="or-backlog-detail__story">
          {story.identifier ? (
            <IssueBadge
              tracker={item.tracker}
              id={story.identifier}
              href={story.url ?? undefined}
            />
          ) : null}
          <span className="or-backlog-detail__story-title">{story.title}</span>
          {story.state ? <StatusText tone="neutral">{story.state.name}</StatusText> : null}
          {story.manual ? <MetaBadge text="manual" /> : null}
        </li>
      ))}
    </ol>
  );
}

function WorkItemDetailContent({
  item,
  onLeave,
  renderShareLink,
}: {
  item: WorkItemDetail;
  onLeave?: () => void;
  renderShareLink?: WorkItemDetailViewProps["renderShareLink"];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filters = parseBacklogFilters(searchParams);
  const tab = parseWorkItemTab(searchParams);
  const user = useCurrentUser();

  const start = useStartWorkItem();
  const triage = useTriageWorkItem();
  const move = useMoveWorkItem();
  const cancel = useCancelWorkItem();

  const [editRequested, setEditRequested] = useState(false);
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [changingRepo, setChangingRepo] = useState(false);
  const [sharing, setSharing] = useState(false);
  const onEditStarted = useCallback(() => setEditRequested(false), []);

  const selectTab = (next: WorkItemTab) =>
    router.replace(backlogItemHref(item.id, filters, next), { scroll: false });

  const runStart = () => {
    onLeave?.();
    start.mutate(item);
  };
  const runRemove = () => {
    onLeave?.();
    cancel.mutate(item);
  };

  const triaging = item.triageRunning || triage.isPending;
  const ready = item.group === "ready";
  const leading: ToolbarAction = ready
    ? {
        label: START_EPIC,
        icon: IconPlayerPlay,
        solid: true,
        disabled: !item.actions.start || start.isPending,
        tooltip: item.blocked ? startsWhenTooltip(item.blockers) : undefined,
        onSelect: () => (item.blocked ? setConfirmStart(true) : runStart()),
      }
    : {
        label: TRIAGE_NOW,
        icon: IconSparkles,
        solid: true,
        disabled: triaging || !item.actions.triage,
        disabledReason: triaging ? triagingTooltip(item.identifier) : undefined,
        onSelect: () => triage.mutate(item),
      };
  const actions = [
    leading,
    {
      label: EDIT_PRD,
      icon: IconPencil,
      disabled: !item.actions.editPrd,
      onSelect: () => {
        if (tab !== "prd") selectTab("prd");
        setEditRequested(true);
      },
    },
    { label: SHARE_REVIEW_LINK, icon: IconShare, onSelect: () => setSharing(true) },
  ] as const satisfies readonly ToolbarAction[];

  const menu: MenuItem[] = [
    { label: openInTracker(item.identifier), icon: IconExternalLink, href: item.url },
    {
      label: CHANGE_REPO,
      icon: IconArrowsExchange,
      disabled: !item.actions.changeRepo,
      onSelect: () => setChangingRepo(true),
    },
    ...(ready
      ? [
          {
            label: MOVE_TO_NEEDS_REFINING,
            icon: IconArrowBackUp,
            disabled: !item.actions.move,
            onSelect: () => move.mutate(item),
          },
        ]
      : []),
    {
      label: REMOVE_FROM_BACKLOG,
      icon: IconTrash,
      destructive: true,
      disabled: !item.actions.cancel,
      onSelect: () => setConfirmRemove(true),
    },
  ];

  const badges = (
    <div className="or-backlog-detail__badges">
      {user.scope === "all" ? <OrgBadge name={item.organization.name} /> : null}
      <IssueBadge tracker={item.tracker} id={item.identifier} />
      {item.size ? <SizeBadge size={item.size} /> : null}
    </div>
  );

  return (
    <article className="or-backlog-detail" aria-labelledby={`${item.id}-title`}>
      <header className="or-backlog-detail__bar">
        {badges}
        <Toolbar label="Work item actions" actions={actions} menu={menu} />
      </header>
      <h2 id={`${item.id}-title`} className="or-backlog-detail__title">
        {item.title}
      </h2>
      <BlockedByLine blockers={item.blockedBy} />
      <WorkItemRoutesLine
        route={item.route}
        onChooseRepo={item.actions.changeRepo ? () => setChangingRepo(true) : undefined}
      />
      <Tabs<WorkItemTab>
        aria-label="Work item"
        className="or-backlog-detail__tabs"
        value={tab}
        onValueChange={selectTab}
        tabs={[
          { value: "prd", label: "PRD" },
          { value: "stories", label: "Stories", count: item.stories.length },
          { value: "activity", label: "Activity" },
        ]}
      >
        <TabPanel value="prd" keepMounted>
          <PrdView
            workItemId={item.id}
            mode="editable"
            showEditButton={false}
            editRequested={editRequested}
            onEditStarted={onEditStarted}
          />
        </TabPanel>
        <TabPanel value="stories">
          <WorkItemStories item={item} />
        </TabPanel>
        <TabPanel value="activity">
          {item.activity.length === 0 ? (
            <EmptyState headingLevel={3} title={NO_ACTIVITY} />
          ) : (
            <ActivityList entries={item.activity} />
          )}
        </TabPanel>
      </Tabs>
      {item.blocked ? (
        <ConfirmDialog
          open={confirmStart}
          onOpenChange={setConfirmStart}
          title={startBlockedTitle(item.identifier)}
          description={START_BLOCKED_DESCRIPTION}
          confirmLabel={START_EPIC}
          onConfirm={runStart}
        />
      ) : null}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={removeTitle(item.identifier)}
        description={REMOVE_DESCRIPTION}
        confirmLabel="Remove"
        destructive
        onConfirm={runRemove}
      />
      {changingRepo ? <ChangeRepoSheet item={item} open onOpenChange={setChangingRepo} /> : null}
      {sharing && renderShareLink ? renderShareLink(item, () => setSharing(false)) : null}
    </article>
  );
}

/**
 * The open work item beside the Backlog list (Design board Backlog): the bar with its
 * organization (only under "All organizations"), identifier and size, then the toolbar
 * (Start epic or Triage now, Edit PRD, Share review link, and the ⋯ menu); its title, the
 * "Blocked by" line and the routes line; and the tabs PRD (`PrdView`, editable), Stories and
 * Activity (`?tab=`). Every action changes the view before the server answers. A live query
 * shared with `PrdView` (one fetch): a `work_item` event naming it, or a `run` event, refetches
 * it. On phone the badges move under the title (CSS).
 */
export function WorkItemDetailView({
  workItemId,
  onLeave,
  renderShareLink,
}: WorkItemDetailViewProps) {
  const detail = useWorkItemDetail(workItemId);
  useAskContextRepository(detail.data?.repository?.id);

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
  if (!item) return <ListLoading className="or-backlog-detail" label="Loading the work item" />;

  return <WorkItemDetailContent item={item} onLeave={onLeave} renderShareLink={renderShareLink} />;
}
