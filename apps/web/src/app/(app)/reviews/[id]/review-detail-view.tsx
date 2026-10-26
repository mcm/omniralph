"use client";

import * as React from "react";
import { Link } from "@/components/link";
import { useParams } from "next/navigation";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Cluster,
  Empty,
  InlineCode,
  Muted,
  Progress,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import {
  IconAlertTriangle,
  IconChecks,
  IconExternalLink,
  IconFileCode,
  IconHistory,
  IconRefresh,
} from "@tabler/icons-react";
import { FEEDBACK_REASON_LABELS, REVIEW_DEPTHS } from "@omniralph/shared";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { Fact, FactStrip } from "@/components/fact-strip";
import { Freshness } from "@/components/freshness";
import { QueryBoundary } from "@/components/query-boundary";
import { PhoneMeta, Timestamp, WIDE_COLUMN } from "@/components/list-table";
import { MonoValue } from "@/components/mono-value";
import { PageHeader } from "@/components/page-header";
import {
  FindingStatusBadge,
  ReviewStatusBadge,
  SeverityBadge,
  TriggerBadge,
} from "@/components/review-badges";
import {
  FINDING_SEVERITIES,
  formatDuration,
  formatTokens,
  type FeedbackView,
  type FileFindings,
  type FindingView,
  type ReviewDetailView as ReviewDetail,
} from "@/lib/reviews/display";
import { ProviderIcon } from "@/components/provider-icon";
import { RerunReviewDialog } from "../rerun-review-dialog";
import { useReviewDetail } from "../review-queries";
import { EmptyValue } from "@/components/empty-value";
import { REVIEW_STATUS_VARIANTS, stateLabel } from "@/lib/state-variants";

function lineRange(f: Pick<FindingView, "startLine" | "endLine">): string {
  return f.startLine === f.endLine ? `L${f.startLine}` : `L${f.startLine}–${f.endLine}`;
}

const SOURCE_LABELS: Record<FeedbackView["source"], string> = {
  ui: "control panel",
  scm: "@bot dismiss",
};

/**
 * The finding's dismissals, oldest first, read-only: findings are dismissed with `@bot dismiss`
 * in their thread on the PR/MR. Older ones may come from the control panel, or be restored.
 */
function FeedbackHistory({ feedback }: { feedback: FeedbackView[] }) {
  if (feedback.length === 0) return null;
  return (
    <div className="review-feedback">
      <Muted className="text-xs">Feedback</Muted>
      <Stack asChild gap={2} className="m-0 list-none p-0">
        <ul>
          {feedback.map((entry) => (
            <Stack asChild gap={1} key={entry.id} className="text-sm text-text-secondary">
              <li>
                <Cluster gap={2}>
                  <Badge variant="neutral" size="sm">
                    {FEEDBACK_REASON_LABELS[entry.reason]}
                  </Badge>
                  <span>
                    Dismissed by <span className="text-text-primary">{entry.actor}</span> via{" "}
                    {SOURCE_LABELS[entry.source]} · <Timestamp iso={entry.createdAt} inline />
                  </span>
                  {entry.restoredAt && (
                    <Badge variant="neutral" size="sm">
                      Restored
                    </Badge>
                  )}
                </Cluster>
                {entry.note && <span className="review-pre-wrap">&ldquo;{entry.note}&rdquo;</span>}
                {entry.restoredAt && (
                  <Muted className="text-xs">
                    Restored by {entry.restoredBy} · <Timestamp iso={entry.restoredAt} inline />
                  </Muted>
                )}
              </li>
            </Stack>
          ))}
        </ul>
      </Stack>
    </div>
  );
}

function FindingItem({ finding }: { finding: FindingView }) {
  // Dismissed and resolved findings are marked by their status badge and a secondary title.
  const inactive = finding.status !== "open";
  return (
    <li
      // Target of the source-finding links on Repository › Rules.
      id={`finding-${finding.id}`}
      className="review-finding"
      data-inactive={inactive || undefined}
    >
      {/* The title takes the row; status and actions wrap below it on a narrow screen. */}
      <div className="review-finding-head">
        <h4 className="review-finding-title">{finding.title}</h4>
        <div className="review-finding-actions">
          <FindingStatusBadge status={finding.status} />
        </div>
      </div>
      <div className="review-finding-meta">
        <SeverityBadge severity={finding.severity} />
        <span className="fact-mono">{lineRange(finding)}</span>
        <span>
          {finding.category} · confidence {Math.round(finding.confidence * 100)}%
        </span>
      </div>
      <p className="review-finding-body">{finding.body}</p>
      {finding.suggestion !== null && (
        <div className="review-finding-suggestion">
          <Muted className="fact-label">Suggested change</Muted>
          <pre className="review-code-block">{finding.suggestion}</pre>
        </div>
      )}
      {finding.supersededBy && (
        <Muted className="fact-label">
          Superseded by{" "}
          <Link
            href={`/reviews/${finding.supersededBy.reviewId}#finding-${finding.supersededBy.findingId}`}
            className="review-link"
          >
            a finding of a fresh review
          </Link>
          .
        </Muted>
      )}
      <FeedbackHistory feedback={finding.feedback} />
    </li>
  );
}

