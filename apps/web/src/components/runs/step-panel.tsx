"use client";

import {
  Button,
  TabPanel,
  Tabs,
  toast,
  Toolbar,
  Transcript,
  type MenuItem,
  type ToolbarAction,
} from "@omniralph/ui";
import { IconGitCommit, IconLink, IconRotateClockwise2 } from "@tabler/icons-react";
import { useEffect, useState, type ReactNode } from "react";
import type { RunAttempt, RunDetail, RunStep } from "@/lib/api/runs";
import { AttemptList } from "./attempt-list";
import { AttemptOutcome } from "./attempt-outcome";
import { LoadError } from "./load-error";
import {
  isFailedAttempt,
  isLiveAttempt,
  lastFeedback,
  moreEvents,
  selectedAttempt,
  selectedTab,
  STEP_PANEL_ATTEMPTS,
  STEP_PANEL_TRANSCRIPT,
  stepAttempts,
  stepRetry,
  TRANSCRIPT_PREVIEW_EVENTS,
} from "./step-attempts";
import { useAttemptTranscript } from "./use-attempt-transcript";
import { useRunRetry, useRunRetryPending } from "./use-run-actions";
import "./step-panel.css";

/** A tab other screens add to the step panel (the story's Diff, a review pass's Findings). */
export interface StepPanelTab {
  /** Its `?tab=` value, e.g. "diff". */
  value: string;
  label: string;
  count?: number;
  content: ReactNode;
}

/** What the step panel shows, as its URL says it (`?tab=&attempt=`). */
export interface StepPanelState {
  tab?: string;
  attempt?: string;
}

export interface StepPanelProps {
  run: RunDetail;
  step: RunStep;
  /** `?tab=`: Transcript when absent or unknown. */
  tab: string | null;
  /** `?attempt=`: the step's latest attempt when absent or not the step's. */
  attemptId: string | null;
  /** Puts the chosen tab or attempt in the URL. */
  onNavigate: (next: StepPanelState) => void;
  /** The step's URL, for Copy link. */
  stepHref: string;
  /** Tabs between Transcript and Attempts, in order. */
  tabs?: readonly StepPanelTab[];
}

async function copy(text: string, done: string, failed: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast(failed, { variant: "danger" });
  }
}

/** The shown attempt's transcript: its first events, then "{n} more events · Show all". */
function AttemptTranscriptView({ runId, attempt }: { runId: string; attempt: RunAttempt }) {
  const live = isLiveAttempt(attempt);
  const transcript = useAttemptTranscript(runId, attempt.id, live);
  const [expanded, setExpanded] = useState(false);
  const { data, loadMore, loadingMore, loadMoreFailed } = transcript;

  // "Show all" loads the rest a page at a time.
  const nextCursor = data?.nextCursor ?? null;
  useEffect(() => {
    if (expanded && nextCursor && !loadingMore && !loadMoreFailed) void loadMore();
  }, [expanded, nextCursor, loadingMore, loadMoreFailed, loadMore]);

  if (transcript.isPending) {
    return (
      <div className="or-step-panel__loading" aria-busy="true" data-testid="transcript-skeleton">
        <div className="or-run-skeleton__line" />
        <div className="or-run-skeleton__line or-run-skeleton__line--short" />
      </div>
    );
  }
  if (transcript.isError) {
    return (
      <LoadError
        what="transcript"
        error={transcript.error}
        reloading={transcript.isFetching}
        onReload={() => void transcript.refetch()}
      />
    );
  }

  const { events } = transcript.data;
  const shown = expanded ? events : events.slice(0, TRANSCRIPT_PREVIEW_EVENTS);
  const total = Math.max(attempt.transcriptEvents, events.length);
  const hidden = total - shown.length;
  const error = isFailedAttempt(attempt) ? attempt.error : null;

  let more: ReactNode = null;
  if (!expanded && hidden > 0) {
    more = (
      <p className="or-transcript__more">
        <span>{moreEvents(hidden)} · </span>
        <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
          Show all
        </Button>
      </p>
    );
  } else if (expanded && loadMoreFailed) {
    more = (
      <p className="or-run-error" role="alert">
        Couldn&apos;t load the rest of the transcript.
        <Button variant="outline" size="sm" onClick={() => void loadMore()}>
          Load the rest
        </Button>
      </p>
    );
  } else if (expanded && nextCursor) {
    more = (
      <p className="or-transcript__more" role="status">
        Loading {moreEvents(Math.max(hidden, 1))}…
      </p>
    );
  }

  if (events.length === 0 && !error) {
    return (
      <p className="or-step-panel__empty">
        {live ? "Om hasn't reported anything yet." : "Nothing was recorded for this attempt."}
      </p>
    );
  }
  return (
    <Transcript
      events={shown}
      startedAt={attempt.startedAt ?? attempt.createdAt}
      error={error}
      more={more}
    />
  );
}

