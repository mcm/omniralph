/**
 * The Linear agent-session plan of a ralph run: one step per story, in
 * sub-issue order (ported from cyralph's `planFor`).
 */
import type { RalphStory, RalphStoryStatus } from "@omniralph/db";
import type { PlanStep } from "@/lib/linear/gateway";

const PLAN_STATUS: Record<RalphStoryStatus, PlanStep["status"]> = {
  pending: "pending",
  running: "inProgress",
  completed: "completed",
  blocked: "pending",
  exhausted: "canceled",
  manual: "pending",
  canceled: "canceled",
};

/** Every story of the run with its status, in order. */
export function planFor(
  stories: readonly Pick<RalphStory, "identifier" | "title" | "status">[],
): PlanStep[] {
  return stories.map((story) => ({
    content: `${story.identifier}: ${story.title}${story.status === "manual" ? " (manual)" : ""}`,
    status: PLAN_STATUS[story.status],
  }));
}
