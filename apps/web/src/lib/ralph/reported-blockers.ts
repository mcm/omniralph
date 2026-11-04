/**
 * Turns the blockers a story's session reported (`blockedBy`) into blocks relations, following
 * the planning model's epic boundaries (`workItemRole` through `PlannedItems`): a task of the
 * story's own epic blocks it directly, a task of another epic blocks it through that whole epic,
 * and a standalone task or an epic blocks it as it is. Outside blockers (another epic or a
 * standalone task) are recorded as the story's cross-epic dependencies: their work reaches the
 * story's branch only through the default branch.
 */
import { isTrackerRun, recordCrossEpicBlockers, type RalphStory } from "@omniralph/db";
import { isDoneStateType } from "@omniralph/ralph";
import type { PlannedItem } from "@omniralph/planning";
import { trackerName } from "@/lib/tracker/adapters";
import { conversationFor } from "./conversation";
import { postActivity } from "./notify";
import type { OutcomeContext } from "./outcome";
import { PlannedItems } from "./relations";

/** What a reported identifier resolves to. */
export type ReportedBlocker =
  /**
   * Block the story on `blocker`; `outside` when it's another epic or a standalone task, and
   * `through` the reported task when `blocker` is its epic.
   */
  | { kind: "block"; reported: string; blocker: PlannedItem; outside: boolean; through?: string }
  /** Not a blocker: `why` says so, for the thread. */
  | { kind: "skip"; reported: string; why: string };

/**
 * What `reported` blocks `task` (a story of the run) through: itself when it's a task of the
 * task's epic, a standalone task or an epic; its epic when it's a task of another epic. The task
 * itself, its own epic, a feature and an identifier the tracker can't read are skipped.
 */
export async function resolveReportedBlocker(
  items: PlannedItems,
  task: PlannedItem,
  reported: string,
  tracker: string,
): Promise<ReportedBlocker> {
  const skip = (why: string): ReportedBlocker => ({ kind: "skip", reported, why });
  let item: PlannedItem;
  try {
    item = await items.item(reported);
  } catch {
    return skip(`I couldn't read **${reported}** in ${tracker}.`);
  }
  const askForEpic = (feature: PlannedItem) =>
    `**${feature.identifier}** is a feature, not an epic or a task: reply with the epic in it that **${task.identifier}** waits on, or block it on that epic yourself.`;
  if (item.id === task.id) return skip(`**${item.identifier}** is the task itself.`);
  if (task.parent && item.id === task.parent.id) {
    return skip(`**${item.identifier}** is the epic **${task.identifier}** belongs to.`);
  }
  if (item.role === "feature") return skip(askForEpic(item));
  if (item.role === "epic") return { kind: "block", reported, blocker: item, outside: true };
  if (!item.parent) return { kind: "block", reported, blocker: item, outside: true };
  if (task.parent && item.parent.id === task.parent.id) {
    return { kind: "block", reported, blocker: item, outside: false };
  }
  // A task of another epic: the story waits for that whole epic, never for one of its tasks.
  let epic: PlannedItem;
  try {
    epic = await items.item(item.parent.id);
  } catch {
    return skip(
      `I couldn't read **${item.parent.identifier}**, the epic of **${item.identifier}**, in ${tracker}.`,
    );
  }
  if (epic.role === "feature") return skip(askForEpic(epic));
  return { kind: "block", reported, blocker: epic, outside: true, through: item.identifier };
}

const bold = (identifier: string) => `**${identifier}**`;

/**
 * Blocks `story` on the work items its session reported it is blocked by (`reported`): one
 * blocks relation per resolved blocker, unless it exists already, and the outside ones recorded
 * as its cross-epic dependencies. Posts a thread note naming the blockers and the entries
 * skipped. Returns the identifiers of the blockers that are still open, which the story now waits
 * on (none when nothing could be resolved or every blocker is done).
 */
export async function blockOnReported(
  ctx: OutcomeContext,
  story: RalphStory,
  reported: readonly string[],
): Promise<{ waitingOn: string[] }> {
  const { tracker, run } = ctx;
  if (reported.length === 0 || !isTrackerRun(run)) return { waitingOn: [] };
  const name = trackerName(run.trackerProvider);
  const conversation = conversationFor(run, ctx);
  const items = new PlannedItems(tracker);
  let task: PlannedItem;
  let existing: Set<string>;
  try {
    task = await items.item(story.trackerIssueId);
    existing = new Set((await tracker.getBlockers(task.id)).map((b) => b.id));
  } catch (error) {
    console.warn(`${run.trackerIdentifier}: could not read ${story.identifier}'s blockers`, error);
    await postActivity(conversation, {
      type: "thought",
      body: `I couldn't read **${story.identifier}** in ${name}, so I couldn't block it on ${reported.map(bold).join(", ")}, which its session reported it is blocked by.`,
    });
    return { waitingOn: [] };
  }

  const resolved = await Promise.all(
    reported.map((identifier) => resolveReportedBlocker(items, task, identifier, name)),
  );
  const lines: string[] = [];
  const blockers = new Map<string, Extract<ReportedBlocker, { kind: "block" }>>();
  for (const entry of resolved) {
    if (entry.kind === "skip") lines.push(`I skipped ${bold(entry.reported)}: ${entry.why}`);
    else if (!blockers.has(entry.blocker.id)) blockers.set(entry.blocker.id, entry);
  }

  const blocking: string[] = [];
  const failed: string[] = [];
  const waitingOn: string[] = [];
  const outside: { id: string; identifier: string; reported: string; at: string }[] = [];
  const at = (ctx.now ?? new Date()).toISOString();
  for (const { blocker, reported: as, outside: isOutside, through } of blockers.values()) {
    if (!existing.has(blocker.id)) {
      try {
        await tracker.createBlocksRelation(blocker.id, task.id);
        existing.add(blocker.id);
      } catch (error) {
        console.warn(
          `${run.trackerIdentifier}: could not block ${story.identifier} on ${blocker.identifier}`,
          error,
        );
        failed.push(bold(blocker.identifier));
        continue;
      }
    }
    const via = through ? ` (the epic of ${bold(through)})` : "";
    blocking.push(`${bold(blocker.identifier)}${via}`);
    if (isOutside)
      outside.push({ id: blocker.id, identifier: blocker.identifier, reported: as, at });
    const state = await items.issue(blocker.id).catch(() => null);
    if (!state || !isDoneStateType(state.stateType)) waitingOn.push(blocker.identifier);
  }
  if (outside.length > 0) await recordCrossEpicBlockers(ctx.tx, story, outside);

  if (blocking.length > 0) {
    lines.unshift(
      `🔗 **${story.identifier}** is now blocked by ${blocking.join(", ")}: its session reported it needs that work first.`,
    );
  }
  if (failed.length > 0) {
    lines.push(`I couldn't block **${story.identifier}** on ${failed.join(", ")} in ${name}.`);
  }
  if (lines.length > 0)
    await postActivity(conversation, { type: "thought", body: lines.join("\n\n") });
  return { waitingOn };
}
