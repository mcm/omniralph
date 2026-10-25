"use client";

import { useId } from "react";
import { useLinkComponent } from "../provider/index.js";
import { StatusDot, type StatusTone } from "../status/index.js";
import { Card, type HeadingLevel } from "./card.js";
import {
  STEP_STATE_LABELS,
  progressSummary,
  type ProgressStep,
  type StepState,
} from "./progress.js";

const STEP_TONES: Record<StepState, StatusTone> = {
  done: "neutral",
  waiting: "need",
  running: "run",
  failed: "fail",
  blocked: "neutral",
  pending: "neutral",
};

export interface ProgressCardProps {
  title: string;
  /** Makes the title a link (e.g. to the run or PRD the steps belong to). */
  titleHref?: string;
  headingLevel?: HeadingLevel;
  steps: readonly ProgressStep[];
  className?: string;
}

/**
 * The one progress view (Design rule 10): a bar with one segment per step, a one-line
 * count and the steps as an ordered list.
 */
export function ProgressCard({
  title,
  titleHref,
  headingLevel,
  steps,
  className,
}: ProgressCardProps) {
  const LinkComponent = useLinkComponent();
  const titleId = useId();
  const summary = progressSummary(steps);
  const done = steps.filter((step) => step.state === "done").length;
  const width = steps.length > 0 ? `${100 / steps.length}%` : undefined;

  return (
    <Card
      title={
        titleHref !== undefined ? (
          <LinkComponent href={titleHref} className="or-card__title-link">
            {title}
          </LinkComponent>
        ) : (
          title
        )
      }
      titleId={titleId}
      headingLevel={headingLevel}
      className={["or-progress-card", className].filter(Boolean).join(" ")}
    >
      <div
        className="or-progress"
        role="progressbar"
        aria-labelledby={titleId}
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
        aria-valuetext={summary}
      >
        {steps.map((step) => (
          <span
            key={step.id}
            className={`or-progress__seg or-progress__seg--${step.state}`}
            style={{ width }}
          />
        ))}
      </div>
      <p className="or-progress__count" aria-hidden="true">
        {summary}
      </p>
      {steps.length > 0 ? (
        <ol className="or-steps">
          {steps.map((step) => (
            <li key={step.id} className={`or-step or-step--${step.state}`}>
              <StatusDot tone={STEP_TONES[step.state]} label={STEP_STATE_LABELS[step.state]} />
              <span className="or-step__label">
                {step.href !== undefined ? (
                  <LinkComponent href={step.href} className="or-step__link">
                    {step.label}
                  </LinkComponent>
                ) : (
                  step.label
                )}
              </span>
              {step.meta !== undefined ? (
                <span className="or-step__meta or-mono">{step.meta}</span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </Card>
  );
}
