"use client";

import * as React from "react";
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
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconChevronRight, IconExternalLink, IconHistory } from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { ReviewStatusBadge, SeverityBadge, TriggerBadge } from "@/components/review-badges";
import { formatDateTime } from "@/lib/format-date";
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

const cellText = { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } as const;
const mono = { fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" } as const;
const column = { display: "flex", flexDirection: "column", gap: "var(--space-1)" } as const;

function FindingCounts({ counts }: { counts: ReviewRow["findingCounts"] }) {
  const present = FINDING_SEVERITIES.filter((s) => counts[s] > 0);
  if (present.length === 0) return <Muted>None</Muted>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
      {present.map((severity) => (
        <SeverityBadge key={severity} severity={severity} count={counts[severity]} />
      ))}
    </div>
  );
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
  return (
    <TableRow>
      <TableCell>
        <div style={column}>
          <a
            href={review.prUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--text-primary)",
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-1)",
            }}
          >
            <span style={{ fontFamily: "var(--font-mono)" }}>
              {review.repository.provider === "gitlab" ? "!" : "#"}
              {review.prNumber}
            </span>
            <span>{review.prTitle ?? <Muted>Untitled</Muted>}</span>
            <IconExternalLink size={12} style={{ flexShrink: 0 }} />
          </a>
          {showRepository && (
            <Link
              href={`/repositories/${review.repository.id}/reviews`}
              style={{
                ...mono,
                color: "var(--text-secondary)",
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-1)",
              }}
            >
              <ProviderIcon provider={review.repository.provider} size={12} />
              {review.repository.fullPath}
            </Link>
          )}
        </div>
      </TableCell>
      <TableCell>
        <TriggerBadge trigger={review.trigger} />
      </TableCell>
      <TableCell>
        <div style={column}>
          <ReviewStatusBadge status={review.status} />
          {review.status === "failed" && review.error && (
            <Muted title={review.error} style={{ maxWidth: "calc(var(--space-6) * 10)" }}>
              {review.error.length > 80 ? `${review.error.slice(0, 80)}…` : review.error}
            </Muted>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div style={column}>
          <span style={{ ...cellText, color: "var(--text-primary)" }}>
            {review.profileName ?? "—"}
          </span>
          {review.agent ? (
            isAdmin ? (
              <Link
                href={`/agents/${review.agent.id}`}
                style={{ ...cellText, textDecoration: "none" }}
              >
                {review.agent.name}
              </Link>
            ) : (
              <span style={cellText}>{review.agent.name}</span>
            )
          ) : (
            <Muted>No agent</Muted>
          )}
        </div>
      </TableCell>
      <TableCell>
        <FindingCounts counts={review.findingCounts} />
      </TableCell>
      <TableCell>
        <span
          style={{ ...mono, color: overBudget ? "var(--error)" : "var(--text-secondary)" }}
          title={`${review.tokensUsed.toLocaleString()} of ${review.budget.toLocaleString()} tokens`}
        >
          {formatTokens(review.tokensUsed)} / {formatTokens(review.budget)}
        </span>
      </TableCell>
      <TableCell>
        <span style={cellText}>{formatDuration(review.durationMs) ?? "—"}</span>
      </TableCell>
      <TableCell>
        <span style={cellText}>{formatDateTime(review.createdAt)}</span>
      </TableCell>
      <TableCell style={{ textAlign: "right", whiteSpace: "nowrap" }}>
        <RerunReviewDialog
          reviewId={review.id}
          changeLabel={`${review.repository.provider === "gitlab" ? "!" : "#"}${review.prNumber}`}
          compact
        />
        <Button
          asChild
          variant="ghost"
          size="icon"
          aria-label={`Review of ${review.prNumber}`}
          title="View review"
        >
          <Link href={`/reviews/${review.id}`}>
            <IconChevronRight size={14} />
          </Link>
        </Button>
      </TableCell>
    </TableRow>
  );
}

/** Page numbers to show: first, last and the current page's neighbours. */
function pageWindow(page: number, pageCount: number): (number | "gap")[] {
  const pages = new Set([1, pageCount, page - 1, page, page + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  return sorted.flatMap((p, i) => (i > 0 && p - sorted[i - 1]! > 1 ? ["gap" as const, p] : [p]));
}

function ReviewPagination({
  params,
  pageCount,
  hrefFor,
}: {
  params: ReviewListParams;
  pageCount: number;
  hrefFor: (page: number) => string;
}) {
  const router = useRouter();
  if (pageCount <= 1) return null;
  const go = (page: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    router.push(hrefFor(page));
  };
  return (
    <Pagination>
      <PaginationContent>
        {params.page > 1 && (
          <PaginationItem>
            <PaginationPrevious href={hrefFor(params.page - 1)} onClick={go(params.page - 1)} />
          </PaginationItem>
        )}
        {pageWindow(params.page, pageCount).map((p, i) =>
          p === "gap" ? (
            <PaginationItem key={`gap-${i}`}>
              <Muted>…</Muted>
            </PaginationItem>
          ) : (
            <PaginationItem key={p}>
              <PaginationLink href={hrefFor(p)} isActive={p === params.page} onClick={go(p)}>
                {p}
              </PaginationLink>
            </PaginationItem>
          ),
        )}
        {params.page < pageCount && (
          <PaginationItem>
            <PaginationNext href={hrefFor(params.page + 1)} onClick={go(params.page + 1)} />
          </PaginationItem>
        )}
      </PaginationContent>
    </Pagination>
  );
}

export function ReviewsView({ repository, reviews, params, total, pageSize }: ReviewsViewProps) {
  const isAdmin = useCurrentUser().role === "admin";
  const router = useRouter();
  const pathname = usePathname();
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
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
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-6)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-4)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              style={{
                margin: 0,
                fontSize: "var(--text-2xl)",
                fontWeight: "var(--font-weight-semibold)",
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
              }}
            >
              {repository ? (
                <>
                  <ProviderIcon provider={repository.provider} size={20} />
                  <span style={{ fontFamily: "var(--font-mono)" }}>{repository.fullPath}</span>
                </>
              ) : (
                "Reviews"
              )}
            </h1>
            <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
              {repository
                ? "Every review of this repository's pull and merge requests."
                : "Every review across connected repositories."}
            </Muted>
          </div>
          {repository && (
            <Button asChild variant="ghost">
              <a href={repository.webUrl} target="_blank" rel="noreferrer">
                <IconExternalLink size={14} />
                Open on {repository.provider === "github" ? "GitHub" : "GitLab"}
              </a>
            </Button>
          )}
        </div>

        {repository?.connected && <RepositoryNav repositoryId={repository.id} current="reviews" />}

        <Card>
          <CardHeader>
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: "var(--space-4)",
                flexWrap: "wrap",
              }}
            >
              <div>
                <CardTitle>Review history</CardTitle>
                <CardDescription>
                  {total === 0
                    ? "Newest first."
                    : `Newest first. Showing ${first}–${last} of ${total.toLocaleString()}.`}
                </CardDescription>
              </div>
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
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
                      {s.replace("_", " ")}
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
          <CardContent style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            {reviews.length === 0 ? (
              <Empty
                icon={<IconHistory size={24} />}
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      {repository ? (repository.provider === "gitlab" ? "MR" : "PR") : "PR / MR"}
                    </TableHead>
                    <TableHead>Trigger</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Profile / agent</TableHead>
                    <TableHead>Findings</TableHead>
                    <TableHead>Tokens / budget</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Created</TableHead>
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
            <ReviewPagination
              params={params}
              pageCount={pageCount}
              hrefFor={(page) => reviewListHref(pathname, { ...params, page })}
            />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
