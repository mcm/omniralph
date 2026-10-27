"use client";

import {
  BarChart,
  Button,
  Card,
  DataTable,
  DetailsSection,
  EmptyState,
  InfoPopover,
  OrgBadge,
  RepoBadge,
  SegmentedControl,
  Select,
  SummaryCells,
  toast,
  type BarChartDatum,
  type DataTableColumn,
  type SegmentedOption,
  type SummaryCell,
} from "@omniralph/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { formatTokens } from "@/components/runs/details";
import {
  ANALYTICS_RANGES,
  analyticsHref,
  chartSummary,
  dayLabel,
  formatRate,
  formatUsd,
  hasCost,
  parseAnalyticsParams,
  unpricedLabel,
  weekLabel,
  type AnalyticsParams,
} from "@/lib/analytics/display";
import type {
  RunAnalyticsFiguresResponse,
  RunAnalyticsOrganizationRow,
  RunAnalyticsRepositoryOption,
  RunAnalyticsRepositoryRow,
  RunAnalyticsResponse,
} from "@/lib/api/analytics";
import { RUN_KINDS } from "@/lib/api/runs";
import { RUN_KIND_LABELS } from "@/screens/inbox/labels";
import type { ScopeParam } from "@/screens/scope";
import { useRunAnalytics } from "./analytics-queries";
import "./analytics.css";

export const ANALYTICS_PATH = "/analytics";

/** What every Cost value says it is (Epic 12 fills `costUsd`). */
export const COST_NOTE =
  "What these tokens would cost at Anthropic's API list prices, not what was billed.";

type RunKind = (typeof RUN_KINDS)[number];
type Figures = RunAnalyticsFiguresResponse;
type TokenFigures = Figures["tokens"][RunKind];
type Bucket = RunAnalyticsResponse["buckets"][number];

const WINDOW_OPTIONS: SegmentedOption<`${(typeof ANALYTICS_RANGES)[number]}`>[] =
  ANALYTICS_RANGES.map((days) => ({ value: `${days}`, label: `${days} days` }));

const count = (value: number) => value.toLocaleString("en-US");

/** Tokens in and out across every run kind. */
export function tokenTotals(figures: Pick<Figures, "tokens">): { in: number; out: number } {
  return RUN_KINDS.reduce(
    (sum, kind) => ({
      in: sum.in + figures.tokens[kind].tokensIn,
      out: sum.out + figures.tokens[kind].tokensOut,
    }),
    { in: 0, out: 0 },
  );
}

/** Whether nothing ran in the window: no story, review run, finished attempt or token. */
export function isEmptyWindow(totals: Figures): boolean {
  const tokens = tokenTotals(totals);
  return (
    totals.stories === 0 &&
    totals.reviewRuns === 0 &&
    totals.attempts.finished === 0 &&
    tokens.in === 0 &&
    tokens.out === 0
  );
}

/** "212 of 220 finished attempts completed" (finished: completed, failed or expired). */
function rateTitle(attempts: Figures["attempts"]): string {
  const rated = attempts.completed + attempts.failed + attempts.expired;
  return `${count(attempts.completed)} of ${count(rated)} finished attempts completed`;
}

/** A Cost value's tooltip: what it is, and the attempts it leaves out. */
export function costNote(unpricedAttempts: number | undefined): string {
  return unpricedAttempts ? `${COST_NOTE}\n${unpricedLabel(unpricedAttempts)}` : COST_NOTE;
}

/** A figure in mono, with its exact value in `title`. */
function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="or-mono" title={title}>
      {children}
    </span>
  );
}

function Tokens({ value }: { value: number }) {
  return <Mono title={count(value)}>{formatTokens(value)}</Mono>;
}

function Rate({ attempts }: { attempts: Figures["attempts"] }) {
  return attempts.successRate === null ? (
    <Mono>—</Mono>
  ) : (
    <Mono title={rateTitle(attempts)}>{formatRate(attempts.successRate)}</Mono>
  );
}

function Cost({ figures }: { figures: { costUsd?: number; unpricedAttempts?: number } }) {
  return figures.costUsd === undefined ? (
    <Mono>—</Mono>
  ) : (
    <Mono title={costNote(figures.unpricedAttempts)}>{formatUsd(figures.costUsd)}</Mono>
  );
}

