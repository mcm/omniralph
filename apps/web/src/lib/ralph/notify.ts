/**
 * Best-effort tracker writes of the ralph orchestrator: an activity or a story
 * comment that fails to post is logged, never allowed to undo a run's state
 * change (cyralph treats them the same way).
 */
import type { ActivityContent } from "@omniralph/tracker";
import type { PostOptions, RunConversation } from "./conversation";

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Runs a tracker write, logging (not throwing) a failure. Returns whether it worked. */
export async function quietly(what: string, write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error) {
    console.warn(`${what} failed: ${errorMessage(error)}`);
    return false;
  }
}

/** Posts an activity to a run's conversation (`conversationFor`), logging a failure. */
export async function postActivity(
  conversation: RunConversation,
  content: ActivityContent,
  options?: PostOptions,
): Promise<boolean> {
  return quietly(`Posting an activity (${content.type}) to ${conversation.name}`, () =>
    conversation.post(content, options),
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
