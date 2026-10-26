"use client";

import * as React from "react";
import { Link } from "@/components/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  Muted,
  NativeSelect,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconExternalLink, IconHistory } from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { ReviewStatusBadge, SeverityCounts, TriggerBadge } from "@/components/review-badges";
import { ExternalRowLink, PhoneMeta, Timestamp, WIDE_COLUMN } from "@/components/list-table";
import { ListPagination } from "@/components/list-pagination";
import { ListErrorRow, useListErrorId } from "@/components/list-error";
import { MonoPath, MonoValue } from "@/components/mono-value";
import { PageHeader } from "@/components/page-header";
import { Freshness } from "@/components/freshness";
import { QueryBoundary } from "@/components/query-boundary";
import type { ReviewList } from "@/lib/api/reviews";
import { pageRange, totalPages } from "@/lib/pagination";
import {
  FINDING_SEVERITIES,
  formatDuration,
  formatTokens,
  parseReviewListParams,
  REVIEW_STATUSES,
  REVIEW_TRIGGERS,
  reviewListHref,
  type ReviewListParams,
  type ReviewRow,
} from "@/lib/reviews/display";
import { ProviderIcon } from "@/components/provider-icon";
import { RepositoryNav } from "../repositories/[id]/repository-nav";
import { RerunReviewDialog } from "./rerun-review-dialog";
import { REVIEW_DEPTHS } from "@omniralph/shared";
import { EmptyValue } from "@/components/empty-value";
import { stateLabel } from "@/lib/state-variants";
import { useReviewList } from "./review-queries";

/** Columns in a review row, for the failure reason's row under it. */
const REVIEW_COLUMNS = 7;
/**
 * The longest severity words ("1 critical 1 high") the Findings column fits on one line at
 * 1440; a longer set shows initials ("1C 1H 1M").
 */
const FINDINGS_WORDS_UP_TO = 16;

/** The severities a phone row still shows: the ones that need a look first. */
const PHONE_SEVERITIES = ["critical", "high"] as const;

function FindingCounts({ counts }: { counts: ReviewRow["findingCounts"] }) {
  if (FINDING_SEVERITIES.every((s) => counts[s] === 0)) return <Muted>None</Muted>;
  return <SeverityCounts counts={counts} wordsUpTo={FINDINGS_WORDS_UP_TO} />;
}

function ReviewTableRow({
  review,
  showRepository,
  isAdmin,
  year,
}: {
  review: ReviewRow;
  showRepository: boolean;
  isAdmin: boolean;
  year: number;
}) {
  const overBudget = review.tokensUsed > review.budget;
  const change = `${review.repository.provider === "gitlab" ? "!" : "#"}${review.prNumber}`;
  const host = review.repository.provider === "gitlab" ? "GitLab" : "GitHub";
  const error = review.status === "failed" ? review.error : null;
  const errorId = useListErrorId(error);
  return (
    <>
      <TableRow data-has-error={error ? true : undefined}>
        <TableCell className="list-col-main review-col-main">
          <div className="list-cell-stack">
            <Link
              href={`/reviews/${review.id}`}
              className="list-title"
              title={review.prTitle ?? undefined}
              aria-describedby={errorId}
            >
              <span className="text-numeric list-nowrap">{change}</span>
              <span
                className={
                  review.prTitle ? "list-title-text" : "list-title-text list-title-text-muted"
                }
              >
                {review.prTitle ?? "Untitled"}
              </span>
            </Link>
            {showRepository && (
              <Link
                href={`/repositories/${review.repository.id}/reviews`}
                className="list-secondary list-nowrap"
              >
                <ProviderIcon provider={review.repository.provider} size={12} />
                <MonoValue value={review.repository.fullPath} />
              </Link>
            )}
          </div>
          <PhoneMeta>
            <ReviewStatusBadge status={review.status} />
            <SeverityCounts counts={review.findingCounts} only={PHONE_SEVERITIES} />
            <Timestamp iso={review.createdAt} year={year} />
          </PhoneMeta>
        </TableCell>
        <TableCell className={WIDE_COLUMN} aria-describedby={errorId}>
          <div className="list-cell-stack">
            <ReviewStatusBadge status={review.status} />
            <TriggerBadge trigger={review.trigger} />
          </div>
        </TableCell>
        <TableCell className={WIDE_COLUMN}>
          <div className="list-cell-stack">
            <span className="list-text list-text-primary">
              {review.depth ? REVIEW_DEPTHS[review.depth].label : <EmptyValue />}
            </span>
            {review.agent ? (
              isAdmin ? (
                <Link href={`/agents/${review.agent.id}`} className="list-text">
                  {review.agent.name}
                </Link>
              ) : (
                <span className="list-text">{review.agent.name}</span>
              )
            ) : (
              <Muted>No agent</Muted>
            )}
          </div>
        </TableCell>
        <TableCell className={`${WIDE_COLUMN} review-col-nowrap`}>
          <FindingCounts counts={review.findingCounts} />
        </TableCell>
        <TableCell className={`${WIDE_COLUMN} review-col-nowrap`}>
          <div className="list-cell-stack">
            <span
              className={`list-time text-numeric${overBudget ? " list-text-danger" : ""}`}
              title={`${review.tokensUsed.toLocaleString()} of ${review.budget.toLocaleString()} tokens`}
            >
              {formatTokens(review.tokensUsed)} / {formatTokens(review.budget)}
            </span>
            <span className="list-time text-numeric" title="Duration">
              {formatDuration(review.durationMs) ?? <EmptyValue />}
            </span>
          </div>
        </TableCell>
        <TableCell className={`${WIDE_COLUMN} review-col-nowrap`}>
          <Timestamp iso={review.createdAt} year={year} />
        </TableCell>
        <TableCell className="list-actions">
          <div className="list-actions-group">
            <RerunReviewDialog reviewId={review.id} changeLabel={change} compact />
            <ExternalRowLink href={review.prUrl} label={`Open ${change} on ${host}`} />
          </div>
        </TableCell>
      </TableRow>
      {error && <ListErrorRow error={error} colSpan={REVIEW_COLUMNS} id={errorId} />}
    </>
  );
}

