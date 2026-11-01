import type { WorkItemRow } from "@/lib/api/work-items";
import { joinNames } from "./join-names";

/**
 * Why a held work item can't be started or triaged: the wording the detail toolbar, the shared
 * Start epic and Triage now buttons, and the start and triage APIs use. Client-safe.
 */

/** The holds a reason reads from a Backlog row or a work item detail. */
export type HeldWorkItem = Pick<
  WorkItemRow,
  "blocked" | "blockers" | "blockedLabels" | "manual" | "manualLabels"
>;

export const MANUAL_START_MESSAGE = "A manual task is a person's job: Om doesn't start it.";
export const BLOCKED_START_MESSAGE =
  "A blocked work item can't be started. Start it once nothing blocks it.";
export const MANUAL_TRIAGE_MESSAGE = "A manual task is a person's job: Om doesn't triage it.";

/** "Starts when SOC-398 and SOC-401 are done": a relation-blocked item's reason. */
export function startsWhenTooltip(blockers: readonly string[]): string {
  return blockers.length > 0
    ? `Starts when ${joinNames(blockers)} ${blockers.length === 1 ? "is" : "are"} done`
    : "Starts when its blockers are done";
}

/** "Labeled on hold, which keeps Om off it": a label-blocked item's reason. */
export function blockedLabelReason(labels: readonly string[]): string {
  return `Labeled ${joinNames(labels)}, which keeps Om off it`;
}

/** "Labeled manual: this is a person's job": a manual item's reason. */
export function manualReason(labels: readonly string[]): string {
  return `Labeled ${labels.length > 0 ? joinNames(labels) : "manual"}: this is a person's job`;
}

/**
 * Why Start epic is unavailable for a held item, or undefined when nothing holds it. Manual
 * wins over blocked, and a blocked label over blockers (a label doesn't clear on its own).
 */
export function startHoldReason(item: HeldWorkItem): string | undefined {
  if (item.manual) return manualReason(item.manualLabels);
  if (item.blockedLabels.length > 0) return blockedLabelReason(item.blockedLabels);
  if (item.blocked) return startsWhenTooltip(item.blockers);
  return undefined;
}

/** Why Triage now is unavailable for a held item (only a manual one), or undefined. */
export function triageHoldReason(item: HeldWorkItem): string | undefined {
  return item.manual ? manualReason(item.manualLabels) : undefined;
}
