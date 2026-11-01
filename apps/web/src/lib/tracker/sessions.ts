import { randomUUID } from "node:crypto";
import { hasCapability, type TrackerGateway } from "@omniralph/tracker";

/** The prefix of a conversation ID on a tracker without sessions (it lives in comments). */
export const COMMENT_CONVERSATION_PREFIX = "comments:";

/**
 * Opens a conversation on the issue for Om to report in: a new agent session where the
 * tracker has sessions, else a fresh ID for a conversation held in the issue's comments
 * (`trackerConversation` with the issue's ID comments there).
 */
export async function openIssueConversation(
  gateway: TrackerGateway,
  issueId: string,
): Promise<string> {
  if (hasCapability(gateway, "sessions")) return gateway.sessions.createSessionOnIssue(issueId);
  return `${COMMENT_CONVERSATION_PREFIX}${randomUUID()}`;
}
