"use client";

import { EmptyState, StatusLine, toast, Toolbar, useSplitDetailShown } from "@omniralph/ui";
import { DecisionButtons } from "@/components/runs/decision-buttons";
import { ITEM_HANDLED, prdWorkItem } from "@/components/runs/decisions";
import { QuestionForm } from "@/components/runs/question-form";
import {
  RunDetailOverlayProvider,
  useRunDetailOverlay,
} from "@/components/runs/run-detail-overlay";
import { RunReason } from "@/components/runs/run-reason";
import { ManualTaskChecklist } from "@/components/work-items/manual-task-checklist";
import { ViewPrdSheet } from "@/components/work-items/view-prd-sheet";
import type { InboxItem } from "@/lib/api/inbox";
import { InboxHeaderBadges } from "./inbox-badges";
import { InboxItemCards } from "./inbox-item-cards";
import { inboxItemLabel } from "./labels";
import { inboxItemUrl, inboxMenuItems } from "./menu";

/** Shown in the detail pane when the URL's item no longer derives an item. */
export { ITEM_HANDLED };

async function copyLink(item: InboxItem) {
  try {
    await navigator.clipboard.writeText(inboxItemUrl(item, window.location.origin));
    toast("Link copied");
  } catch {
    toast("Couldn't copy the link.", { variant: "danger" });
  }
}

interface InboxDetailProps {
  item: InboxItem;
  now: number;
  showOrganization: boolean;
}

/**
 * The selected item's detail: its header badges and ⋯ menu, its status line, the title as
 * the pane's heading, why it's here, a manual story's task list (`ManualTaskChecklist`),
 * and its calls to action (a question's form, with its answers, for a run's open question),
 * then the cards that show why it's here (the run's progress, a PR/MR's AI review, what
 * went wrong) and the run's activity. The decisions' keyboard shortcuts are bound here, not
 * on the phone's inline row. The ⋯ menu's View PRD opens the PRD in a sheet over it.
 */
export function InboxDetail(props: InboxDetailProps) {
  return (
    <RunDetailOverlayProvider key={props.item.key}>
      <Detail {...props} />
    </RunDetailOverlayProvider>
  );
}

function Detail({ item, now, showOrganization }: InboxDetailProps) {
  const label = inboxItemLabel(item, now);
  // The decisions' keys work while this pane shows (not behind the phone's list).
  const bindShortcuts = useSplitDetailShown();
  const overlay = useRunDetailOverlay();
  const prd = prdWorkItem(item);
  const run = item.run;
  const viewPrd =
    prd && run ? () => overlay.open(<ViewPrdSheet runId={run.id} workItem={prd} />) : undefined;
  return (
    <article className="or-inbox-detail" aria-labelledby="or-inbox-detail-title">
      <header className="or-inbox-detail__head">
        <div className="or-inbox-detail__badges">
          <InboxHeaderBadges item={item} showOrganization={showOrganization} />
        </div>
        <Toolbar
          label="Item actions"
          menu={inboxMenuItems(item, () => void copyLink(item), viewPrd)}
        />
      </header>
      <StatusLine tone={label.tone} dotLabel={label.statusLabel}>
        {label.statusLine}
      </StatusLine>
      <h2 id="or-inbox-detail-title" className="or-inbox-detail__title">
        {item.title}
      </h2>
      <RunReason className="or-inbox-detail__reason" reason={item.reason} link={item.reasonLink} />
      {item.kind === "manual_story" && item.workItem ? (
        <ManualTaskChecklist key={item.workItem.id} workItemId={item.workItem.id} />
      ) : null}
      {item.question && item.run && item.actions.includes("answer") ? (
        <QuestionForm
          key={item.key}
          variant="inbox"
          runId={item.run.id}
          question={item.question}
          item={item}
          bindShortcuts={bindShortcuts}
        />
      ) : (
        <DecisionButtons key={item.key} item={item} bindShortcuts={bindShortcuts} />
      )}
      <InboxItemCards item={item} />
    </article>
  );
}

/** The detail pane when the selected item is gone (decided elsewhere, or by someone else). */
export function InboxItemHandled() {
  return <EmptyState className="or-inbox-detail__empty" title={ITEM_HANDLED} />;
}
