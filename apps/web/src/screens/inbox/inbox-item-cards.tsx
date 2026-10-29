"use client";

import { Button, Card, StatusText } from "@omniralph/ui";
import { AttemptOutcome } from "@/components/runs/attempt-outcome";
import { progressTitle } from "@/components/runs/progress";
import { RunActivity } from "@/components/runs/run-activity";
import { RunProgress } from "@/components/runs/run-progress";
import { RUN_STATUS_LABELS, RUN_STATUS_TONES } from "@/components/runs/run-status";
import { useRunDetail } from "@/components/runs/use-run-detail";
import type { InboxItem } from "@/lib/api/inbox";
import type { RunDetail } from "@/lib/api/runs";
import { runHref } from "@/lib/runs/hrefs";
import { isGitLab } from "./labels";

/** The failed load of an item's run. */
export const RUN_LOAD_FAILED = "Couldn't load this run.";

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

/** Open findings by severity, most severe first: "1 critical · 2 high", or "No open findings". */
export function openFindingsText(counts: NonNullable<InboxItem["review"]>["openFindings"]): string {
  const parts = SEVERITIES.filter((severity) => counts[severity] > 0).map(
    (severity) => `${counts[severity]} ${severity}`,
  );
  return parts.length > 0 ? parts.join(" · ") : "No open findings";
}

/** A ready PR/MR's AI review: its status, its open findings and a link to the review run. */
function AiReviewCard({ item }: { item: InboxItem }) {
  const { review } = item;
  const name = isGitLab(item) ? "merge request" : "pull request";
  return (
    <Card
      title="Om's review"
      headingLevel={3}
      actions={
        review ? (
          <Button variant="ghost" size="sm" href={runHref(review.runId)}>
            Open review
          </Button>
        ) : undefined
      }
    >
      {review ? (
        <div className="or-inbox-card__facts">
          <StatusText tone={RUN_STATUS_TONES[review.status]}>
            {RUN_STATUS_LABELS[review.status]}
          </StatusText>
          <p className="or-inbox-card__text">{openFindingsText(review.openFindings)}</p>
        </div>
      ) : (
        <p className="or-inbox-card__text">{`Om hasn't reviewed this ${name} yet.`}</p>
      )}
    </Card>
  );
}

/** A failed run's cause: its last failed attempt (attempts are newest first). */
function FailedRunCause({ run }: { run: RunDetail }) {
  const attempt = run.attempts.find((a) => a.status === "failed") ?? {
    status: "failed" as const,
    label: "The run failed",
    error: run.details.error,
  };
  return (
    <Card title="What went wrong" headingLevel={3}>
      <AttemptOutcome attempt={attempt} />
    </Card>
  );
}

/** A card-shaped placeholder while the run loads. */
function SkeletonCard({ title }: { title: string }) {
  return (
    <Card title={title} headingLevel={3} className="or-inbox-card--loading">
      <div className="or-run-skeleton" aria-hidden="true" data-testid="run-skeleton">
        <div className="or-run-skeleton__line or-run-skeleton__line--bar" />
        <div className="or-run-skeleton__line" />
        <div className="or-run-skeleton__line or-run-skeleton__line--short" />
      </div>
    </Card>
  );
}

/** The cards of an item with a run: they read the run's detail (a live query). */
function RunCards({ item, run }: { item: InboxItem; run: NonNullable<InboxItem["run"]> }) {
  const detail = useRunDetail(run.id);
  const review = item.kind === "pr_waiting" ? <AiReviewCard item={item} /> : null;

  if (detail.isPending) {
    return (
      <div className="or-inbox-cards" aria-busy="true">
        <SkeletonCard title={progressTitle(run.kind, "link")} />
        {review}
        {item.kind === "failed_run" ? <SkeletonCard title="What went wrong" /> : null}
        <SkeletonCard title="Activity" />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="or-inbox-cards">
        {review}
        <p className="or-run-error" role="alert">
          {RUN_LOAD_FAILED}
          <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
            Retry
          </Button>
        </p>
      </div>
    );
  }
  return (
    <div className="or-inbox-cards">
      <RunProgress run={detail.data} mode="link" headingLevel={3} />
      {review}
      {item.kind === "failed_run" ? <FailedRunCause run={detail.data} /> : null}
      <RunActivity run={detail.data} reason={item.reason} headingLevel={3} />
    </div>
  );
}

/**
 * Why the item is here, beyond its reason (Design rules 8 and 10): an item with a run shows
 * the run's progress card ("Open run"), a ready PR/MR its AI review, a failed run what went
 * wrong, and the run's activity; failed system work shows its attempt and the reason.
 */
export function InboxItemCards({ item }: { item: InboxItem }) {
  if (item.run) return <RunCards key={item.run.id} item={item} run={item.run} />;
  if (item.kind === "failed_system") {
    return (
      <div className="or-inbox-cards">
        <Card title="What went wrong" headingLevel={3}>
          <AttemptOutcome attempt={{ status: "failed", label: item.title, error: item.reason }} />
        </Card>
      </div>
    );
  }
  return null;
}