/** A table cell's figure; on the phone card its column header leads it. */
function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="or-analytics__figure">
      <span className="or-analytics__figure-label">{label} </span>
      {children}
    </span>
  );
}

/** The summary strip: the window's totals (Cost only when the response prices tokens). */
export function analyticsSummaryCells(data: RunAnalyticsResponse): SummaryCell[] {
  const { totals } = data;
  const tokens = tokenTotals(totals);
  const { attempts } = totals;
  const rated = attempts.completed + attempts.failed + attempts.expired;
  const cells: SummaryCell[] = [
    {
      id: "stories",
      label: "Stories completed",
      value: <Mono title={count(totals.stories)}>{count(totals.stories)}</Mono>,
    },
    {
      id: "reviews",
      label: "Reviews",
      value: <Mono title={count(totals.reviewRuns)}>{count(totals.reviewRuns)}</Mono>,
    },
    {
      id: "success",
      label: "Success rate",
      value: <Rate attempts={attempts} />,
      ...(attempts.successRate === null
        ? {}
        : { detail: `${count(attempts.completed)} of ${count(rated)} attempts` }),
    },
    { id: "tokens-in", label: "Tokens in", value: <Tokens value={tokens.in} /> },
    { id: "tokens-out", label: "Tokens out", value: <Tokens value={tokens.out} /> },
  ];
  if (hasCost(data)) {
    cells.push({
      id: "cost",
      label: "Cost",
      value: <Cost figures={totals} />,
      info: <InfoPopover label="About cost">{costNote(totals.unpricedAttempts)}</InfoPopover>,
    });
  }
  return cells;
}

/** The figure columns every table shares: per repo and per organization. */
function figureColumns<T extends Figures>(withCost: boolean): DataTableColumn<T>[] {
  const columns: DataTableColumn<T>[] = [
    {
      id: "stories",
      header: "Stories",
      align: "end",
      cell: (row) => (
        <Labeled label="Stories">
          <Mono>{count(row.stories)}</Mono>
        </Labeled>
      ),
    },
    {
      id: "reviews",
      header: "Reviews",
      align: "end",
      cell: (row) => (
        <Labeled label="Reviews">
          <Mono>{count(row.reviewRuns)}</Mono>
        </Labeled>
      ),
    },
    {
      id: "success",
      header: "Success rate",
      align: "end",
      cell: (row) => (
        <Labeled label="Success rate">
          <Rate attempts={row.attempts} />
        </Labeled>
      ),
    },
    {
      id: "tokens-in",
      header: "Tokens in",
      align: "end",
      cell: (row) => (
        <Labeled label="Tokens in">
          <Tokens value={tokenTotals(row).in} />
        </Labeled>
      ),
    },
    {
      id: "tokens-out",
      header: "Tokens out",
      align: "end",
      cell: (row) => (
        <Labeled label="Tokens out">
          <Tokens value={tokenTotals(row).out} />
        </Labeled>
      ),
    },
  ];
  if (withCost) {
    columns.push({
      id: "cost",
      header: "Cost",
      align: "end",
      cell: (row) => (
        <Labeled label="Cost">
          <Cost figures={row} />
        </Labeled>
      ),
    });
  }
  return columns;
}

/** "By repo": the repo (after its organization under "All organizations"), then the figures. */
export function repositoryColumns(
  showOrganization: boolean,
  withCost: boolean,
): DataTableColumn<RunAnalyticsRepositoryRow>[] {
  return [
    {
      id: "repo",
      header: "Repo",
      card: "title",
      cell: (row) => (
        <span className="or-analytics__repo">
          {showOrganization ? (
            <span className="or-analytics__repo-org">
              <OrgBadge name={row.organization.name} />
            </span>
          ) : null}
          <RepoBadge host={row.repository.provider} name={row.repository.fullPath} strong />
        </span>
      ),
    },
    // On the phone card the organization leads the meta (the table shows it in Repo).
    ...(showOrganization
      ? [
          {
            id: "organization",
            header: "Organization",
            table: "hidden" as const,
            cell: (row: RunAnalyticsRepositoryRow) => <OrgBadge name={row.organization.name} />,
          },
        ]
      : []),
    ...figureColumns<RunAnalyticsRepositoryRow>(withCost),
  ];
}

