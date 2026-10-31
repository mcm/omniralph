"use client";

import { Sheet } from "@omniralph/ui";
import { useRunDetailOverlay } from "@/components/runs/run-detail-overlay";
import { useRunDetail } from "@/components/runs/use-run-detail";
import type { RunRow } from "@/lib/api/runs";
import { PrdView, type PrdViewProps } from "./prd-view";
import { useWorkItemDetail } from "./use-work-item-detail";

/** The run detail's toolbar action and the triage card's button that open `ViewPrdSheet`. */
export const VIEW_PRD = "View PRD";

/** "PRD of SOC-412": the sheet's title. */
export const prdSheetTitle = (identifier: string) => `PRD of ${identifier}`;

/** Run statuses during which Om is working on the work item: its PRD is read-only. */
const WORKING_STATUSES: readonly RunRow["status"][] = ["queued", "running", "waiting"];

/** The PRD's mode beside a run: read-only while the run is queued, running or waiting. */
export function prdModeForRun(status: RunRow["status"]): PrdViewProps["mode"] {
  return WORKING_STATUSES.includes(status) ? "read-only" : "editable";
}

export interface ViewPrdSheetProps {
  runId: string;
  workItem: { id: string; identifier: string };
}

/**
 * View PRD (a `Sheet` over the run detail, full screen on phone): the run's work item's
 * `PrdView`, read-only while the run is queued, running or waiting, editable otherwise.
 * Both the run and the work item are live queries (the ones the detail already holds), so
 * the mode follows the run's status and the PRD follows the tracker while it's open.
 */
export function ViewPrdSheet({ runId, workItem }: ViewPrdSheetProps) {
  const overlay = useRunDetailOverlay();
  const run = useRunDetail(runId);
  const item = useWorkItemDetail(workItem.id);
  // Until the run is known, assume Om is working: never offer an edit it would refuse.
  const mode = run.data ? prdModeForRun(run.data.status) : "read-only";

  return (
    <Sheet
      title={prdSheetTitle(workItem.identifier)}
      description={item.data?.title}
      open
      onOpenChange={(open) => {
        if (!open) overlay.close();
      }}
    >
      <PrdView workItemId={workItem.id} mode={mode} />
    </Sheet>
  );
}
