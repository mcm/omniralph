"use client";

import { IconCheck, IconChevronRight, IconLock, IconMinus, IconX } from "@tabler/icons-react";
import { useId, type ReactNode } from "react";
import { useLinkComponent } from "../provider/index.js";
import { StatusDot, type StatusTone } from "../status/index.js";
import { Card, type HeadingLevel } from "./card.js";
import {
  STEP_STATE_LABELS,
  progressSummary,
  type ProgressStep,
  type StepState,
} from "./progress.js";

/** Steps shown by their status dot: the states whose color is a status of its own. */
const STEP_TONES: Partial<Record<StepState, StatusTone>> = {
  waiting: "need",
  running: "run",
};

/**
 * The other states each have their own shape, so none is told apart by color alone (WCAG
 * 1.4.1): done a check, failed a cross, blocked a lock, canceled a dash, pending a ring.
 */
const STEP_ICONS: Partial<Record<StepState, typeof IconCheck>> = {
  done: IconCheck,
  failed: IconX,
  blocked: IconLock,
  canceled: IconMinus,
};

export interface ProgressCardProps {
  title: string;
  /** Makes the title a link (e.g. to the run or PRD the steps belong to). */
  titleHref?: string;
  headingLevel?: HeadingLevel;
  /** Actions aligned to the right of the header (e.g. an "Open run" link). */
  actions?: ReactNode;
  steps: readonly ProgressStep[];
  /** Appended to the count line, e.g. the run's total duration ("3h 31m"). */
  summarySuffix?: string;
  /** With `onSelectStep`, the steps render as buttons and this one is marked current. */
  selectedStepId?: string;
  /** Makes the steps selectable: each renders as a button that calls this with its ID. */
  onSelectStep?: (stepId: string) => void;
  /** With `onSelectStep`, shown inside the selected step, under it (e.g. its transcript). */
  stepPanel?: ReactNode;
  /**
   * With `onSelectStep`, each step also gets a chevron link to its own view (`.or-step__open`,
   * named "Open {label}"), beside its button. The chevrons show only at phone width (768 px
   * and narrower), where the inline `stepPanel` is hidden instead.
   */
  stepHref?: (stepId: string) => string;
  className?: string;
}

function StepIcon({ state }: { state: StepState }) {
  const label = STEP_STATE_LABELS[state];
  const tone = STEP_TONES[state];
  if (tone !== undefined) return <StatusDot tone={tone} label={label} />;
  const Icon = STEP_ICONS[state];
  return (
    <span className={`or-step__icon or-step__icon--${state}`} role="img" aria-label={label}>
      {Icon ? <Icon size={12} stroke={2.25} aria-hidden="true" /> : null}
    </span>
  );
}

/**
 * The one progress view (Design rule 10): a bar with one segment per step, a one-line
 * count and the steps as an ordered list. With `onSelectStep` the steps are buttons and the
 * selected one is bold with `aria-current`, with `stepPanel` under it.
 */
export function ProgressCard({
  title,
  titleHref,
  headingLevel,
  actions,
  steps,
  summarySuffix,
  selectedStepId,
  onSelectStep,
  stepPanel,
  stepHref,
  className,
}: ProgressCardProps) {
  const LinkComponent = useLinkComponent();
  const titleId = useId();
  const summary = progressSummary(steps, summarySuffix);
  const done = steps.filter((step) => step.state === "done").length;
  const width = steps.length > 0 ? `${100 / steps.length}%` : undefined;
  const stepLinks = onSelectStep !== undefined && stepHref !== undefined;

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
      actions={actions}
      className={[
        "or-progress-card",
        stepLinks ? "or-progress-card--step-links" : undefined,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
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
          {steps.map((step) => {
            const selected = onSelectStep !== undefined && step.id === selectedStepId;
            const content = (
              <>
                <StepIcon state={step.state} />
                <span className="or-step__label">
                  {onSelectStep === undefined && step.href !== undefined ? (
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
              </>
            );
            return (
              <li
                key={step.id}
                className={[
                  "or-step",
                  `or-step--${step.state}`,
                  selected ? "or-step--selected" : undefined,
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {onSelectStep !== undefined ? (
                  <button
                    type="button"
                    className="or-step__button"
                    aria-current={selected ? "step" : undefined}
                    onClick={() => onSelectStep(step.id)}
                  >
                    {content}
                  </button>
                ) : (
                  content
                )}
                {stepLinks ? (
                  <LinkComponent
                    href={stepHref(step.id)}
                    className="or-step__open"
                    aria-label={`Open ${step.label}`}
                  >
                    <IconChevronRight size={16} stroke={1.75} aria-hidden="true" />
                  </LinkComponent>
                ) : null}
                {selected && stepPanel !== undefined ? (
                  <div className="or-step__panel">{stepPanel}</div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </Card>
  );
}
