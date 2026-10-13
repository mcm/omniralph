"use client";

import * as React from "react";
import Link from "next/link";
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
  Empty,
  InlineCode,
  Muted,
  Progress,
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
} from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { Fact, FactStrip } from "@/components/fact-strip";
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
  type FileFindings,
  type FindingView,
  type ReviewDetailView as ReviewDetail,
} from "@/lib/reviews/display";
import { ProviderIcon } from "../../repositories/repositories-view";
import { RerunReviewDialog } from "../rerun-review-dialog";
import { DismissFindingDialog, FeedbackHistory, RestoreFindingButton } from "./finding-feedback";
import { EmptyValue } from "@/components/empty-value";
import { REVIEW_STATUS_VARIANTS, stateLabel } from "@/lib/state-variants";

function lineRange(f: Pick<FindingView, "startLine" | "endLine">): string {
  return f.startLine === f.endLine ? `L${f.startLine}` : `L${f.startLine}–${f.endLine}`;
}

function FindingItem({ finding }: { finding: FindingView }) {
  // Dismissed and resolved findings are marked by their status badge and a secondary title,
  // never by opacity: dimming the item would also dim its Restore control.
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
          {finding.status === "open" && <DismissFindingDialog finding={finding} />}
          {finding.status === "dismissed" && <RestoreFindingButton finding={finding} />}
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

export function ReviewDetailView({ review }: { review: ReviewDetail }) {
  const isAdmin = useCurrentUser().role === "admin";
  const tokensUsed = review.tokensIn + review.tokensOut;
  const budgetShare = review.budget > 0 ? Math.min(100, (tokensUsed / review.budget) * 100) : 0;
  const changeLabel = `${review.repository.provider === "gitlab" ? "!" : "#"}${review.prNumber}`;
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
      <AppHeader
        breadcrumbs={[
          { label: "Reviews", href: "/reviews" },
          {
            label: review.repository.fullPath,
            href: `/repositories/${review.repository.id}/reviews`,
          },
          { label: `Review of ${changeLabel}` },
        ]}
      />
      <main className="detail-main">
        <PageHeader
          title={
            <>
              <span className="text-numeric">{changeLabel}</span> {review.prTitle ?? "Untitled"}
            </>
          }
          meta={
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
            </>
          }
          actions={
            <>
              <Button asChild variant="ghost" className="page-header-ghost">
                <a href={review.prUrl} target="_blank" rel="noreferrer">
                  <IconExternalLink size={14} />
                  Open {review.repository.provider === "gitlab" ? "merge" : "pull"} request
                </a>
              </Button>
              <RerunReviewDialog reviewId={review.id} changeLabel={changeLabel} />
            </>
          }
        />

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
          <Fact label="Profile">{review.profileName ?? <EmptyValue />}</Fact>
          <Fact label="Model">
            {review.model ? (
              <MonoValue value={review.model} className="fact-mono" />
            ) : (
              <EmptyValue />
            )}
          </Fact>
          <Fact label="Harness">
            {review.agent ? (
              isAdmin ? (
                <Link href={`/harnesses/${review.agent.id}`} className="review-link">
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
                {formatTokens(tokensUsed)} of {formatTokens(review.budget)} (
                {Math.round(budgetShare)}%) · {review.tokensIn.toLocaleString()} in ·{" "}
                {review.tokensOut.toLocaleString()} out
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
      </main>
    </>
  );
}