/** The reviews table's skeleton: rows shaped like reviews while the first page loads. */
function ReviewsSkeleton() {
  return (
    <Table className="list-table reviews-table">
      <TableBody>
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <TableRow key={index}>
            <TableCell className="list-col-main review-col-main">
              <Skeleton width={`${45 + ((index * 17) % 35)}%`} />
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <Skeleton width="5rem" height="1.25rem" radius="full" />
            </TableCell>
            {Array.from({ length: 4 }, (_, column) => (
              <TableCell key={column} className={WIDE_COLUMN}>
                <Skeleton width={`${40 + (((index + column) * 13) % 40)}%`} />
              </TableCell>
            ))}
            <TableCell />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const SKELETON_ROWS = 5;

function ReviewsTable({
  list,
  params,
  isAdmin,
}: {
  list: ReviewList;
  params: ReviewListParams;
  isAdmin: boolean;
}) {
  const pathname = usePathname();
  const { reviews, total, repository } = list;
  const filtered = params.status !== null || params.trigger !== null;
  // Rows render on the client only (after the first load), so the browser's year is safe.
  const year = new Date().getFullYear();
  return (
    <>
      {reviews.length === 0 ? (
        <Empty
          icon={<IconHistory size={24} />}
          titleAs="h3"
          title={
            total > 0
              ? "No reviews on this page"
              : filtered
                ? "No reviews match these filters"
                : "No reviews yet"
          }
          description={
            total > 0
              ? "The page is past the last one."
              : "Reviews appear here when pull or merge requests are opened or updated, or when the bot is mentioned."
          }
        />
      ) : (
        <Table className="list-table reviews-table">
          <TableHeader>
            <TableRow>
              <TableHead className="list-nowrap">
                {repository ? (repository.provider === "gitlab" ? "MR" : "PR") : "PR / MR"}
              </TableHead>
              <TableHead className={`${WIDE_COLUMN} list-nowrap`}>Status / trigger</TableHead>
              <TableHead className={`${WIDE_COLUMN} list-nowrap`}>Depth / agent</TableHead>
              <TableHead className={WIDE_COLUMN}>Findings</TableHead>
              <TableHead className={`${WIDE_COLUMN} list-nowrap`}>Tokens / duration</TableHead>
              <TableHead className={WIDE_COLUMN}>Created</TableHead>
              <TableHead aria-label="Actions" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {reviews.map((review) => (
              <ReviewTableRow
                key={review.id}
                review={review}
                showRepository={!repository}
                isAdmin={isAdmin}
                year={year}
              />
            ))}
          </TableBody>
        </Table>
      )}
      <ListPagination
        page={params.page}
        pageCount={totalPages(total, list.pageSize)}
        hrefFor={(page) => reviewListHref(pathname, { ...params, page })}
      />
    </>
  );
}

/**
 * The list's filters and page from the URL, and a setter. A chosen filter shows at once,
 * before the navigation that puts it in the URL (bookmarkable, back button) has finished.
 */
function useReviewListParams(): [ReviewListParams, (change: Partial<ReviewListParams>) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const fromUrl = parseReviewListParams(Object.fromEntries(searchParams));
  // Chosen on the URL `search`: once the URL changes, it holds the choice.
  const [chosen, setChosen] = React.useState<{
    search: string;
    params: ReviewListParams;
  } | null>(null);
  // Once the URL moves on (the navigation landed, or Back), the choice is spent: a later
  // return to the same URL shows that URL's filter, not the old choice.
  if (chosen && chosen.search !== search) setChosen(null);
  const params = chosen?.search === search ? chosen.params : fromUrl;
  const setFilter = (change: Partial<ReviewListParams>) => {
    const next = { ...params, ...change, page: 1 };
    setChosen({ search, params: next });
    router.push(reviewListHref(pathname, next), { scroll: false });
  };
  return [params, setFilter];
}

/**
 * The Reviews page, live (`GET /api/ui/reviews`), or with `inRepository` Repository ›
 * Reviews (the route's repository). A new filter or page keeps the previous results,
 * dimmed, until its own arrive.
 */
export function ReviewsView({ inRepository = false }: { inRepository?: boolean }) {
  const isAdmin = useCurrentUser().role === "admin";
  const { id } = useParams<{ id?: string }>();
  const repositoryId = inRepository ? (id ?? null) : null;
  const [params, setFilter] = useReviewListParams();
  const list = useReviewList(params, repositoryId);
  const data = list.data;
  const repository = data?.repository ?? null;
  const total = data?.total ?? 0;
  const { first, last } = pageRange(
    data?.page ?? params.page,
    data?.pageSize ?? 1,
    data?.reviews.length ?? 0,
  );

  return (
    <>
      <AppHeader
        breadcrumbs={
          repositoryId
            ? [
                { label: "Repositories", href: "/repositories" },
                { label: repository?.fullPath ?? "Repository" },
                { label: "Reviews" },
              ]
            : [{ label: "Reviews" }]
        }
      />
      <div className="detail-main">
        <PageHeader
          title={
            !repositoryId ? (
              "Reviews"
            ) : repository ? (
              <>
                <ProviderIcon provider={repository.provider} size={20} />
                <MonoPath value={repository.fullPath} />
              </>
            ) : (
              <Skeleton width="16rem" height="1.75rem" />
            )
          }
          description={
            repositoryId
              ? "Every review of this repository's pull and merge requests."
              : "Every review across connected repositories."
          }
          meta={<Freshness query={list} />}
          actions={
            repository && (
              <Button asChild variant="ghost" className="page-header-ghost">
                <a href={repository.webUrl} target="_blank" rel="noreferrer">
                  <IconExternalLink size={14} />
                  Open on {repository.provider === "github" ? "GitHub" : "GitLab"}
                </a>
              </Button>
            )
          }
        />

        {repository?.connected && <RepositoryNav repositoryId={repository.id} current="reviews" />}

        <Card>
          <CardHeader>
            <div className="list-card-header">
              <div>
                <CardTitle as="h2">Review history</CardTitle>
                <CardDescription>
                  {total === 0
                    ? "Newest first."
                    : `Newest first. Showing ${first}–${last} of ${total.toLocaleString()}.`}
                </CardDescription>
              </div>
              <div className="list-filters">
                <NativeSelect
                  aria-label="Filter by status"
                  value={params.status ?? ""}
                  onChange={(e) =>
                    setFilter({ status: (e.target.value || null) as ReviewListParams["status"] })
                  }
                >
                  <option value="">All statuses</option>
                  {REVIEW_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {stateLabel(s)}
                    </option>
                  ))}
                </NativeSelect>
                <NativeSelect
                  aria-label="Filter by trigger"
                  value={params.trigger ?? ""}
                  onChange={(e) =>
                    setFilter({ trigger: (e.target.value || null) as ReviewListParams["trigger"] })
                  }
                >
                  <option value="">All triggers</option>
                  {REVIEW_TRIGGERS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
          </CardHeader>
          <CardContent className="list-card-content">
            <QueryBoundary query={list} skeleton={<ReviewsSkeleton />} what="reviews">
              {(loaded) => (
                <div className="list-pending" aria-busy={list.isPlaceholderData}>
                  <ReviewsTable list={loaded} params={params} isAdmin={isAdmin} />
                </div>
              )}
            </QueryBoundary>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
