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
import {
  FindingStatusBadge,
  ReviewStatusBadge,
  SeverityBadge,
  TriggerBadge,
} from "@/components/review-badges";
import { formatDateTime } from "@/lib/format-date";
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

const mono = { fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" } as const;
const stack = { display: "flex", flexDirection: "column", gap: "var(--space-3)" } as const;
const prose: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--text-secondary)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};
const codeBlock: React.CSSProperties = {
  margin: 0,
  padding: "var(--space-3)",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-subtle)",
  background: "var(--bg-raised)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--text-primary)",
  overflowX: "auto",
  whiteSpace: "pre",
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)", minWidth: 0 }}>
      <Muted style={{ fontSize: "var(--text-xs)" }}>{label}</Muted>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--text-primary)", minWidth: 0 }}>
        {children}
      </div>
    </div>
  );
}

function lineRange(f: Pick<FindingView, "startLine" | "endLine">): string {
  return f.startLine === f.endLine ? `L${f.startLine}` : `L${f.startLine}–${f.endLine}`;
}

function FindingItem({ finding }: { finding: FindingView }) {
  return (
    <div
      // Target of the source-finding links on Repository › Rules.
      id={`finding-${finding.id}`}
      style={{
        ...stack,
        padding: "var(--space-4)",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--border-subtle)",
        opacity: finding.status === "open" ? 1 : 0.7,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          flexWrap: "wrap",
        }}
      >
        <SeverityBadge severity={finding.severity} />
        <span style={{ ...mono, color: "var(--text-secondary)" }}>{lineRange(finding)}</span>
        <span
          style={{
            fontSize: "var(--text-sm)",
            fontWeight: "var(--font-weight-semibold)",
            flex: 1,
            minWidth: 0,
          }}
        >
          {finding.title}
        </span>
        <FindingStatusBadge status={finding.status} />
        {finding.status === "open" && <DismissFindingDialog finding={finding} />}
        {finding.status === "dismissed" && <RestoreFindingButton finding={finding} />}
      </div>
      <p style={prose}>{finding.body}</p>
      {finding.suggestion !== null && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
          <Muted style={{ fontSize: "var(--text-xs)" }}>Suggested change</Muted>
          <pre style={codeBlock}>{finding.suggestion}</pre>
        </div>
      )}
      <Muted style={{ fontSize: "var(--text-xs)" }}>
        {finding.category} · confidence {Math.round(finding.confidence * 100)}%
      </Muted>
      {finding.supersededBy && (
        <Muted style={{ fontSize: "var(--text-xs)" }}>
          Superseded by{" "}
          <Link
            href={`/reviews/${finding.supersededBy.reviewId}#finding-${finding.supersededBy.findingId}`}
            style={{ color: "var(--text-accent)", textDecoration: "none" }}
          >
            a finding of a fresh review
          </Link>
          .
        </Muted>
      )}
      <FeedbackHistory feedback={finding.feedback} />
    </div>
  );
}

