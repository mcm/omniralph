"use client";

import {
  BrandMark,
  Button,
  EmptyState,
  FilterMenu,
  IconButton,
  ListLoading,
  ListRow,
  RowList,
  rowListProps,
  SplitView,
  useSplitWide,
  type FilterOption,
} from "@omniralph/ui";
import { IconPlus } from "@tabler/icons-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { useCurrentUser, type SessionUser } from "@/components/current-user";
import { ShareLinkSheet } from "@/components/work-items/share-link-sheet";
import type { Backlog } from "@/lib/api/backlog";
import { useKeyShortcuts, useShortcut } from "@/lib/shortcuts";
import type { WorkItemDetail, WorkItemRow } from "@/lib/api/work-items";
import { joinNames } from "@/lib/work-items/join-names";
import { BacklogRowBadges } from "./backlog-row-badges";
import { NewWorkItemSheet } from "./new-work-item-sheet";
import { useBacklog } from "./queries";
import {
  backlogHref,
  backlogItemHref,
  hasBacklogFilters,
  NO_BACKLOG_FILTERS,
  parseBacklogFilters,
  type BacklogFilters,
} from "./url";
import { WorkItemDetailView } from "./work-item-detail-view";
import "./backlog.css";

export const NEW_WORK_ITEM = "New work item";
export const NOTHING_IN_BACKLOG = "Nothing in the backlog";
export const NO_MATCHING_WORK_ITEMS = "No work items match these filters";
export const NO_REPO_PICKS_UP = "No repo picks up work items yet";
export const CONNECT_LINEAR = "Connect Linear to see its work items";

/** Where an admin connects Linear (Settings → Integrations). */
const INTEGRATIONS_PATH = "/settings/integrations";

/** The groups, in list order, with their headers. */
const GROUPS = [
  { key: "readyToStart", label: "Ready to start" },
  { key: "needsRefining", label: "Needs refining" },
] as const;

export { joinNames };
export { BacklogRowBadges };

/** Whether the user administers an organization in scope (admin-only empty-state actions). */
function administers(user: SessionUser): boolean {
  if (user.scope === "all") return user.organizations.some((org) => org.role === "admin");
  return user.role === "admin";
}

/** A Source option's label: the same words as the detail's "via" badge. */
function sourceLabel(source: Backlog["filters"]["sources"][number]): string {
  return `${source.name} ${source.kind === "project" ? "project" : "team"}`;
}

export interface BacklogViewProps {
  /** The open work item (`/backlog/{id}`), whose row is selected; none on `/backlog`. */
  workItemId?: string | null;
  /**
   * The detail beside the list; `WorkItemDetailView` by default. `onLeave` selects the next
   * listed item (an action took this one out of the Backlog).
   */
  renderDetail?: (workItemId: string, context: BacklogDetailContext) => ReactNode;
  /**
   * The New work item flow, shown while open (`close` ends it; `onCreated` selects the new
   * item); `NewWorkItemSheet` by default.
   */
  renderNewWorkItem?: (close: () => void, context: NewWorkItemContext) => ReactNode;
  /** The detail's Share review link flow, shown while open (`close` ends it); `ShareLinkSheet` by default. */
  renderShareLink?: (item: WorkItemDetail, close: () => void) => ReactNode;
}

/** What the Backlog gives its detail pane. */
export interface BacklogDetailContext {
  /** Selects the item after this one in the list (else the one before, else none). */
  onLeave: () => void;
  renderShareLink?: BacklogViewProps["renderShareLink"];
}

/** What the Backlog gives its New work item flow. */
export interface NewWorkItemContext {
  /** Opens the created item (its row is already in the list). */
  onCreated: (item: WorkItemRow) => void;
  /** The Repo filter's repo, if any: the flow's first choice. */
  repositoryId: string | null;
}

const defaultNewWorkItem = (close: () => void, context: NewWorkItemContext) => (
  <NewWorkItemSheet
    onClose={close}
    onCreated={context.onCreated}
    defaultRepositoryId={context.repositoryId}
  />
);