/** A file's findings under its path: one section of the Findings card, no card of its own. */
function FileFindingsSection({ file }: { file: FileFindings }) {
  return (
    <section className="review-file">
      <h3 className="review-file-header">
        <IconFileCode size={16} className="review-file-icon" />
        <MonoValue value={file.path} className="review-file-path" />
        <span className="review-file-count">
          {file.findings.length} finding{file.findings.length === 1 ? "" : "s"}
        </span>
      </h3>
      <ul className="review-findings">
        {file.findings.map((finding) => (
          <FindingItem key={finding.id} finding={finding} />
        ))}
      </ul>
    </section>
  );
}

/** The review's page skeleton: facts and a findings card, while the review loads. */
function ReviewSkeleton() {
  return (
    <>
      <FactStrip label="Review facts">
        {["Head SHA", "Base SHA", "Depth", "Model", "Agent", "Started", "Duration"].map((label) => (
          <Fact key={label} label={label}>
            <Skeleton width="6rem" />
          </Fact>
        ))}
      </FactStrip>
      <Card>
        <CardHeader>
          <CardTitle as="h2">Findings</CardTitle>
        </CardHeader>
        <CardContent className="review-files">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} width={`${50 + index * 15}%`} />
          ))}
        </CardContent>
      </Card>
    </>
  );
}

/** Shown on a review with a newer one of the same PR/MR (its re-run, or a review of a later push). */
function NewerReviewAlert({ newer }: { newer: NonNullable<ReviewDetail["newerReview"]> }) {
  const active = newer.status === "queued" || newer.status === "running";
  return (
    <Alert variant="info">
      <IconRefresh size={16} />
      <AlertTitle as="h2">
        {active ? "A newer review is in progress" : "There is a newer review"}
      </AlertTitle>
      <AlertDescription>
        <Link href={`/reviews/${newer.id}`} className="review-link">
          Open the newer review
        </Link>{" "}
        <ReviewStatusBadge status={newer.status} />
      </AlertDescription>
    </Alert>
  );
}

function changeLabelOf(review: ReviewDetail): string {
  return `${review.repository.provider === "gitlab" ? "!" : "#"}${review.prNumber}`;
}

