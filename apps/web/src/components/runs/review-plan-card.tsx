"use client";

import { Card, DetailsSection, StatusDot, type HeadingLevel } from "@omniralph/ui";
import type { RunDetail } from "@/lib/api/runs";
import {
  checkState,
  currentPassText,
  filesText,
  passCounts,
  REVIEW_CHECK_LABELS,
  reviewCheckSteps,
  reviewPlanTotals,
  totalsText,
  type ReviewCheckStep,
} from "./review-plan";
import "./loop-views.css";
import "./review-plan.css";

function CheckFiles({ step }: { step: ReviewCheckStep }) {
  const { files } = step.check;
  if (files.length === 0) {
    return (
      <p className="or-verdict__text">
        {step.status === "queued" || step.status === "running"
          ? "Its files show when its first pass finishes."
          : "No files."}
      </p>
    );
  }
  return (
    <DetailsSection title={filesText(files.length)} className="or-review-plan__files">
      <ul className="or-review-plan__paths">
        {files.map((path) => (
          <li key={path} className="or-mono">
            {path}
          </li>
        ))}
      </ul>
    </DetailsSection>
  );
}

function CheckType({ step }: { step: ReviewCheckStep }) {
  const { check } = step;
  const label = REVIEW_CHECK_LABELS[check.type];
  const state = checkState(step.status);
  const showError = check.error && (step.status === "failed" || step.status === "skipped");
  return (
    <li className="or-verdict__item" aria-label={label}>
      <StatusDot tone={state.tone} label={state.text} />
      <div className="or-verdict__body">
        <p className="or-verdict__name">
          {label}
          <span className="or-verdict__state">{state.text}</span>
        </p>
        <CheckFiles step={step} />
        {check.passes.length > 0 || check.current ? (
          <ol className="or-review-plan__passes" aria-label={`${label} passes`}>
            {check.passes.map((pass) => (
              <li key={pass.number} className="or-review-plan__pass">
                <span className="or-review-plan__pass-name">Pass {pass.number}</span>
                <span>{passCounts(pass)}</span>
                {pass.verification === "unverified" ? (
                  <span className="or-review-plan__note">
                    Not verified: the verifier failed, so its findings were kept.
                  </span>
                ) : null}
              </li>
            ))}
            {check.current && !check.passes.some((p) => p.number === check.current!.number) ? (
              <li className="or-review-plan__pass">
                <span className="or-review-plan__pass-name">Pass {check.current.number}</span>
                <span>{currentPassText(check.current)}</span>
              </li>
            ) : null}
          </ol>
        ) : null}
        {showError ? <p className="or-verdict__text">{check.error}</p> : null}
      </div>
    </li>
  );
}

export interface ReviewPlanCardProps {
  run: Pick<RunDetail, "kind" | "steps">;
  headingLevel?: HeadingLevel;
}

/**
 * A looped review's Plan: the review's totals (findings verification confirmed and dropped),
 * then each check type with its state, its files (expandable to their paths), its passes in
 * order (new, confirmed and dropped findings), the pass running now and why it failed.
 * Nothing for a single-pass review or another kind of run.
 */
export function ReviewPlanCard({ run, headingLevel = 3 }: ReviewPlanCardProps) {
  if (run.kind !== "review") return null;
  const steps = reviewCheckSteps(run.steps);
  if (steps.length === 0) return null;
  return (
    <Card title="Plan" headingLevel={headingLevel} className="or-review-plan">
      <p className="or-review-plan__totals">{totalsText(reviewPlanTotals(steps))}</p>
      <ul className="or-verdict__items" aria-label="Check types">
        {steps.map((step) => (
          <CheckType key={step.id} step={step} />
        ))}
      </ul>
    </Card>
  );
}