const defaultShareLink = (item: WorkItemDetail, close: () => void) => (
  <ShareLinkSheet item={item} onClose={close} />
);

const defaultDetail = (workItemId: string, context: BacklogDetailContext) => (
  <WorkItemDetailView
    key={workItemId}
    workItemId={workItemId}
    onLeave={context.onLeave}
    renderShareLink={context.renderShareLink}
  />
);

/**
 * The Backlog screen (Design board Backlog): the list pane of a `SplitView` with "Backlog",
 * the + (New work item), the Source and Repo filters (`?source=&repo=`, kept when an item
 * opens) and the Ready to start and Needs refining groups, beside the open item's detail (on
 * `/backlog`, the first listed item's, when both panes fit). The list is a live query; the
 * pane has no live indicator of its own (the shell's `LiveNotice` covers stopped updates).
 * The + and the New work item shortcut (`n`) open the New work item sheet over the list.
 */
export function BacklogView({
  workItemId = null,
  renderDetail = defaultDetail,
  renderNewWorkItem = defaultNewWorkItem,
  renderShareLink = defaultShareLink,
}: BacklogViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filters = parseBacklogFilters(searchParams);
  const user = useCurrentUser();
  const showOrganization = user.scope === "all";
  const admin = administers(user);
  const newWorkItemKeys = useKeyShortcuts("newWorkItem");
  const [creating, setCreating] = useState(false);

  const backlog = useBacklog(filters);
  const data = backlog.data;
  const groups = data
    ? GROUPS.map((group) => ({ ...group, rows: data.groups[group.key] })).filter(
        (group) => group.rows.length > 0,
      )
    : [];
  const firstRow = groups[0]?.rows[0];
  const rows = groups.flatMap((group) => group.rows);

  const splitRef = useRef<HTMLDivElement>(null);
  const wide = useSplitWide(splitRef);
  // Without an item in the URL, a wide container shows the first listed item beside the list.
  const shownId = workItemId ?? (wide ? (firstRow?.id ?? null) : null);

  const hrefWith = (next: BacklogFilters) =>
    workItemId ? backlogItemHref(workItemId, next) : backlogHref(next);
  const setFilters = (next: BacklogFilters) => router.push(hrefWith(next), { scroll: false });

  const sourceOptions: FilterOption[] = (data?.filters.sources ?? []).map((source) => ({
    value: source.value,
    label: sourceLabel(source),
    icon: <BrandMark brand={source.tracker} />,
    group: "Linear",
  }));
  const repoOptions: FilterOption[] = (data?.filters.repos ?? []).map((repo) => ({
    value: repo.value,
    label: repo.fullPath,
    icon: <BrandMark brand={repo.provider} />,
  }));

  const newWorkItem = () => setCreating(true);
  useShortcut("newWorkItem", newWorkItem);

  // An action took the shown item out of the Backlog: select the next one, as listed now.
  const leave = (leavingId: string) => {
    const index = rows.findIndex((row) => row.id === leavingId);
    const next = index === -1 ? undefined : (rows[index + 1] ?? rows[index - 1]);
    router.replace(next ? backlogItemHref(next.id, filters) : backlogHref(filters), {
      scroll: false,
    });
  };

  const empty = (): ReactNode => {
    if (hasBacklogFilters(filters)) {
      return (
        <EmptyState
          headingLevel={2}
          title={NO_MATCHING_WORK_ITEMS}
          action={
            <Button variant="outline" onClick={() => setFilters(NO_BACKLOG_FILTERS)}>
              Clear filters
            </Button>
          }
        />
      );
    }
    if (data?.setup === "no_tracker") {
      return (
        <EmptyState
          headingLevel={2}
          title={CONNECT_LINEAR}
          action={
            admin ? (
              <Button variant="outline" href={INTEGRATIONS_PATH}>
                Open Settings
              </Button>
            ) : undefined
          }
        />
      );
    }
    if (data?.setup === "no_work_item_match") {
      return (
        <EmptyState
          headingLevel={2}
          title={NO_REPO_PICKS_UP}
          action={
            admin ? (
              <Button variant="outline" href="/repos">
                Open Repos
              </Button>
            ) : undefined
          }
        />
      );
    }
    return (
      <EmptyState
        headingLevel={2}
        title={NOTHING_IN_BACKLOG}
        action={
          <Button variant="outline" onClick={newWorkItem}>
            {NEW_WORK_ITEM}
          </Button>
        }
      />
    );
  };

  const list = (
    <div className="or-backlog__pane">
      <div className="or-backlog__header">
        <h1 className="or-backlog__title">Backlog</h1>
        <IconButton
          icon={IconPlus}
          label={NEW_WORK_ITEM}
          onClick={newWorkItem}
          aria-keyshortcuts={newWorkItemKeys}
        />
      </div>
      <div className="or-backlog__filters" role="group" aria-label="Filters">
        <FilterMenu
          label="Source"
          options={sourceOptions}
          selected={filters.source ? [filters.source] : []}
          onChange={([source]) => setFilters({ ...filters, source: source ?? null })}
        />
        <FilterMenu
          label="Repo"
          options={repoOptions}
          selected={filters.repo ? [filters.repo] : []}
          onChange={([repo]) => setFilters({ ...filters, repo: repo ?? null })}
        />
      </div>
      <div className="or-backlog__list">
        {data && data.unavailable.length > 0 ? (
          <div className="or-backlog__notice" role="alert">
            <p>
              Couldn&apos;t load work items from Linear for{" "}
              {joinNames(data.unavailable.map((entry) => entry.organization.name))}.
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={backlog.isFetching}
              onClick={() => void backlog.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {backlog.isError && !data ? (
          <EmptyState
            headingLevel={2}
            title="Couldn't load the backlog"
            description={backlog.error.message}
            action={
              <Button variant="outline" onClick={() => void backlog.refetch()}>
                Try again
              </Button>
            }
          />
        ) : !data ? (
          <ListLoading label="Loading the Backlog" />
        ) : groups.length === 0 ? (
          empty()
        ) : (
          // One list for Next and Previous item, across both groups.
          <div
            {...rowListProps}
            className={backlog.isPlaceholderData ? "or-backlog--stale" : undefined}
          >
            {groups.map((group) => (
              <section
                key={group.key}
                className="or-backlog__group"
                aria-labelledby={`backlog-${group.key}`}
              >
                <h2 id={`backlog-${group.key}`} className="or-backlog__group-title">
                  {group.label} · {group.rows.length}
                </h2>
                <RowList aria-label={group.label}>
                  {group.rows.map((row) => (
                    <ListRow
                      key={row.id}
                      href={backlogItemHref(row.id, filters)}
                      mark={<BrandMark brand={row.tracker} />}
                      title={row.title}
                      meta={<BacklogRowBadges row={row} showOrganization={showOrganization} />}
                      selected={row.id === shownId}
                    />
                  ))}
                </RowList>
              </section>
            ))}
            {data.truncatedOrganizations.length > 0 ? (
              <p className="or-backlog__truncated">
                Showing the first 500 work items from{" "}
                {joinNames(data.truncatedOrganizations.map((org) => org.name))}.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <SplitView
        ref={splitRef}
        className="or-backlog"
        list={list}
        detail={
          shownId ? renderDetail(shownId, { onLeave: () => leave(shownId), renderShareLink }) : null
        }
        view={workItemId ? "detail" : "list"}
        backLink={{ label: "Backlog", href: backlogHref(filters) }}
        listLabel="Backlog"
        title="Backlog"
        detailLabel="Work item"
      />
      {creating
        ? renderNewWorkItem(() => setCreating(false), {
            onCreated: (item) => router.push(backlogItemHref(item.id, filters), { scroll: false }),
            repositoryId: filters.repo,
          })
        : null}
    </>
  );
}
