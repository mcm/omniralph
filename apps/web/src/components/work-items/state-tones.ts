import type { StatusTone } from "@omniralph/ui";
import type { WorkItemDetail } from "@/lib/api/work-items";

type WorkItemStateCategory = WorkItemDetail["state"]["category"];

/**
 * Each tracker state category's tone (Design rule 15): done mint, in progress lavender, the
 * rest (triage, backlog, todo, canceled) neutral.
 */
export const WORK_ITEM_STATE_TONES: Readonly<Record<WorkItemStateCategory, StatusTone>> = {
  triage: "neutral",
  backlog: "neutral",
  todo: "neutral",
  in_progress: "run",
  done: "good",
  canceled: "neutral",
};