/** "By organization": the organization, then the figures. */
export function organizationColumns(
  withCost: boolean,
): DataTableColumn<RunAnalyticsOrganizationRow>[] {
  return [
    {
      id: "organization",
      header: "Organization",
      card: "title",
      cell: (row) => <OrgBadge name={row.organization.name} />,
    },
    ...figureColumns<RunAnalyticsOrganizationRow>(withCost),
  ];
}

interface KindRow extends TokenFigures {
  kind: RunKind;
}

/** "By kind": Epic, Request, Review, Triage and Ask, leaving out kinds with no tokens. */
export function kindRows(totals: Figures): KindRow[] {
  return RUN_KINDS.map((kind) => ({ kind, ...totals.tokens[kind] })).filter(
    (row) => row.tokensIn + row.tokensOut > 0,
  );
}

function kindColumns(withCost: boolean): DataTableColumn<KindRow>[] {
  return [
    { id: "kind", header: "Kind", card: "title", cell: (row) => RUN_KIND_LABELS[row.kind] },
    {
      id: "tokens-in",
      header: "Tokens in",
      align: "end",
      cell: (row) => (
        <Labeled label="Tokens in">
          <Tokens value={row.tokensIn} />
        </Labeled>
      ),
    },
    {
      id: "tokens-out",
      header: "Tokens out",
      align: "end",
      cell: (row) => (
        <Labeled label="Tokens out">
          <Tokens value={row.tokensOut} />
        </Labeled>
      ),
    },
    ...(withCost
      ? [
          {
            id: "cost",
            header: "Cost",
            align: "end" as const,
            cell: (row: KindRow) => (
              <Labeled label="Cost">
                <Cost figures={row} />
              </Labeled>
            ),
          },
        ]
      : []),
  ];
}

/** Repos by total tokens (in + out), most first; ties by full path. */
export function sortByTokens(rows: readonly RunAnalyticsRepositoryRow[]) {
  const total = (row: RunAnalyticsRepositoryRow) => {
    const tokens = tokenTotals(row);
    return tokens.in + tokens.out;
  };
  return [...rows].sort(
    (a, b) =>
      total(b) - total(a) || a.repository.fullPath.localeCompare(b.repository.fullPath),
  );
}

/** One chart series: each bucket's datum (its short label, its full name for weeks). */
function series(
  data: RunAnalyticsResponse,
  value: (bucket: Bucket) => number | null,
  note?: (bucket: Bucket) => string | undefined,
): BarChartDatum[] {
  return data.buckets.map((bucket) => ({
    key: bucket.start,
    label: dayLabel(bucket.start),
    ...(data.bucket === "week" ? { title: weekLabel(bucket.start) } : {}),
    value: value(bucket),
    ...(note ? { note: note(bucket) } : {}),
  }));
}

function AnalyticsChart({
  data,
  title,
  valueHeader,
  points,
  format,
  max,
  emptyValueText,
  hideTitle,
  overallRate,
}: {
  data: RunAnalyticsResponse;
  /** The chart's caption, e.g. "In". */
  title: string;
  /** What the summary and the table call the value, e.g. "Tokens in". */
  valueHeader: string;
  points: BarChartDatum[];
  format: (value: number) => string;
  max?: number;
  emptyValueText?: string;
  hideTitle?: boolean;
  /** For a rate: the window's overall rate (null when nothing was rated). */
  overallRate?: number | null;
}) {
  return (
    <BarChart
      title={title}
      hideTitle={hideTitle}
      summary={chartSummary({
        title: valueHeader,
        bucket: data.bucket,
        from: data.from,
        to: data.to,
        points: points.map((point) => ({ start: point.key, value: point.value })),
        format,
        measure: overallRate === undefined ? { kind: "total" } : { kind: "rate", overall: overallRate },
      })}
      data={points}
      formatValue={format}
      max={max}
      tableHeaders={[data.bucket === "week" ? "Week of" : "Day", valueHeader]}
      emptyValueText={emptyValueText}
    />
  );
}

