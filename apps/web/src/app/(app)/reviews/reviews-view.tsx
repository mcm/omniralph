"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
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
import { MonoPath } from "@/components/mono-value";
import { PageHeader } from "@/components/page-header";
import { totalPages } from "@/lib/pagination";
import {
  FINDING_SEVERITIES,
  formatDuration,
  formatTokens,
  REVIEW_STATUSES,
  REVIEW_TRIGGERS,
  reviewListHref,
  type ReviewListParams,
  type ReviewRow,
} from "@/lib/reviews/display";
import { ProviderIcon } from "../repositories/repositories-view";
import { RepositoryNav } from "../repositories/[id]/repository-nav";
import { RerunReviewDialog } from "./rerun-review-dialog";
import { EmptyValue } from "@/components/empty-value";
import { stateLabel } from "@/lib/state-variants";

interface ReviewsViewProps {
  /** The repository whose reviews are listed; null lists all repositories. */
  repository: {
    id: string;
    provider: "github" | "gitlab";
    fullPath: string;
    webUrl: string;
    /** False once disconnected: its history stays browsable, its settings don't. */
    connected: boolean;
  } | null;
  reviews: ReviewRow[];
  params: ReviewListParams;
  total: number;
  pageSize: number;
}

/** The severities a phone row still shows: the ones that need a look first. */
const PHONE_SEVERITIES = ["critical", "high"] as const;

function FindingCounts({ counts }: { counts: ReviewRow["findingCounts"] }) {
  if (FINDING_SEVERITIES.every((s) => counts[s] === 0)) return <Muted>None</Muted>;
  return <SeverityCounts counts={counts} />;
}

function ReviewTableRow({
  review,
  showRepository,
  isAdmin,
}: {
  review: ReviewRow;
  showRepository: boolean;
  isAdmin: boolean;
}) {
  const overBudget = review.tokensUsed > review.budget;
  const change = `${review.repository.provider === "gitlab" ? "!" : "#"}${review.prNumber}`;
  const host = review.repository.provider === "gitlab" ? "GitLab" : "GitHub";
  return (
    <TableRow>
      <TableCell className="list-col-main review-col-main">
        <div className="list-cell-stack">
          <Link
            href={`/reviews/${review.id}`}
            className="list-title"
            title={review.prTitle ?? undefined}
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
              className="list-secondary text-numeric list-nowrap"
            >
              <ProviderIcon provider={review.repository.provider} size={12} />
              <span className="review-ellipsis">{review.repository.fullPath}</span>
            </Link>
          )}
        </div>
        <PhoneMeta>
          <ReviewStatusBadge status={review.status} />
          <SeverityCounts counts={review.findingCounts} only={PHONE_SEVERITIES} />
          <Timestamp iso={review.createdAt} />
        </PhoneMeta>
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <div className="list-cell-stack">
          <ReviewStatusBadge status={review.status} />
          <TriggerBadge trigger={review.trigger} />
          {review.status === "failed" && review.error && (
            <Muted title={review.error} className="review-error">
              {review.error}
            </Muted>
          )}
        </div>
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
        <div className="list-cell-stack">
          <span className="list-text list-text-primary">
            {review.profileName ?? <EmptyValue />}
          </span>
          {review.agent ? (
            isAdmin ? (
              <Link href={`/harnesses/${review.agent.id}`} className="list-text">
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
      <TableCell className={`${WIDE_COLUMN} review-col-findings`}>
        <FindingCounts counts={review.findingCounts} />
      </TableCell>
      <TableCell className={WIDE_COLUMN}>
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
      <TableCell className={WIDE_COLUMN}>
        <Timestamp iso={review.createdAt} />
      </TableCell>
      <TableCell className="list-actions">
        <div className="list-actions-group">
          <RerunReviewDialog reviewId={review.id} changeLabel={change} compact />
          <ExternalRowLink href={review.prUrl} label={`Open ${change} on ${host}`} />
        </div>
      </TableCell>
    </TableRow>
  );
}

export function ReviewsView({ repository, reviews, params, total, pageSize }: ReviewsViewProps) {
  const isAdmin = useCurrentUser().role === "admin";
  const router = useRouter();
  const pathname = usePathname();
  const pageCount = totalPages(total, pageSize);
  const filtered = params.status !== null || params.trigger !== null;
  const first = total === 0 ? 0 : (params.page - 1) * pageSize + 1;
  const last = (params.page - 1) * pageSize + reviews.length;

  const setFilter = (change: Partial<ReviewListParams>) =>
    router.push(reviewListHref(pathname, { ...params, ...change, page: 1 }));

  return (
    <>
      <AppHeader
        breadcrumbs={
          repository
            ? [
                { label: "Repositories", href: "/repositories" },
                { label: repository.fullPath },
                { label: "Reviews" },
              ]
            : [{ label: "Reviews" }]
        }
      />
      <main className="detail-main">
        <PageHeader
          title={
            repository ? (
              <>
                <ProviderIcon provider={repository.provider} size={20} />
                <MonoPath value={repository.fullPath} />
              </>
            ) : (
              "Reviews"
            )
          }
          description={
            repository
              ? "Every review of this repository's pull and merge requests."
              : "Every review across connected repositories."
          }
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
              <Table className="list-table">
                <TableHeader>
                  <TableRow>
                    <TableHead className="list-nowrap">
                      {repository ? (repository.provider === "gitlab" ? "MR" : "PR") : "PR / MR"}
                    </TableHead>
                    <TableHead className={`${WIDE_COLUMN} list-nowrap`}>Status / trigger</TableHead>
                    <TableHead className={`${WIDE_COLUMN} list-nowrap`}>Profile / agent</TableHead>
                    <TableHead className={WIDE_COLUMN}>Findings</TableHead>
                    <TableHead className={`${WIDE_COLUMN} list-nowrap`}>
                      Tokens / duration
                    </TableHead>
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
                    />
                  ))}
                </TableBody>
              </Table>
            )}
            <ListPagination
              page={params.page}
              pageCount={pageCount}
              hrefFor={(page) => reviewListHref(pathname, { ...params, page })}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
