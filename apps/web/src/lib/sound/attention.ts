import type { InboxCountsResponse } from "@/lib/api/inbox";
import type { RunDetail } from "@/lib/api/runs";
import type { SoundCue } from "./player";

/** The attention cues: something new in the Inbox, or the run on screen finishing. */
export type AttentionCue = Extract<
  SoundCue,
  "notification" | "mention" | "warning" | "complete" | "error"
>;

/** The least time between two attention cues: a burst of changes plays once. */
export const ATTENTION_GAP_MS = 4_000;

type Counts = Pick<InboxCountsResponse, "needsYou" | "problems" | "questions">;

/**
 * The cue for the Inbox counts going from `previous` to `next`: Om asking a question
 * (`mention`), else something else needing you (`notification`), else a new problem
 * (`warning`). Nothing on the first counts (a page load) or when nothing was added.
 */
export function inboxCountsCue(previous: Counts | undefined, next: Counts): AttentionCue | null {
  if (!previous) return null;
  if (next.questions > previous.questions) return "mention";
  if (next.needsYou > previous.needsYou) return "notification";
  if (next.problems > previous.problems) return "warning";
  return null;
}

const LIVE: readonly RunDetail["status"][] = ["queued", "running", "waiting"];

/**
 * The cue for the run on screen changing from `previous` to `next` status while it's
 * watched: `complete` when it finishes, `error` when it fails. Nothing on the first load,
 * for a stop (someone stopped it), or for any other change.
 */
export function runOutcomeCue(
  previous: RunDetail["status"] | undefined,
  next: RunDetail["status"],
): AttentionCue | null {
  if (!previous || !LIVE.includes(previous)) return null;
  if (next === "completed") return "complete";
  if (next === "failed") return "error";
  return null;
}

/**
 * Lets an attention cue through at most once per `gapMs`: a run failing (its `error`) and
 * the Problems count rising with it (`warning`) play once. `now` is injectable for tests.
 */
export function createAttentionGate(gapMs = ATTENTION_GAP_MS, now: () => number = Date.now) {
  let last = -Infinity;
  return (): boolean => {
    const at = now();
    if (at - last < gapMs) return false;
    last = at;
    return true;
  };
}
