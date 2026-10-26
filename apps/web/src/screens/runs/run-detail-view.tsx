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
  type MenuItem,
  type ToolbarAction,
} from "@omniralph/ui";
import {
  IconEye,
  IconGitMerge,
  IconGitPullRequest,
  IconListSearch,
  IconMessage2,
  IconMessageQuestion,
  IconRefresh,
  IconStack2,
  type TablerIcon,
} from "@tabler/icons-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useCurrentUser } from "@/components/current-user";
import { QuestionForm } from "@/components/runs/question-form";
import { RunActivity } from "@/components/runs/run-activity";
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
import { useRunRetry, useRunStop } from "@/components/runs/use-run-actions";
import { useRunDetail } from "@/components/runs/use-run-detail";
import { ApiError } from "@/lib/api/client";
import type { RunDetail } from "@/lib/api/runs";
import { RUN_KIND_LABELS } from "../inbox/labels";
import { parseRunFilters, runInListHref } from "./filters";
import { runRowLabel } from "./labels";
import "@/components/runs/run-cards.css";
import "./run-detail.css";

/** Shown for a run that doesn't exist, or is outside the user's organizations. */
export const RUN_NOT_FOUND = "This run doesn't exist or isn't in your organizations.";

/** The failed load of a run. */
export const RUN_DETAIL_FAILED = "Couldn't load this run.";

const REASON_STATUSES: readonly RunDetail["status"][] = ["waiting", "stopped", "failed"];

const KIND_ICONS: Record<RunDetail["kind"], TablerIcon> = {
  epic: IconStack2,
  request: IconMessage2,
  review: IconEye,
  triage: IconListSearch,
  ask: IconMessageQuestion,
};

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

/** The header badges (Design rules 1 and 13): organization (All organizations), kind, work item, repo. */
function RunHeaderBadges({ run, showOrganization }: { run: RunDetail; showOrganization: boolean }) {
  return (
    <>
      {showOrganization ? <OrgBadge name={run.organization.name} /> : null}
      <MetaBadge icon={KIND_ICONS[run.kind]} text={RUN_KIND_LABELS[run.kind]} />
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
  const stop = useRunStop(run.id);

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
          disabled: retry.isPending,
          onSelect: () => retry.mutate({ target: item.target, selectedStepId: step?.id }),
        };
  const actions = runToolbar(run, step).map(toolbarAction).slice(0, 2) as
    [] | [ToolbarAction] | [ToolbarAction, ToolbarAction];
  const menu = runMenuItems(run, {
    onCopyBranch: () => void copyBranch(run.branch ?? ""),
    onStop: () => setConfirmStop(true),
    leading: menuItems?.(run, overlay),
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
      {reason ? <p className="or-run-detail__reason">{reason}</p> : null}
      {run.details.question ? (
        <QuestionForm
          key={run.details.question.key}
          variant="run"
          runId={run.id}
          question={run.details.question}
        />
      ) : null}
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
          />
        ) : null}
        <RunDetails run={run} />
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
 * `defaultStep`); the collapsed Details; and the run's Activity. A live query: the run's
 * change events refetch it. `menuItems` adds entries to the ⋯ menu, which may open an
 * element over the detail (`useRunDetailOverlay`).
 */
export function RunDetailView({ runId, menuItems }: RunDetailViewProps) {
  const detail = useRunDetail(runId);
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
