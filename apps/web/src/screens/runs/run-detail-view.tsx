"use client";

import {
  Button,
  ConfirmDialog,
  EmptyState,
  IssueBadge,
  MetaBadge,
  OrgBadge,
  RepoBadge,
  StatusLine,
  toast,
  Toolbar,
  useSplitDetailShown,
  type MenuItem,
  type ToolbarAction,
} from "@omniralph/ui";
import { IconFileText, IconGitMerge, IconGitPullRequest, IconRefresh } from "@tabler/icons-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useCurrentUser } from "@/components/current-user";
import { useRunOutcomeSound } from "@/components/sound";
import { RUN_KIND_ICONS } from "@/components/row-avatars";
import { QuestionForm } from "@/components/runs/question-form";
import { RunActivity } from "@/components/runs/run-activity";
import { RunReason } from "@/components/runs/run-reason";
import {
  runMenuItems,
  runStatusLine,
  runToolbar,
  selectedStep,
  type RunToolbarItem,
} from "@/components/runs/run-detail";
import {
  RunDetailOverlayProvider,
  useRunDetailOverlay,
  type RunDetailOverlay,
} from "@/components/runs/run-detail-overlay";
import { RunFactBadges, RunLanes } from "@/components/runs/run-details";
import { RunIterations } from "@/components/runs/run-iterations";
import { RunProgress } from "@/components/runs/run-progress";
import { RunSession } from "@/components/runs/run-session";
import { epicAuditTabs } from "@/components/runs/epic-audit";
import { reviewFindingsTabs } from "@/components/runs/review-findings";
import { StepPanel } from "@/components/runs/step-panel";
import { storyContentTabs } from "@/components/runs/story-content";
import { storyDiffTabs } from "@/components/runs/story-diff";
import { useRunRetry, useRunRetryPending, useRunStop } from "@/components/runs/use-run-actions";
import { useRunDetail } from "@/components/runs/use-run-detail";
import { TriageSummary } from "@/components/runs/triage-summary";
import { VIEW_PRD, ViewPrdSheet } from "@/components/work-items/view-prd-sheet";
import { workItemHref } from "@/components/work-items/work-item-links";
import { ApiError } from "@/lib/api/client";
import type { RunDetail } from "@/lib/api/runs";
import { useKeyShortcuts, useShortcut } from "@/lib/shortcuts";
import { RUN_KIND_LABELS } from "../inbox/labels";
import { NO_RUN_FILTERS, parseRunFilters, runInListHref, runStepHref } from "./filters";
import { runRowLabel } from "./labels";
import "@/components/runs/run-cards.css";
import "./run-detail.css";
import { useAskContextRepository } from "@/components/ask/ask-context";

/** Shown for a run that doesn't exist, or is outside the user's organizations. */
export const RUN_NOT_FOUND = "This run doesn't exist or isn't in your organizations.";

/** The failed load of a run. */
export const RUN_DETAIL_FAILED = "Couldn't load this run.";

/** A queued run has a reason only while it waits for something (a missing host tool). */
const REASON_STATUSES: readonly RunDetail["status"][] = ["waiting", "queued", "stopped", "failed"];

/**
 * Items other screens add to the run ⋯ menu, first: each may open an element over the run
 * detail through `overlay`.
 */
export type RunMenuExtension = (run: RunDetail, overlay: RunDetailOverlay) => MenuItem[];

export interface RunDetailViewProps {
  runId: string;
  menuItems?: RunMenuExtension;
}

async function copyBranch(branch: string) {
  try {
    await navigator.clipboard.writeText(branch);
    toast("Branch copied");
  } catch {
    toast("Couldn't copy the branch.", { variant: "danger" });
  }
}

/**
 * The header badges (Design rules 1 and 13): organization (All organizations), kind, work
 * item (linking to its Backlog page; Open in <tracker> is in the ⋯ menu), repo, then the run's
 * facts (`RunFactBadges`: branch, agent, tokens in and out, cost, attempts).
 */