function FileCard({ file }: { file: FileFindings }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle
          style={{
            ...mono,
            fontSize: "var(--text-sm)",
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            overflowWrap: "anywhere",
          }}
        >
          <IconFileCode size={16} style={{ flexShrink: 0, color: "var(--text-secondary)" }} />
          {file.path}
        </CardTitle>
        <CardDescription>
          {file.findings.length} finding{file.findings.length === 1 ? "" : "s"}
        </CardDescription>
      </CardHeader>
      <CardContent style={stack}>
        {file.findings.map((finding) => (
          <FindingItem key={finding.id} finding={finding} />
        ))}
      </CardContent>
    </Card>
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
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-8)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-6)",
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
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontFamily: "var(--font-mono)" }}>{changeLabel}</span>
              <span>{review.prTitle ?? "Untitled"}</span>
            </h1>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                marginTop: "var(--space-2)",
                flexWrap: "wrap",
              }}
            >
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
                <ProviderIcon provider={review.repository.provider} size={14} />
                {review.repository.fullPath}
              </Link>
              <ReviewStatusBadge status={review.status} />
              <TriggerBadge trigger={review.trigger} />
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--space-2)", flexShrink: 0 }}>
            <Button asChild variant="ghost">
              <a href={review.prUrl} target="_blank" rel="noreferrer">
                <IconExternalLink size={14} />
                Open {review.repository.provider === "gitlab" ? "merge" : "pull"} request
              </a>
            </Button>
            <RerunReviewDialog reviewId={review.id} changeLabel={changeLabel} />
          </div>
        </div>

        {review.status === "failed" && (
          <Alert variant="danger">
            <IconAlertTriangle size={16} />
            <AlertTitle>The review failed</AlertTitle>
            <AlertDescription style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {review.error ?? "No error was recorded."}
            </AlertDescription>
          </Alert>
        )}
        {review.status === "skipped" && review.error && (
          <Alert variant="info">
            <AlertTitle>The review was skipped</AlertTitle>
            <AlertDescription>{review.error}</AlertDescription>
          </Alert>
        )}
        {review.status === "budget_exhausted" && (
          <Alert variant="warning">
            <AlertTitle>Token budget exhausted</AlertTitle>
            <AlertDescription>
              The review stopped at its token cap; the findings below are partial.
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Review</CardTitle>
            <CardDescription>
              Started {formatDateTime(review.createdAt)}
              {active
                ? "; still in progress."
                : `, last updated ${formatDateTime(review.updatedAt)}.`}
            </CardDescription>
          </CardHeader>
          <CardContent style={{ ...stack, gap: "var(--space-6)" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "var(--space-4)",
              }}
            >
              <Fact label="Head SHA">
                <InlineCode title={review.headSha}>{review.headSha.slice(0, 12)}</InlineCode>
              </Fact>
              <Fact label="Base SHA">
                <InlineCode title={review.baseSha}>{review.baseSha.slice(0, 12)}</InlineCode>
              </Fact>
              <Fact label="Profile">{review.profileName ?? "—"}</Fact>
              <Fact label="Model">
                {review.model ? <span style={mono}>{review.model}</span> : "—"}
              </Fact>
              <Fact label="Harness">
                {review.agent ? (
                  isAdmin ? (
                    <Link
                      href={`/harnesses/${review.agent.id}`}
                      style={{ color: "var(--text-accent)", textDecoration: "none" }}
                    >
                      {review.agent.name}
                    </Link>
                  ) : (
                    review.agent.name
                  )
                ) : (
                  <Muted>Not picked up yet</Muted>
                )}
              </Fact>
              <Fact label="Duration">{formatDuration(review.durationMs) ?? "—"}</Fact>
              <Fact label="Stop reason">{review.stopReason ?? <Muted>In progress</Muted>}</Fact>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "var(--space-4)",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontSize: "var(--text-sm)" }}>
                  Tokens: {review.tokensIn.toLocaleString()} in ·{" "}
                  {review.tokensOut.toLocaleString()} out
                </span>
                <span style={{ ...mono, color: "var(--text-secondary)" }}>
                  {formatTokens(tokensUsed)} of {formatTokens(review.budget)} budget (
                  {Math.round(budgetShare)}%)
                </span>
              </div>
              <Progress
                value={budgetShare}
                variant={budgetShare >= 100 ? "danger" : budgetShare >= 80 ? "warning" : "accent"}
                aria-label="Tokens used of the budget"
              />
            </div>
          </CardContent>
        </Card>

        {review.skippedFiles.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Skipped files</CardTitle>
              <CardDescription>
                {review.skippedFiles.length} file
                {review.skippedFiles.length === 1 ? " was" : "s were"} not reviewed.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {review.skippedFiles.map((file) => (
                    <TableRow key={file.path}>
                      <TableCell>
                        <span style={{ ...mono, overflowWrap: "anywhere" }}>{file.path}</span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="neutral">{file.reason.replaceAll("_", " ")}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        <div style={{ ...stack, gap: "var(--space-4)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              flexWrap: "wrap",
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: "var(--text-lg)",
                fontWeight: "var(--font-weight-semibold)",
              }}
            >
              Findings ({review.findingCount})
            </h2>
            {severityCounts.map(({ severity, count }) => (
              <SeverityBadge key={severity} severity={severity} count={count} />
            ))}
          </div>
          {review.files.length === 0 ? (
            <Card>
              <CardContent>
                <Empty
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
              </CardContent>
            </Card>
          ) : (
            review.files.map((file) => <FileCard key={file.path} file={file} />)
          )}
        </div>
      </main>
    </>
  );
}