/**
 * The selected step's panel, inside the progress card under the step (Design board Runs):
 * a toolbar with the step's retry ("Retry story", "Re-run story" or "Retry attempt", from its
 * state and the run's `actions`) and a ⋯ menu (Copy link, Copy commit), then tabs:
 * Transcript (the shown attempt's, `?attempt=` or the latest; a failed attempt's outcome and
 * a story's last feedback above it), the `tabs` other screens add, and "Attempts {n}". The
 * tab lives in the URL (`?tab=`).
 */
export function StepPanel({
  run,
  step,
  tab,
  attemptId,
  onNavigate,
  stepHref,
  tabs = [],
}: StepPanelProps) {
  const attempts = stepAttempts(run, step);
  const attempt = selectedAttempt(attempts, attemptId);
  const retry = useRunRetry(run.id);
  const retrying = useRunRetryPending(run.id);

  const panelTabs = [
    { value: STEP_PANEL_TRANSCRIPT, label: "Transcript" },
    ...tabs.map(({ value, label, count }) => ({ value, label, count })),
    { value: STEP_PANEL_ATTEMPTS, label: "Attempts", count: attempts.length },
  ];
  const current = selectedTab(
    panelTabs.map((item) => item.value),
    tab,
  );

  const retryItem = stepRetry(run, step, attempt);
  const actions: [] | [ToolbarAction] = retryItem
    ? [
        {
          label: retryItem.label,
          // Not the run's Retry icon: a story or attempt retry is a different action.
          icon: IconRotateClockwise2,
          disabled: retrying,
          onSelect: () => retry.mutate({ target: retryItem.target, selectedStepId: step.id }),
        },
      ]
    : [];
  const menu: MenuItem[] = [
    {
      label: "Copy link",
      icon: IconLink,
      onSelect: () =>
        void copy(
          new URL(stepHref, window.location.origin).href,
          "Link copied",
          "Couldn't copy the link.",
        ),
    },
  ];
  if (step.kind === "story" && step.commit) {
    const commit = step.commit;
    menu.push({
      label: "Copy commit",
      icon: IconGitCommit,
      onSelect: () => void copy(commit, "Commit copied", "Couldn't copy the commit."),
    });
  }
  const feedback = lastFeedback(step, attempts);

  return (
    <section className="or-step-panel" aria-label="Selected step">
      <div className="or-step-panel__head">
        <Toolbar label="Step actions" actions={actions} menu={menu} />
      </div>
      <Tabs
        tabs={panelTabs}
        value={current}
        onValueChange={(value) => onNavigate({ tab: value })}
        aria-label="Step views"
        className="or-step-panel__tabs"
      >
        <TabPanel value={STEP_PANEL_TRANSCRIPT}>
          {feedback ? (
            <div className="or-step-panel__feedback">
              <h4 className="or-step-panel__subtitle">Last feedback</h4>
              <p>{feedback}</p>
            </div>
          ) : null}
          {attempt ? (
            <>
              {isFailedAttempt(attempt) ? (
                <AttemptOutcome
                  className="or-step-panel__outcome"
                  attempt={{ ...attempt, error: null }}
                />
              ) : null}
              <AttemptTranscriptView key={attempt.id} runId={run.id} attempt={attempt} />
            </>
          ) : (
            <p className="or-step-panel__empty">No attempts yet.</p>
          )}
        </TabPanel>
        {tabs.map((extra) => (
          <TabPanel key={extra.value} value={extra.value}>
            {extra.content}
          </TabPanel>
        ))}
        <TabPanel value={STEP_PANEL_ATTEMPTS}>
          <AttemptList
            runId={run.id}
            attempts={attempts}
            selectedAttemptId={attempt?.id}
            onSelect={(id) => onNavigate({ attempt: id, tab: STEP_PANEL_TRANSCRIPT })}
          />
        </TabPanel>
      </Tabs>
    </section>
  );
}
