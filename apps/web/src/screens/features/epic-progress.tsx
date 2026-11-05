"use client";

import { Button, ChangeBadge, EmptyState, MetaBadge, StatusText, TextLink } from "@omniralph/ui";
import { useId } from "react";
import { RUN_STATUS_LABELS, RUN_STATUS_TONES } from "@/components/runs/run-status";
import { WORK_ITEM_STATE_TONES } from "@/components/work-items/state-tones";
import { workItemHref } from "@/components/work-items/work-item-links";
import type { FeatureEpicProgress, FeatureRollup, FeatureRow } from "@/lib/api/features";
import { runHref } from "@/lib/runs/links";
import { useFeatureProgress } from "./queries";

export const PROGRESS_TITLE = "Progress";
export const NO_EPICS_YET = "No epics yet";
export const NO_EPICS_HINT =
  "Shard the Plan into epics: each filed epic shows here with its run and PR.";
export const PROGRESS_LOAD_FAILED = "Couldn't load the progress";
export const LOADING_PROGRESS = "Loading the progress…";
export const NOT_RUN = "Not run yet";
export const STATE_UNKNOWN = "State unknown";
export const UNKNOWN_EPIC = "Unknown epic";

const PULL_REQUEST_STATES: Record<FeatureEpicProgress["pullRequests"][number]["state"], string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed without merging",
};

/** "2 of 5 epics done". */
export function epicsDone(rollup: Pick<FeatureRollup, "epicsDone" | "epicsTotal">): string {
  return `${rollup.epicsDone} of ${rollup.epicsTotal} ${rollup.epicsTotal === 1 ? "epic" : "epics"} done`;
}

/** "7 of 20 stories done", "No stories yet". */
export function storiesDone(done: number, total: number): string {
  if (total === 0) return "No stories yet";
  return `${done} of ${total} ${total === 1 ? "story" : "stories"} done`;
}

/** The roll-up as one line: "2 of 5 epics done · 7 of 20 stories done". */
export function rollupLabel(rollup: FeatureRollup): string {
  return `${epicsDone(rollup)} · ${storiesDone(rollup.storiesDone, rollup.storiesTotal)}`;
}

/** A bar filled to `done` of `total` (decorative: its numbers are said in text beside it). */
function DoneBar({ done, total }: { done: number; total: number }) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <span className="or-feature-progress__bar" aria-hidden="true">
      <span className="or-feature-progress__fill" style={{ width: `${percent}%` }} />
    </span>
  );
}

/**
 * A feature's roll-up in the Features list: epics done of all, and stories done of all. Only
 * for a feature with epics (it reads the tracker); a badge while it loads or can't.
 */
export function FeatureRollupBadge({ feature }: { feature: Pick<FeatureRow, "id" | "epicCount"> }) {
  const progress = useFeatureProgress(feature.id, feature.epicCount > 0);
  if (feature.epicCount === 0 || !progress.data) return null;
  return <MetaBadge text={rollupLabel(progress.data.rollup)} />;
}

/**
 * A feature's progress on its page: the roll-up (epics and stories done of all, with a bar),
 * then one row per epic in filing order with its state in the tracker, its stories, its
 * latest run (linking to it) and that run's PRs. A live query.
 */
export function FeatureEpicsPanel({ feature }: { feature: Pick<FeatureRow, "id"> }) {
  const headingId = useId();
  const query = useFeatureProgress(feature.id);
  const progress = query.data;

  let body;
  if (query.isError && !progress) {
    body = (
      <EmptyState
        headingLevel={4}
        title={PROGRESS_LOAD_FAILED}
        description={query.error.message}
        action={
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      />
    );
  } else if (!progress) {
    body = (
      <div role="status" data-testid="feature-progress-skeleton">
        <span className="or-sr-only">{LOADING_PROGRESS}</span>
        <div aria-hidden="true" className="or-feature-skeleton__row" />
      </div>
    );
  } else if (progress.epics.length === 0) {
    body = <EmptyState headingLevel={4} title={NO_EPICS_YET} description={NO_EPICS_HINT} />;
  } else {
    const { rollup } = progress;
    body = (
      <>
        <div className="or-feature-progress__rollup">
          <div className="or-feature-progress__count">
            <span>{epicsDone(rollup)}</span>
            <DoneBar done={rollup.epicsDone} total={rollup.epicsTotal} />
          </div>
          <div className="or-feature-progress__count">
            <span>{storiesDone(rollup.storiesDone, rollup.storiesTotal)}</span>
            <DoneBar done={rollup.storiesDone} total={rollup.storiesTotal} />
          </div>
        </div>
        {progress.trackerProblem ? (
          <p className="or-feature__note" role="status">
            {progress.trackerProblem}
          </p>
        ) : null}
        <ul className="or-feature-progress__epics" aria-label="Epics">
          {progress.epics.map((epic) => (
            <EpicRow key={epic.workItemId} epic={epic} />
          ))}
        </ul>
      </>
    );
  }

  return (
    <section className="or-feature-progress" aria-labelledby={headingId}>
      <h3 id={headingId} className="or-feature__section-title">
        {PROGRESS_TITLE}
      </h3>
      {body}
    </section>
  );
}

/** One epic: identifier and title (its work item page), state, stories, run and PRs. */
function EpicRow({ epic }: { epic: FeatureEpicProgress }) {
  const name = epic.title ?? UNKNOWN_EPIC;
  return (
    <li className="or-feature-epic" aria-label={epic.identifier ?? name}>
      <div className="or-feature-epic__line">
        {epic.identifier ? (
          <span className="or-feature-epic__identifier or-mono">{epic.identifier}</span>
        ) : null}
        <TextLink href={workItemHref(epic.workItemId)} className="or-feature-epic__title">
          {name}
        </TextLink>
        {epic.state ? (
          <StatusText
            tone={WORK_ITEM_STATE_TONES[epic.state.category]}
            className="or-feature-epic__state"
          >
            {epic.state.name}
          </StatusText>
        ) : (
          <StatusText tone="neutral" className="or-feature-epic__state">
            {STATE_UNKNOWN}
          </StatusText>
        )}
      </div>
      <div className="or-feature-epic__meta">
        {epic.stories ? (
          <span className="or-feature-epic__stories">
            {storiesDone(epic.stories.done, epic.stories.total)}
          </span>
        ) : null}
        {epic.run ? (
          <TextLink href={runHref(epic.run.id)} className="or-feature-epic__run">
            <StatusText tone={RUN_STATUS_TONES[epic.run.status]}>
              Run {RUN_STATUS_LABELS[epic.run.status].toLowerCase()}
            </StatusText>
          </TextLink>
        ) : (
          <span className="or-feature-epic__run">{NOT_RUN}</span>
        )}
        {epic.pullRequests.map((pullRequest) => (
          <span key={pullRequest.url} className="or-feature-epic__pr">
            <ChangeBadge
              host={pullRequest.host}
              number={pullRequest.number}
              href={pullRequest.url}
            />
            <span className="or-feature-epic__pr-state">
              {PULL_REQUEST_STATES[pullRequest.state]}
            </span>
          </span>
        ))}
      </div>
    </li>
  );
}
