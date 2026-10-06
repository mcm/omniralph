/**
 * Ralph task selection: pick the highest-priority open story whose dependencies are all done.
 * In-progress first, then priority (Linear's: Urgent first, no priority last), then the epic's
 * sub-issue order in Linear, then the story id (natural sort).
 */
import { NO_PRIORITY_RANK } from "./story-body.js";
import type { Story } from "./types.js";

const DONE = new Set(["completed", "cancelled"]);

export function isStoryDone(story: Story): boolean {
  return DONE.has(story.status);
}

export function isStoryReady(story: Story, stories: Story[]): boolean {
  // Manual stories are done by a person, never selected for the agent; exhausted ones wait for help.
  if (isStoryDone(story) || story.manual || story.exhausted) return false;
  const byKey = new Map(stories.map((s) => [s.key, s]));
  return story.dependsOn.every((dep) => {
    const s = byKey.get(dep);
    // Unknown/external blockers are resolved by the loader: anything left unresolved blocks.
    return s ? isStoryDone(s) : false;
  });
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Linear's "No priority" (0) sorts after every prioritized story. */
function rank(story: Story): number {
  return story.priority > 0 ? story.priority : NO_PRIORITY_RANK;
}

export function sortStories(stories: Story[]): Story[] {
  return [...stories].sort(
    (a, b) =>
      Number(b.status === "in_progress") - Number(a.status === "in_progress") ||
      rank(a) - rank(b) ||
      (a.sortOrder ?? Number.POSITIVE_INFINITY) - (b.sortOrder ?? Number.POSITIVE_INFINITY) ||
      naturalCompare(a.storyId, b.storyId),
  );
}

/**
 * The next story to run: ready (not done, manual, exhausted or blocked) and not in `exclude`
 * (keys of stories set aside for this pass, e.g. exhausted ones).
 */
export function selectNextStory(
  stories: Story[],
  exclude: ReadonlySet<string> = new Set(),
): Story | undefined {
  return sortStories(stories).find((s) => !exclude.has(s.key) && isStoryReady(s, stories));
}

export function isEpicComplete(stories: Story[]): boolean {
  return stories.every(isStoryDone);
}

/** Open stories that can never become ready given the excluded (exhausted) set. */
export function blockedStories(stories: Story[], exclude: ReadonlySet<string>): Story[] {
  const byKey = new Map(stories.map((s) => [s.key, s]));
  const excluded = (s: Story) => exclude.has(s.key) || s.exhausted === true;
  const memo = new Map<string, boolean>();
  const reachable = (s: Story, seen: Set<string>): boolean => {
    if (isStoryDone(s)) return true;
    if (excluded(s) || seen.has(s.key)) return false;
    const cached = memo.get(s.key);
    if (cached !== undefined) return cached;
    seen.add(s.key);
    const ok = s.dependsOn.every((d) => {
      const dep = byKey.get(d);
      return dep ? reachable(dep, seen) : false;
    });
    seen.delete(s.key);
    memo.set(s.key, ok);
    return ok;
  };
  return stories.filter((s) => !isStoryDone(s) && !excluded(s) && !reachable(s, new Set()));
}
