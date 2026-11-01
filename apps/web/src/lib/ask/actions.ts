import "server-only";
import { getWebMessage, type ChatThread } from "@omniralph/db";
import { isCardElement, type CardChild, type CardElement } from "chat";
import type { AskCardActionRequest, AskMessageView } from "@/lib/api/ask";
import { ApiRouteError } from "@/lib/api/handler";
import type { OrgUser } from "@/lib/auth/session";
import type { ChatBot } from "@/lib/chat/bot";
import { askMessages, type AskMessagesDeps } from "./messages";

/**
 * A click on a card's button in a web chat: dispatched through the bot
 * (`chat.processAction` for the web adapter), so the request draft and work item draft
 * handlers run as they do for a Slack click.
 */

export const UNKNOWN_CARD_ACTION_MESSAGE = "That card has no such button anymore.";

/** The button `actionId` of a stored card, or null. */
function cardButton(children: readonly CardChild[], actionId: string): { value?: string } | null {
  for (const child of children) {
    if (child.type === "section") {
      const found = cardButton(child.children, actionId);
      if (found) return found;
    }
    if (child.type !== "actions") continue;
    for (const element of child.children) {
      if (element.type === "button" && element.id === actionId) return element;
    }
  }
  return null;
}

export interface AskCardActionDeps extends AskMessagesDeps {
  bot: Pick<ChatBot, "chat" | "adapters">;
}

/**
 * Dispatches `action` on a card of `thread` (the caller's chat) and returns its message as
 * it stands once every handler finished. Not found for a message of another chat or without
 * a card; 400 when the card has no such button.
 */
export async function askCardAction(
  deps: AskCardActionDeps,
  thread: ChatThread,
  user: Pick<OrgUser, "id" | "name" | "email">,
  action: AskCardActionRequest,
): Promise<AskMessageView> {
  const { db, bot } = deps;
  const row = await getWebMessage(db, action.messageId);
  if (!row || row.threadId !== thread.id || !isCardElement(row.card)) {
    throw ApiRouteError.notFound();
  }
  const button = cardButton((row.card as CardElement).children, action.actionId);
  const adapter = bot.adapters.web;
  if (!button || !adapter) {
    throw new ApiRouteError(400, UNKNOWN_CARD_ACTION_MESSAGE, "unknown_action");
  }
  const work: Promise<unknown>[] = [];
  await bot.chat.processAction(
    {
      adapter,
      actionId: action.actionId,
      value: action.value ?? button.value,
      messageId: row.id,
      threadId: thread.externalThreadId,
      user: {
        userId: user.id,
        userName: user.email ?? user.id,
        fullName: user.name ?? user.email ?? user.id,
        isBot: false,
        isMe: false,
      },
      raw: action,
    },
    { waitUntil: (task) => void work.push(task) },
  );
  await Promise.all(work);
  const updated = (await getWebMessage(db, row.id)) ?? row;
  const [message] = await askMessages(deps, thread, [updated]);
  return message!;
}
