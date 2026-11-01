"use client";

import { IconButton } from "@omniralph/ui";
import { IconPlayerPlay, IconSparkles } from "@tabler/icons-react";
import type { WorkItemRow } from "@/lib/api/work-items";
import { manualReason, startHoldReason, type HeldWorkItem } from "@/lib/work-items/hold-reasons";
import {
  triagingTooltip,
  useStartWorkItem,
  useTriageWorkItem,
  type WorkItemActionTarget,
} from "./use-work-item-actions";

export const START_EPIC = "Start epic";
export const TRIAGE_NOW = "Triage now";

export interface StartEpicIconButtonProps {
  item: WorkItemActionTarget & HeldWorkItem;
}

/**
 * Start epic as an icon button (`play`), through `useStartWorkItem` (the detail's hook). A
 * blocked or manual item can't be started: it's disabled, saying why (its manual label, its
 * blocked label, or what it waits for).
 */
export function StartEpicIconButton({ item }: StartEpicIconButtonProps) {
  const start = useStartWorkItem();
  const held = startHoldReason(item);
  return (
    <IconButton
      icon={IconPlayerPlay}
      size="sm"
      label={`${START_EPIC} ${item.identifier}`}
      disabled={held !== undefined || start.isPending}
      disabledReason={held}
      onClick={() => start.mutate(item)}
    />
  );
}

export interface TriageNowIconButtonProps {
  item: WorkItemActionTarget & Pick<WorkItemRow, "triageRunning" | "manual" | "manualLabels">;
}

/**
 * Triage now as an icon button (`sparkles`), through `useTriageWorkItem` (the detail's
 * hook). While Om triages the item it's disabled with "Om is triaging SOC-412"; a manual
 * item, a person's job, can't be triaged: it's disabled naming its manual label.
 */
export function TriageNowIconButton({ item }: TriageNowIconButtonProps) {
  const triage = useTriageWorkItem();
  const triaging = item.triageRunning || triage.isPending;
  const manual = item.manual ? manualReason(item.manualLabels) : undefined;
  return (
    <IconButton
      icon={IconSparkles}
      size="sm"
      label={`${TRIAGE_NOW} ${item.identifier}`}
      disabled={manual !== undefined || triaging}
      disabledReason={manual ?? (triaging ? triagingTooltip(item.identifier) : undefined)}
      onClick={() => triage.mutate(item)}
    />
  );
}