function Charts({ data, withCost }: { data: RunAnalyticsResponse; withCost: boolean }) {
  return (
    <div className="or-analytics__charts">
      <Card title="Stories completed">
        <AnalyticsChart
          data={data}
          title="Stories completed"
          valueHeader="Stories completed"
          hideTitle
          points={series(data, (bucket) => bucket.stories)}
          format={count}
        />
      </Card>
      <Card title="Reviews">
        <AnalyticsChart
          data={data}
          title="Reviews"
          valueHeader="Reviews"
          hideTitle
          points={series(data, (bucket) => bucket.reviewRuns)}
          format={count}
        />
      </Card>
      <Card title="Success rate">
        <AnalyticsChart
          data={data}
          title="Success rate"
          valueHeader="Success rate"
          hideTitle
          points={series(data, (bucket) => bucket.attempts.successRate)}
          format={formatRate}
          max={1}
          emptyValueText="No attempts"
          overallRate={data.totals.attempts.successRate}
        />
      </Card>
      <Card title="Tokens" className="or-analytics__tokens">
        <div className="or-analytics__stack">
          <AnalyticsChart
            data={data}
            title="In"
            valueHeader="Tokens in"
            points={series(data, (bucket) => tokenTotals(bucket).in)}
            format={formatTokens}
          />
          <AnalyticsChart
            data={data}
            title="Out"
            valueHeader="Tokens out"
            points={series(data, (bucket) => tokenTotals(bucket).out)}
            format={formatTokens}
          />
          {withCost ? (
            <AnalyticsChart
              data={data}
              title="Cost"
              valueHeader="Cost"
              points={series(
                data,
                (bucket) => bucket.costUsd ?? null,
                (bucket) => costNote(bucket.unpricedAttempts),
              )}
              format={formatUsd}
            />
          ) : null}
        </div>
      </Card>
    </div>
  );
}

/** Card-shaped placeholders while the first figures load (no spinner, no text). */
function Placeholders() {
  return (
    <div className="or-analytics__placeholders" aria-hidden="true">
      <div className="or-analytics__placeholder or-analytics__placeholder--summary" />
      <div className="or-analytics__charts">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="or-analytics__placeholder or-analytics__placeholder--chart" />
        ))}
      </div>
    </div>
  );
}

