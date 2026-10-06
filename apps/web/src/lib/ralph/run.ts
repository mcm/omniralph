/**
 * The ralph orchestrator's run state machine. Every change to a run goes
 * through `advanceRun`, which holds the run's row lock, so the webhooks and
 * job outcomes that race to move a run apply one at a time; it is idempotent
 * (calling it again with nothing new changes nothing).
 */
import {
  listStories,
  lockRun,
  updateStory,
  upsertStories,
  type Database,
  type RalphRun,
  type RalphRunStatus,
  type RalphStory,
  type RalphStoryStatus,
  type RalphStoryUpdate,
  type RalphTransaction,
} from "@omniralph/db";
import type { Epic, Story } from "@omniralph/ralph";
import type { LinearGateway } from "@/lib/linear/gateway";
import { reloadEpic } from "./epic-loader";
import { planFor } from "./plan";

export interface RalphDeps {
  db: Database;
  linear: LinearGateway;
}

/** Runs that are over: `advanceRun` leaves them alone. */
export const FINISHED_RUN_STATUSES: ReadonlySet<RalphRunStatus> = new Set([
  "completed",
  "failed",
  "stopped",
]);

/**
 * The stored status of a story after re-reading it from Linear: done or
 * canceled in Linear wins; a manual label makes a waiting story manual (and
 * removing it makes it pending again). Running, completed and exhausted
 * stories keep their status: the orchestrator owns those.
 */
export function syncedStoryStatus(current: RalphStoryStatus, story: Story): RalphStoryStatus {
  if (story.status === "completed") return "completed";
  if (story.status === "cancelled") return current === "completed" ? current : "canceled";
  if (current === "running" || current === "completed" || current === "exhausted") return current;
  if (story.manual) return "manual";
  if (current === "manual" || current === "canceled") return "pending";
  return current;
}

/**
 * Stores the epic's stories (new ones are added, known ones refreshed) and
 * syncs their status with Linear. Returns the run's stories in order.
 */
export async function syncStories(
  tx: RalphTransaction | Database,
  runId: string,
  epic: Epic,
): Promise<RalphStory[]> {
  const byIssue = new Map(epic.stories.map((s) => [s.issueId ?? s.key, s]));
  const stored = await upsertStories(
    tx,
    runId,
    epic.stories.map((s) => ({
      linearIssueId: s.issueId ?? s.key,
      identifier: s.identifier ?? s.storyId,
      title: s.title,
    })),
  );
  let changed = false;
  for (const row of stored) {
    const story = byIssue.get(row.linearIssueId);
    if (!story) continue;
    const status = syncedStoryStatus(row.status, story);
    if (status !== row.status) {
      await updateStory(tx, row.id, { status });
      changed = true;
    }
  }
  return changed ? listStories(tx, runId) : stored;
}

/** Posts the run's plan (every story with its status) to its agent session. */
export async function publishPlan(
  linear: LinearGateway,
  run: Pick<RalphRun, "linearAgentSessionId">,
  stories: readonly RalphStory[],
): Promise<void> {
  await linear.updateSessionPlan(run.linearAgentSessionId, planFor(stories));
}

/**
 * Changes a story (inside `lockRun`) and, when its status changed, posts the
 * updated plan. Returns the updated story, or null if it's gone.
 */
export async function updateStoryAndPlan(
  linear: LinearGateway,
  tx: RalphTransaction,
  run: RalphRun,
  story: RalphStory,
  update: RalphStoryUpdate,
): Promise<RalphStory | null> {
  const updated = await updateStory(tx, story.id, update);
  if (updated && updated.status !== story.status) {
    await publishPlan(linear, run, await listStories(tx, run.id));
  }
  return updated;
}

export type AdvanceResult =
  | { action: "gone" }
  | { action: "finished"; run: RalphRun }
  | { action: "planned"; run: RalphRun; stories: RalphStory[] };

/**
 * Moves a run forward under its row lock: re-reads its stories from Linear,
 * syncs their status and posts the plan. Later stories extend it to select
 * and enqueue the next story, wait on blockers and finish the run.
 */
export async function advanceRun(runId: string, deps: RalphDeps): Promise<AdvanceResult> {
  const result = await lockRun(deps.db, runId, async (tx, run): Promise<AdvanceResult> => {
    if (FINISHED_RUN_STATUSES.has(run.status)) return { action: "finished", run };
    const epic = await reloadEpic(deps.linear, run);
    const stories = await syncStories(tx, run.id, epic);
    await publishPlan(deps.linear, run, stories);
    return { action: "planned", run, stories };
  });
  return result ?? { action: "gone" };
}
