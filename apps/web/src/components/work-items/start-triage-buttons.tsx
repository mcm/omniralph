"use client";

import { ConfirmDialog, IconButton } from "@omniralph/ui";
import { IconPlayerPlay, IconSparkles } from "@tabler/icons-react";
import { useState } from "react";
import type { WorkItemRow } from "@/lib/api/work-items";
import { joinNames } from "@/lib/work-items/join-names";
import {
  triagingTooltip,
  useStartWorkItem,
  useTriageWorkItem,
  type WorkItemActionTarget,
} from "./use-work-item-actions";

export const START_EPIC = "Start epic";
export const TRIAGE_NOW = "Triage now";

/** "Starts when SOC-398 and SOC-401 are done": a blocked item's Start epic tooltip. */
export function startsWhenTooltip(blockers: readonly string[]): string {
  return blockers.length > 0
    ? `Starts when ${joinNames(blockers)} ${blockers.length === 1 ? "is" : "are"} done`
    : "Starts when its blockers are done";
}

/** "Start SOC-412?": the confirm a blocked item's Start epic asks first. */
export function startBlockedTitle(identifier: string): string {
  return `Start ${identifier}?`;
}
export const START_BLOCKED_DESCRIPTION = "Om will wait for its blockers to finish.";

export interface StartEpicIconButtonProps {
  item: WorkItemActionTarget & Pick<WorkItemRow, "blocked" | "blockers">;
}

/**
 * Start epic as an icon button (`play`), through `useStartWorkItem` (the detail's hook). On
 * a blocked item its tooltip says what it waits for, and a click asks to confirm first: the
 * run still starts, and waits for its blockers as a delegation in Linear does.
 */
export function StartEpicIconButton({ item }: StartEpicIconButtonProps) {
  const start = useStartWorkItem();
  const [confirming, setConfirming] = useState(false);
  const run = () => start.mutate(item);
  return (
    <>
      <IconButton
        icon={IconPlayerPlay}
        size="sm"
        label={`${START_EPIC} ${item.identifier}`}
        tooltip={item.blocked ? startsWhenTooltip(item.blockers) : undefined}
        disabled={start.isPending}
        onClick={() => (item.blocked ? setConfirming(true) : run())}
      />
      {item.blocked ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={startBlockedTitle(item.identifier)}
          description={START_BLOCKED_DESCRIPTION}
          confirmLabel={START_EPIC}
          onConfirm={run}
        />
      ) : null}
    </>
  );
}

export interface TriageNowIconButtonProps {
  item: WorkItemActionTarget & Pick<WorkItemRow, "triageRunning">;
}

/**
 * Triage now as an icon button (`sparkles`), through `useTriageWorkItem` (the detail's
 * hook). While Om triages the item it's disabled with "Om is triaging SOC-412".
 */
export function TriageNowIconButton({ item }: TriageNowIconButtonProps) {
  const triage = useTriageWorkItem();
  const triaging = item.triageRunning || triage.isPending;
  return (
    <IconButton
      icon={IconSparkles}
      size="sm"
      label={`${TRIAGE_NOW} ${item.identifier}`}
      disabled={triaging}
      disabledReason={triaging ? triagingTooltip(item.identifier) : undefined}
      onClick={() => triage.mutate(item)}
    />
  );
}
