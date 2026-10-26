"use client";

import { Button, ProgressCard, type HeadingLevel } from "@omniralph/ui";
import type { RunDetail } from "@/lib/api/runs";
import { runHref } from "@/lib/runs/hrefs";
import { progressTitle, stepsToProgress } from "./progress";

export type RunProgressProps = {
  run: Pick<RunDetail, "id" | "kind" | "steps">;
  headingLevel?: HeadingLevel;
  className?: string;
} & (
  | {
      /** In the Inbox: the card links to the run ("Open run"). */
      mode: "link";
    }
  | {
      /** In the run detail: the steps are buttons, and the selected one is marked. */
      mode: "select";
      selectedStepId: string | undefined;
      onSelectStep: (stepId: string) => void;
    }
);

/**
 * A run's progress card (Design rule 10) from its detail: its steps' states and durations,
 * titled by kind ("Stories", "Review passes", "Turns"; an epic in the Inbox is "Epic
 * progress"). In `link` mode it carries an "Open run" link; in `select` mode the steps are
 * selectable.
 */
export function RunProgress(props: RunProgressProps) {
  const { run, headingLevel, className } = props;
  const { steps, summarySuffix } = stepsToProgress(run.steps);
  return (
    <ProgressCard
      className={className}
      title={progressTitle(run.kind, props.mode)}
      headingLevel={headingLevel}
      steps={steps}
      summarySuffix={summarySuffix}
      actions={
        props.mode === "link" ? (
          <Button variant="ghost" size="sm" href={runHref(run.id)}>
            Open run
          </Button>
        ) : undefined
      }
      selectedStepId={props.mode === "select" ? props.selectedStepId : undefined}
      onSelectStep={props.mode === "select" ? props.onSelectStep : undefined}
    />
  );
}