function ReviewContent({ review, isAdmin }: { review: ReviewDetail; isAdmin: boolean }) {
  const tokensUsed = review.tokensIn + review.tokensOut;
  const budgetShare = review.budget > 0 ? Math.min(100, (tokensUsed / review.budget) * 100) : 0;
  const severityCounts = FINDING_SEVERITIES.map((severity) => ({
    severity,
    count: review.files.reduce(
      (n, file) => n + file.findings.filter((f) => f.severity === severity).length,
      0,
    ),
  })).filter(({ count }) => count > 0);
  const active = review.status === "queued" || review.status === "running";

  return (
    <>
      {review.newerReview && <NewerReviewAlert newer={review.newerReview} />}
      {review.status === "failed" && (
        <Alert variant={REVIEW_STATUS_VARIANTS.failed}>
          <IconAlertTriangle size={16} />
          <AlertTitle as="h2">The review failed</AlertTitle>
          <AlertDescription className="review-pre-wrap">
            {review.error ?? "No error was recorded."}
          </AlertDescription>
        </Alert>
      )}
      {review.status === "skipped" && review.error && (
        <Alert variant={REVIEW_STATUS_VARIANTS.skipped}>
          <AlertTitle as="h2">The review was skipped</AlertTitle>
          <AlertDescription>{review.error}</AlertDescription>
        </Alert>
      )}
      {review.status === "budget_exhausted" && (
        <Alert variant={REVIEW_STATUS_VARIANTS.budget_exhausted}>
          <AlertTitle as="h2">Token budget exhausted</AlertTitle>
          <AlertDescription>
            The review stopped at its token cap; the findings below are partial.
          </AlertDescription>
        </Alert>
      )}

      <FactStrip label="Review facts">
        <Fact label="Head SHA">
          <InlineCode title={review.headSha}>{review.headSha.slice(0, 12)}</InlineCode>
        </Fact>
        <Fact label="Base SHA">
          <InlineCode title={review.baseSha}>{review.baseSha.slice(0, 12)}</InlineCode>
        </Fact>
        <Fact label="Depth">
          {review.depth ? REVIEW_DEPTHS[review.depth].label : <EmptyValue />}
        </Fact>
        <Fact label="Model">
          {review.model ? <MonoValue value={review.model} className="fact-mono" /> : <EmptyValue />}
        </Fact>
        <Fact label="Agent">
          {review.agent ? (
            isAdmin ? (
              <Link href={`/agents/${review.agent.id}`} className="review-link">
                {review.agent.name}
              </Link>
            ) : (
              review.agent.name
            )
          ) : (
            <Muted>Not picked up yet</Muted>
          )}
        </Fact>
        <Fact label="Started">
          <Timestamp iso={review.createdAt} />
        </Fact>
        <Fact label="Duration">
          {active ? (
            <Muted>In progress</Muted>
          ) : (
            (formatDuration(review.durationMs) ?? <EmptyValue />)
          )}
        </Fact>
        <Fact label="Stop reason">{review.stopReason ?? <Muted>In progress</Muted>}</Fact>
        <Fact label="Tokens" wide>
          <div className="review-tokens">
            <span className="fact-mono">
              {formatTokens(tokensUsed)} of {formatTokens(review.budget)} ({Math.round(budgetShare)}
              %) · {review.tokensIn.toLocaleString()} in · {review.tokensOut.toLocaleString()} out
            </span>
            <Progress
              value={budgetShare}
              variant={budgetShare >= 100 ? "danger" : budgetShare >= 80 ? "warning" : "accent"}
              aria-label="Tokens used of the budget"
            />
          </div>
        </Fact>
      </FactStrip>

      {review.skippedFiles.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle as="h2">Skipped files</CardTitle>
            <CardDescription>
              {review.skippedFiles.length} file
              {review.skippedFiles.length === 1 ? " was" : "s were"} not reviewed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table className="list-table">
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead className={WIDE_COLUMN}>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {review.skippedFiles.map((file) => (
                  <TableRow key={file.path}>
                    <TableCell>
                      <MonoValue value={file.path} className="review-path" />
                      <PhoneMeta>
                        <Badge variant="neutral">{stateLabel(file.reason)}</Badge>
                      </PhoneMeta>
                    </TableCell>
                    <TableCell className={WIDE_COLUMN}>
                      <Badge variant="neutral">{stateLabel(file.reason)}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle as="h2">
            Findings <span className="text-numeric">({review.findingCount})</span>
          </CardTitle>
          {review.files.length > 0 && (
            <CardDescription>
              Grouped by file, in {review.files.length} file
              {review.files.length === 1 ? "" : "s"}.
            </CardDescription>
          )}
          {severityCounts.length > 0 && (
            <div className="review-severity-counts">
              {severityCounts.map(({ severity, count }) => (
                <SeverityBadge key={severity} severity={severity} count={count} />
              ))}
            </div>
          )}
        </CardHeader>
        <CardContent className="review-files">
          {review.files.length === 0 ? (
            <Empty
              size="sm"
              titleAs="h3"
              icon={active ? <IconHistory size={24} /> : <IconChecks size={24} />}
              title={active ? "Not finished yet" : "No findings"}
              description={
                active
                  ? "Findings appear here when the review completes."
                  : review.status === "completed" || review.status === "budget_exhausted"
                    ? "The reviewer found nothing to report."
                    : "This review produced no findings."
              }
            />
          ) : (
            review.files.map((file) => <FileFindingsSection key={file.path} file={file} />)
          )}
        </CardContent>
      </Card>
    </>
  );
}

/**
 * A review's page, live (`GET /api/ui/reviews/{id}`): its state, usage and findings refresh
 * while it runs, so the findings appear when it completes.
 */
export function ReviewDetailView() {
  const { id } = useParams<{ id: string }>();
  const detail = useReviewDetail(id);
  const isAdmin = useCurrentUser().role === "admin";
  const review = detail.data?.review;
  const changeLabel = review ? changeLabelOf(review) : null;

  return (
    <>
      <AppHeader
        breadcrumbs={
          review
            ? [
                { label: "Reviews", href: "/reviews" },
                {
                  label: review.repository.fullPath,
                  href: `/repositories/${review.repository.id}/reviews`,
                },
                { label: `Review of ${changeLabel}` },
              ]
            : [{ label: "Reviews", href: "/reviews" }, { label: "Review" }]
        }
      />
      <div className="detail-main">
        <PageHeader
          title={
            review ? (
              <>
                <span className="text-numeric">{changeLabel}</span> {review.prTitle ?? "Untitled"}
              </>
            ) : (
              <Skeleton width="16rem" height="1.75rem" />
            )
          }
          meta={
            review && (
              <>
                <Link
                  href={`/repositories/${review.repository.id}/reviews`}
                  className="list-secondary"
                >
                  <ProviderIcon provider={review.repository.provider} size={14} />
                  <MonoValue value={review.repository.fullPath} />
                </Link>
                <ReviewStatusBadge status={review.status} />
                <TriggerBadge trigger={review.trigger} />
                <Freshness query={detail} />
              </>
            )
          }
          actions={
            review && (
              <>
                <Button asChild variant="ghost" className="page-header-ghost">
                  <a href={review.prUrl} target="_blank" rel="noreferrer">
                    <IconExternalLink size={14} />
                    Open {review.repository.provider === "gitlab" ? "merge" : "pull"} request
                  </a>
                </Button>
                <RerunReviewDialog reviewId={review.id} changeLabel={changeLabel!} />
              </>
            )
          }
        />
        <QueryBoundary query={detail} skeleton={<ReviewSkeleton />} what="the review">
          {(data) => <ReviewContent review={data.review} isAdmin={isAdmin} />}
        </QueryBoundary>
      </div>
    </>
  );
}
