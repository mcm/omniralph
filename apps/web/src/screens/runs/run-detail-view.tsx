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
  IconRetry,
} from "@omniralph/ui";
import { IconGitMerge, IconGitPullRequest } from "@tabler/icons-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useCurrentUser } from "@/components/current-user";
import { ManualStoryDecisions } from "@/components/runs/manual-story-decisions";
import { QuestionForm } from "@/components/runs/question-form";
import { RunActivity } from "@/components/runs/run-activity";
import { RUN_KIND_ICONS, RUN_KIND_LABELS } from "@/components/runs/run-kind";
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
import { RunDetails } from "@/components/runs/run-details";
import { RunProgress } from "@/components/runs/run-progress";
import { RunSession } from "@/components/runs/run-session";
import { reviewFindingsTabs } from "@/components/runs/review-findings";
import { StepPanel } from "@/components/runs/step-panel";
import { storyDiffTabs } from "@/components/runs/story-diff";
import { useRunRetry, useRunRetryPending, useRunStop } from "@/components/runs/use-run-actions";
import { useRunDetail } from "@/components/runs/use-run-detail";
import { ApiError } from "@/lib/api/client";
import type { RunDetail } from "@/lib/api/runs";
import { useKeyShortcuts, useShortcut } from "@/lib/shortcuts";
import { NO_RUN_FILTERS, parseRunFilters, runInListHref, runStepHref } from "./filters";
import { runRowLabel } from "./labels";
import "@/components/runs/run-cards.css";
import "./run-detail.css";
import { useAskContextRepository } from "@/components/ask/ask-context";
import { runHref } from "@/lib/runs/hrefs";

/** Shown for a run that doesn't exist, or is outside the user's organizations. */
export const RUN_NOT_FOUND = "This run doesn't exist or isn't in your organizations.";

/** The failed load of a run. */
export const RUN_DETAIL_FAILED = "Couldn't load this run.";

/** A queued run has a reason only while it waits for something (a missing host tool). */
const REASON_STATUSES: readonly RunDetail["status"][] = ["waiting", "queued", "stopped", "failed"];

/**
 * Items other screens add to the run ⋯ menu, first: each may open an element over the run
 * detail through `overlay` (the Backlog's "View PRD" sheet, Ask's "Open chat").
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

async function copyLink(runId: string) {
  try {
    await navigator.clipboard.writeText(new URL(runHref(runId), window.location.origin).href);
    toast("Link copied");
  } catch {
    toast("Couldn't copy the link.", { variant: "danger" });
  }
}

/** The header badges (Design rules 1 and 13): organization (All organizations), kind, work item, repo. */
function RunHeaderBadges({ run, showOrganization }: { run: RunDetail; showOrganization: boolean }) {
  return (
    <>
      {showOrganization ? <OrgBadge name={run.organization.name} /> : null}
      <MetaBadge icon={RUN_KIND_ICONS[run.kind]} text={RUN_KIND_LABELS[run.kind]} />
      {run.workItem ? (
        <IssueBadge
          tracker="linear"
          id={run.workItem.identifier}
          href={run.workItem.url ?? undefined}
        />
      ) : null}
      {run.repository ? (
        <RepoBadge host={run.repository.provider} name={run.repository.fullPath} />
      ) : null}
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
          icon: IconRetry,
          disabled: retrying,
          onSelect: () => retryRun(item),
          keyShortcuts: retryKeys,
        };
  const actions = toolbar.map(toolbarAction).slice(0, 2) as
    | []
    | [ToolbarAction]
    | [ToolbarAction, ToolbarAction];
  const menu = runMenuItems(run, {
    onCopyBranch: () => void copyBranch(run.branch ?? ""),
    onCopyLink: () => void copyLink(run.id),
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
      <StatusLine tone={status.tone} dotLabel={runRowLabel(run).label}>
        {status.text}
      </StatusLine>
      <h2 id="or-run-detail-title" className="or-run-detail__title">
        {run.title}
      </h2>
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
      <ManualStoryDecisions run={run} />
      <div className="or-run-detail__cards">
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
                  tabs={[...storyDiffTabs(run, step), ...reviewFindingsTabs(run, step)]}
                />
              ) : undefined
            }
          />
        ) : null}
        <RunDetails run={run} />
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
 * (Design rule 5), its status line, title and, for a waiting, stopped or failed run, why;
 * an open question's form; the progress card with the selected step (`?step=`, else
 * `defaultStep`) and its `StepPanel`; the collapsed Details; an epic's or request's collapsed Session; and the
 * run's Activity. A live query: the run's
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