/** The Repository filter's options: one group per organization under "All organizations". */
function repositoryOptions(
  repositories: readonly RunAnalyticsRepositoryOption[],
  grouped: boolean,
): ReactNode {
  const option = (repository: RunAnalyticsRepositoryOption) => (
    <option key={repository.id} value={repository.id}>
      {repository.fullPath}
    </option>
  );
  if (!grouped) return repositories.map(option);
  const groups = new Map<string, { name: string; repositories: RunAnalyticsRepositoryOption[] }>();
  for (const repository of repositories) {
    const group = groups.get(repository.organization.id) ?? {
      name: repository.organization.name,
      repositories: [],
    };
    group.repositories.push(repository);
    groups.set(repository.organization.id, group);
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .map(([id, group]) => (
      <optgroup key={id} label={group.name}>
        {group.repositories.map(option)}
      </optgroup>
    ));
}

export interface AnalyticsViewProps {
  /** `all` under "All organizations", else the active organization's id. */
  scope: ScopeParam;
}

/**
 * Analytics: the window (7, 30 or 90 days) and repository filters in the URL (`?days=`,
 * `?repo=`, defaults left out), the summary strip, four bar charts with their tables, and
 * the figures by repo, by organization (under "All organizations") and by kind. A live
 * query: the figures update in place as runs, attempts and reviews finish. Changing a
 * filter keeps the previous figures (`aria-busy`) while the new ones load; a failed refetch
 * keeps them too and says so in a toast. Cost shows only when the response prices tokens.
 */
export function AnalyticsView({ scope }: AnalyticsViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const params = parseAnalyticsParams({
    days: searchParams.get("days") ?? undefined,
    repo: searchParams.get("repo") ?? undefined,
  });
  const showOrganization = scope === "all";
  const query = useRunAnalytics(params, scope);
  const data = query.data;

  const navigate = (next: AnalyticsParams) =>
    router.push(analyticsHref(ANALYTICS_PATH, next), { scroll: false });

  // The server ignored a repository outside the scope: drop it from the URL.
  const ignoredRepository =
    !query.isPlaceholderData &&
    data !== undefined &&
    params.repositoryId !== null &&
    data.params.repositoryId === null;
  useEffect(() => {
    if (ignoredRepository) {
      router.replace(analyticsHref(ANALYTICS_PATH, { days: params.days, repositoryId: null }), {
        scroll: false,
      });
    }
  }, [ignoredRepository, params.days, router]);

  // A refetch that fails while figures are shown keeps them, and says so once.
  const reportedError = useRef(0);
  const refetchFailed = query.isRefetchError ? query.errorUpdatedAt : 0;
  useEffect(() => {
    if (refetchFailed && refetchFailed !== reportedError.current) {
      reportedError.current = refetchFailed;
      toast("Couldn't refresh analytics.", { variant: "danger" });
    }
  }, [refetchFailed]);

  const withCost = data ? hasCost(data) : false;
  const selected = data?.repositories.find((r) => r.id === data.params.repositoryId);

  let content: ReactNode;
  if (!data && query.isError) {
    content = (
      <div className="or-analytics__error" role="alert">
        <p className="or-analytics__error-text">Couldn&apos;t load analytics.</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  } else if (!data) {
    content = <Placeholders />;
  } else if (isEmptyWindow(data.totals)) {
    content = (
      <EmptyState
        title={
          selected
            ? `Nothing ran in ${selected.fullPath} in the last ${data.params.days} days`
            : `Nothing ran in the last ${data.params.days} days`
        }
      />
    );
  } else {
    const kinds = kindRows(data.totals);
    const kindTable = (
      <DataTable
        caption="By kind"
        rows={kinds}
        getRowId={(row) => row.kind}
        columns={kindColumns(withCost)}
      />
    );
    content = (
      <>
        <SummaryCells aria-label="Summary" cells={analyticsSummaryCells(data)} />
        <Charts data={data} withCost={withCost} />
        <Card title="By repo">
          <DataTable
            caption="By repo"
            rows={sortByTokens(data.byRepository)}
            getRowId={(row) => row.repository.id}
            getRowHref={(row) =>
              analyticsHref(ANALYTICS_PATH, { days: params.days, repositoryId: row.repository.id })
            }
            columns={repositoryColumns(showOrganization, withCost)}
          />
        </Card>
        {showOrganization ? (
          <Card title="By organization">
            <DataTable
              caption="By organization"
              rows={data.byOrganization}
              getRowId={(row) => row.organization.id}
              columns={organizationColumns(withCost)}
            />
          </Card>
        ) : null}
        <Card title="By kind" className="or-analytics__by-kind">
          {kindTable}
        </Card>
        <DetailsSection title="By kind" className="or-analytics__by-kind-phone">
          {kindTable}
        </DetailsSection>
      </>
    );
  }

  return (
    <div className="or-analytics">
      <div className="or-analytics__head">
        <h1 className="or-analytics__title">Analytics</h1>
        <div className="or-analytics__filters">
          <SegmentedControl
            aria-label="Window"
            className="or-analytics__window"
            options={WINDOW_OPTIONS}
            value={`${params.days}`}
            onValueChange={(days) =>
              navigate({ ...params, days: Number(days) as AnalyticsParams["days"] })
            }
          />
          <Select
            aria-label="Repository"
            className="or-analytics__repo-select"
            value={params.repositoryId ?? ""}
            onChange={(event) => navigate({ ...params, repositoryId: event.target.value || null })}
          >
            <option value="">All repos</option>
            {data ? repositoryOptions(data.repositories, showOrganization) : null}
          </Select>
        </div>
      </div>
      <div
        className="or-analytics__content"
        aria-busy={query.isPlaceholderData || (!data && query.isFetching) ? "true" : undefined}
      >
        {content}
      </div>
    </div>
  );
}
