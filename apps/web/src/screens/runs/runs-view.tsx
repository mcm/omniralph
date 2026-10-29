"use client";

import {
  BrandMark,
  Button,
  EmptyState,
  FilterMenu,
  ListLoading,
  ListRow,
  RowList,
  SplitView,
  useSplitWide,
  type FilterOption,
} from "@omniralph/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, type ReactNode } from "react";
import { useCurrentUser } from "@/components/current-user";
import { viewPrdMenuItems } from "@/components/work-items/view-prd-sheet";
import { RUN_STATUS_LABELS } from "@/components/runs/run-status";
import { RUN_KINDS, RUN_STATUSES, type RunRow } from "@/lib/api/runs";
import { useClock } from "../clock";
import { compactAge, RUN_KIND_LABELS } from "../inbox/labels";
import {
  hasRunFilters,
  NO_RUN_FILTERS,
  parseRunFilters,
  runFiltersHref,
  runInListHref,
  type RunFilters,
} from "./filters";
import { runRowLabel } from "./labels";
import { useRunFilterOptions, useRunList } from "./queries";
import { RunDetailView } from "./run-detail-view";
import { RunRowBadges } from "./run-badges";
import "./runs.css";

type RunKind = RunRow["kind"];
type RunStatus = RunRow["status"];

const KIND_OPTIONS: FilterOption<RunKind>[] = RUN_KINDS.map((value) => ({
  value,
  label: RUN_KIND_LABELS[value],
}));

const STATUS_OPTIONS: FilterOption<RunStatus>[] = RUN_STATUSES.map((value) => ({
  value,
  label: RUN_STATUS_LABELS[value],
}));

export interface RunsViewProps {
  /** The open run (`/runs/{id}`), whose row is selected; none on `/runs`. */
  runId?: string | null;
  /** The detail of the run beside the rail; `RunDetailView` with View PRD by default. */
  renderDetail?: (runId: string) => ReactNode;
}

const defaultDetail = (runId: string) => (
  <RunDetailView key={runId} runId={runId} menuItems={viewPrdMenuItems} />
);

/**
 * The Runs screen (Design board Runs): a rail with the title, the Kind, Status and Repo
 * filters and every run of every kind in the user's scope, newest first, beside the open
 * run's detail (on `/runs`, the first listed run's, when both panes fit). The filters live in the URL (`?kind=&status=&repository=`, each
 * repeatable) and stay there when a run opens. The list is a live query; the rail has no
 * stats line and no notice of its own (the shell's `LiveNotice` covers stopped updates).
 */
export function RunsView({ runId = null, renderDetail = defaultDetail }: RunsViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filters = parseRunFilters(searchParams);
  const user = useCurrentUser();
  const showOrganization = user.scope === "all";
  const now = useClock();

  const list = useRunList(filters);
  const options = useRunFilterOptions();
  const runs = list.data?.pages.flatMap((page) => page.runs);
  const splitRef = useRef<HTMLDivElement>(null);
  const wide = useSplitWide(splitRef);
  // Without a run in the URL, a wide container shows the first listed run beside the rail.
  const shownRunId = runId ?? (wide ? (runs?.[0]?.id ?? null) : null);

  const hrefWith = (next: RunFilters) =>
    runId ? runInListHref(runId, next) : runFiltersHref(next);
  const setFilter = <K extends keyof RunFilters>(key: K, value: RunFilters[K]) =>
    router.push(hrefWith({ ...filters, [key]: value }), { scroll: false });

  const repoOptions: FilterOption[] = (options.data?.repositories ?? []).map((repository) => ({
    value: repository.id,
    label: repository.fullPath,
    icon: <BrandMark brand={repository.provider} />,
    group: showOrganization ? repository.organization.name : undefined,
  }));

  const filtered = hasRunFilters(filters);

  const rail = (
    <div className="or-runs__rail">
      <h1 className="or-runs__title">Runs</h1>
      <div className="or-runs__filters" role="group" aria-label="Filters">
        <FilterMenu
          label="Kind"
          options={KIND_OPTIONS}
          selected={filters.kind}
          onChange={(kind) => setFilter("kind", kind)}
          multiple
        />
        <FilterMenu
          label="Status"
          options={STATUS_OPTIONS}
          selected={filters.status}
          onChange={(status) => setFilter("status", status)}
          multiple
        />
        <FilterMenu
          label="Repo"
          options={repoOptions}
          selected={filters.repository}
          onChange={(repository) => setFilter("repository", repository)}
          multiple
        />
      </div>
      <div className="or-runs__list">
        {list.isError && !runs ? (
          <EmptyState
            headingLevel={2}
            title="Couldn't load runs"
            description={list.error.message}
            action={
              <Button variant="outline" onClick={() => void list.refetch()}>
                Try again
              </Button>
            }
          />
        ) : runs === undefined ? (
          <ListLoading label="Loading runs" />
        ) : runs.length === 0 ? (
          filtered ? (
            <EmptyState
              headingLevel={2}
              title="No runs match these filters"
              action={
                <Button
                  variant="outline"
                  onClick={() => router.push(hrefWith(NO_RUN_FILTERS), { scroll: false })}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState headingLevel={2} title="No runs yet" />
          )
        ) : (
          <>
            <RowList
              aria-label="Runs"
              className={list.isPlaceholderData ? "or-runs--stale" : undefined}
            >
              {runs.map((run) => {
                const { label, tone } = runRowLabel(run);
                return (
                  <ListRow
                    key={run.id}
                    href={runInListHref(run.id, filters)}
                    title={run.title}
                    kindLabel={label}
                    tone={tone}
                    time={<time dateTime={run.createdAt}>{compactAge(run.createdAt, now)}</time>}
                    meta={<RunRowBadges run={run} showOrganization={showOrganization} />}
                    selected={run.id === shownRunId}
                  />
                );
              })}
            </RowList>
            {list.hasNextPage ? (
              <div className="or-runs__more">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                >
                  Show more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );

  return (
    <SplitView
      ref={splitRef}
      className="or-runs"
      list={rail}
      detail={shownRunId ? renderDetail(shownRunId) : null}
      view={runId ? "detail" : "list"}
      backLink={{ label: "Runs", href: runFiltersHref(filters) }}
      listLabel="Runs"
      title="Runs"
      detailLabel="Run"
    />
  );
}
