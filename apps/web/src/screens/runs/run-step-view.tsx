"use client";

import { Button, EmptyState, StatusLine, TextLink } from "@omniralph/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef } from "react";
import { stepStatusLine } from "@/components/runs/progress";
import { epicAuditTabs } from "@/components/runs/epic-audit";
import { reviewFindingsTabs } from "@/components/runs/review-findings";
import { StepPanel } from "@/components/runs/step-panel";
import { storyContentTabs } from "@/components/runs/story-content";
import { storyDiffTabs } from "@/components/runs/story-diff";
import { useRunDetail } from "@/components/runs/use-run-detail";
import { ApiError } from "@/lib/api/client";
import type { RunDetail } from "@/lib/api/runs";
import { useShortcut } from "@/lib/shortcuts";
import {
  NO_RUN_FILTERS,
  parseRunFilters,
  runFiltersHref,
  runInListHref,
  runStepHref,
} from "./filters";
import { RUN_DETAIL_FAILED, RUN_NOT_FOUND } from "./run-detail-view";
import "@/components/runs/run-cards.css";
import "./run-step.css";

/** Shown for a step the run doesn't have. */
export const STEP_NOT_FOUND = "This run has no such step.";

export interface RunStepViewProps {
  runId: string;
  stepId: string;
}

/** "‹ {label}" back to the run (or Runs); Back (`u`) follows it as a click does. */
function BackLink({ href, label }: { href: string; label: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  useShortcut("back", () => ref.current?.click());
  return (
    <TextLink ref={ref} href={href} className="or-run-step__back">
      <span aria-hidden="true">‹ </span>
      {label}
    </TextLink>
  );
}

function RunStepContent({ run, stepId }: { run: RunDetail; stepId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filters = parseRunFilters(searchParams);
  const step = run.steps.find((candidate) => candidate.id === stepId);
  const back = runInListHref(run.id, filters, step ? { step: step.id } : {});

  if (!step) {
    return (
      <div className="or-run-step">
        <BackLink href={back} label={run.title} />
        <EmptyState title={STEP_NOT_FOUND} />
      </div>
    );
  }

  const status = stepStatusLine(step);
  return (
    <article className="or-run-step" aria-label={run.title}>
      <BackLink href={back} label={run.title} />
      <StatusLine tone={status.tone} dotLabel={status.state}>
        {status.text}
      </StatusLine>
      <StepPanel
        run={run}
        step={step}
        tab={searchParams.get("tab")}
        attemptId={searchParams.get("attempt")}
        onNavigate={(next) =>
          router.replace(
            runStepHref(run.id, step.id, filters, {
              attempt: next.attempt ?? searchParams.get("attempt"),
              tab: next.tab ?? searchParams.get("tab"),
            }),
            { scroll: false },
          )
        }
        stepHref={runInListHref(run.id, NO_RUN_FILTERS, { step: step.id })}
        tabs={[
          ...epicAuditTabs(run, step),
          ...storyContentTabs(run, step),
          ...storyDiffTabs(run, step),
          ...reviewFindingsTabs(run, step),
        ]}
      />
    </article>
  );
}

/**
 * A step of a run as its own view (Design board MobileRun, rule 16): "‹ {run title}" back to
 * the run, the step's name and state in a `StatusLine`, and the shared `StepPanel` (tabs,
 * transcript, attempts, retry) at full width, at every viewport. The phone run detail links
 * here from each step's chevron. A live query: the run's change events refetch it.
 */
export function RunStepView({ runId, stepId }: RunStepViewProps) {
  const searchParams = useSearchParams();
  const detail = useRunDetail(runId);
  if (detail.isPending) {
    return (
      <div className="or-run-step" aria-busy="true" data-testid="run-step-skeleton">
        <div className="or-run-skeleton" aria-hidden="true">
          <div className="or-run-skeleton__line or-run-skeleton__line--short" />
          <div className="or-run-skeleton__line" />
          <div className="or-run-skeleton__line" />
        </div>
      </div>
    );
  }
  if (detail.isError) {
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return (
        <div className="or-run-step">
          <BackLink href={runFiltersHref(parseRunFilters(searchParams))} label="Runs" />
          <EmptyState title={RUN_NOT_FOUND} />
        </div>
      );
    }
    return (
      <div className="or-run-step">
        <p className="or-run-error" role="alert">
          {RUN_DETAIL_FAILED}
          <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
            Retry
          </Button>
        </p>
      </div>
    );
  }
  return <RunStepContent run={detail.data} stepId={stepId} />;
}
