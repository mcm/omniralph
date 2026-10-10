/**
 * Best-effort Linear writes of the ralph orchestrator: an activity or a story
 * comment that fails to post is logged, never allowed to undo a run's state
 * change (cyralph treats them the same way).
 */
import type { ActivityContent, ActivityOptions, LinearGateway } from "@/lib/linear/gateway";

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Runs a Linear write, logging (not throwing) a failure. Returns whether it worked. */
export async function quietly(what: string, write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error) {
    console.warn(`${what} failed: ${errorMessage(error)}`);
    return false;
  }
}

/**
 * Posts an activity to an agent session, logging a failure. A run without a
 * Linear session (`linearSessionOf` of a chat run) posts nothing here.
 */
export async function postActivity(
  linear: LinearGateway,
  sessionId: string | null,
  content: ActivityContent,
  options?: ActivityOptions,
): Promise<boolean> {
  if (sessionId === null) return false;
  return quietly(`Posting a Linear ${content.type} activity to session ${sessionId}`, () =>
    linear.createActivity(sessionId, content, options),
  );
}

/** The end of a long text, marked as cut. */
export function tail(text: string, n: number): string {
  return text.length > n ? `…${text.slice(-n)}` : text;
}

/** Text as a markdown quote. */
export function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