function RunHeaderBadges({ run, showOrganization }: { run: RunDetail; showOrganization: boolean }) {
  return (
    <>
      {showOrganization ? <OrgBadge name={run.organization.name} /> : null}
      <MetaBadge icon={RUN_KIND_ICONS[run.kind]} text={RUN_KIND_LABELS[run.kind]} />
      {run.workItem ? (
        <IssueBadge
          tracker={run.workItem.tracker}
          id={run.workItem.identifier}
          href={run.workItem.id ? workItemHref(run.workItem.id) : (run.workItem.url ?? undefined)}
        />
      ) : null}
      {run.repository ? (
        <RepoBadge host={run.repository.provider} name={run.repository.fullPath} />
      ) : null}
      <RunFactBadges run={run} />
    </>
  );
}

function RunDetailSkeleton() {
  return (
    <div className="or-run-detail" aria-busy="true" data-testid="run-detail-skeleton">
      <div className="or-run-skeleton" aria-hidden="true">
        <div className="or-run-skeleton__line or-run-skeleton__line--short" />
        <div className="or-run-skeleton__line" />
        <div className="or-run-skeleton__line or-run-skeleton__line--bar" />
        <div className="or-run-skeleton__line" />
      </div>
    </div>
  );
}

function RunDetailContent({ run, menuItems }: { run: RunDetail; menuItems?: RunMenuExtension }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const filters = parseRunFilters(searchParams);
  const user = useCurrentUser();
  const overlay = useRunDetailOverlay();
  const [confirmStop, setConfirmStop] = useState(false);

  // The run finishing or failing while it's watched plays a cue.
  useRunOutcomeSound(run);
  const step = selectedStep(run, searchParams.get("step"));
  const retry = useRunRetry(run.id, (result) => {
    if (result.id !== run.id) router.push(runInListHref(result.id, filters));
  });
  const retrying = useRunRetryPending(run.id);
  const stop = useRunStop(run.id);
  const toolbar = runToolbar(run, step);
  const retryItem = toolbar.find((item) => item.kind === "retry");
  const retryRun = (item: Extract<RunToolbarItem, { kind: "retry" }>) =>
    retry.mutate({ target: item.target, selectedStepId: step?.id });

  // Retry (`r`) and Stop run (`x`) do what their buttons do, while they're shown and enabled
  // and this pane shows (not behind the phone's list).
  const shown = useSplitDetailShown();
  const retryKeys = useKeyShortcuts("retry");
  const stopKeys = useKeyShortcuts("stop");
  useShortcut("retry", () => (retryItem ? retryRun(retryItem) : false), {
    enabled: shown && retryItem !== undefined && !retrying,
  });
  useShortcut("stop", () => setConfirmStop(true), {
    enabled: shown && run.details.actions.stop,
  });

  const toolbarAction = (item: RunToolbarItem): ToolbarAction =>
    item.kind === "pull_request"
      ? {
          label: item.label,
          icon: item.label === "Open merge request" ? IconGitMerge : IconGitPullRequest,
          href: item.href,
        }
      : {
          label: item.label,
          icon: IconRefresh,
          disabled: retrying,
          onSelect: () => retryRun(item),
          keyShortcuts: retryKeys,
        };
  // View PRD: the run's work item's PRD in a sheet over the detail (every run with a work
  // item has it, so a running run has a call to action too).
  const workItem = run.workItem?.id ? run.workItem : null;
  const openPrd = workItem
    ? () =>
        overlay.open(
          <ViewPrdSheet
            runId={run.id}
            workItem={{ id: workItem.id, identifier: workItem.identifier }}
          />,
        )
    : undefined;
  const viewPrd: ToolbarAction[] = openPrd
    ? [{ label: VIEW_PRD, icon: IconFileText, onSelect: openPrd }]
    : [];
  const actions = [...toolbar.map(toolbarAction).slice(0, 2), ...viewPrd] as
    | []
    | [ToolbarAction]
    | [ToolbarAction, ToolbarAction]
    | [ToolbarAction, ToolbarAction, ToolbarAction];
  const menu = runMenuItems(run, {
    onCopyBranch: () => void copyBranch(run.branch ?? ""),
    onStop: () => setConfirmStop(true),
    leading: menuItems?.(run, overlay),
    stopKeyShortcuts: stopKeys,
  });

  const status = runStatusLine(run);
  const reason = REASON_STATUSES.includes(run.status) ? run.reason : null;

  return (
    <article className="or-run-detail" aria-labelledby="or-run-detail-title">
      <header className="or-run-detail__head">
        <div className="or-run-detail__badges">
          <RunHeaderBadges run={run} showOrganization={user.scope === "all"} />
        </div>
        <Toolbar label="Run actions" actions={actions} menu={menu} />
      </header>
      <StatusLine
        className="or-run-detail__status"
        tone={status.tone}
        dotLabel={runRowLabel(run).statusLabel}
      >
        {status.text}
        {status.story ? (
          <>
            {" "}
            <MetaBadge text={status.story} />
          </>
        ) : null}
        {status.change ? (
          <>
            {" "}
            <MetaBadge
              icon={status.change.provider === "gitlab" ? IconGitMerge : IconGitPullRequest}
              text={status.change.text}
            />
          </>
        ) : null}
      </StatusLine>
      <h2 id="or-run-detail-title" className="or-run-detail__title">
        {run.title}
      </h2>
      <RunLanes run={run} />
      {reason ? (
        <RunReason className="or-run-detail__reason" reason={reason} link={run.reasonLink} />
      ) : null}
      {run.details.question ? (
        <QuestionForm
          key={run.details.question.key}
          variant="run"
          runId={run.id}
          question={run.details.question}
        />
      ) : null}
      <div className="or-run-detail__cards">
        {run.kind === "triage" ? <TriageSummary runId={run.id} onViewPrd={openPrd} /> : null}
        {run.steps.length > 0 ? (
          <RunProgress
            run={run}
            mode="select"
            headingLevel={3}
            selectedStepId={step?.id}
            onSelectStep={(stepId) =>
              router.replace(
                runInListHref(run.id, filters, { step: stepId, tab: searchParams.get("tab") }),
                { scroll: false },
              )
            }
            stepHref={(stepId) => runStepHref(run.id, stepId, filters)}
            stepPanel={
              step ? (
                <StepPanel
                  key={step.id}
                  run={run}
                  step={step}
                  tab={searchParams.get("tab")}
                  attemptId={searchParams.get("attempt")}
                  onNavigate={(next) =>
                    router.replace(
                      runInListHref(run.id, filters, {
                        step: step.id,
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
              ) : undefined
            }
          />
        ) : null}
        <RunIterations run={run} headingLevel={3} />
        <RunSession run={run} />
        <RunActivity run={run} reason={reason} headingLevel={3} />
      </div>
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop this run?"
        description="Om stops working on it. You can retry it later."
        confirmLabel="Stop run"
        destructive
        onConfirm={() => stop.mutate()}
      />
    </article>
  );
}

/**
 * A run of any kind on the Runs screen (Design board Runs): its header badges and toolbar
 * (Design rule 5, with View PRD for a run with a work item), its status line, title, a
 * multi-repo epic's lanes and, for a waiting, stopped or failed run, why;
 * an open question's form; the progress card with the selected step (`?step=`, else
 * `defaultStep`) and its `StepPanel`; a triage run's summary; a looped run's iterations; an
 * epic's or request's collapsed
 * Session; and the run's Activity. A live query: the run's
 * change events refetch it. `menuItems` adds entries to the ⋯ menu, which may open an
 * element over the detail (`useRunDetailOverlay`).
 */
export function RunDetailView({ runId, menuItems }: RunDetailViewProps) {
  const detail = useRunDetail(runId);
  useAskContextRepository(detail.data?.details.repository?.id);
  if (detail.isPending) return <RunDetailSkeleton />;
  if (detail.isError) {
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return <EmptyState className="or-run-detail__empty" title={RUN_NOT_FOUND} />;
    }
    return (
      <div className="or-run-detail">
        <p className="or-run-error" role="alert">
          {RUN_DETAIL_FAILED}
          <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
            Retry
          </Button>
        </p>
      </div>
    );
  }
  return (
    <RunDetailOverlayProvider key={runId}>
      <RunDetailContent run={detail.data} menuItems={menuItems} />
    </RunDetailOverlayProvider>
  );
}
