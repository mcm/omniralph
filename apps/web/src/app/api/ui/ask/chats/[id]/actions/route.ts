import { apiHandler } from "@/lib/api/handler";
import { askCardActionRequestSchema, type AskCardActionResponse } from "@/lib/api/ask";
import { askCardAction } from "@/lib/ask/actions";
import { requireAskChat } from "@/lib/ask/chats";
import { askWorkItemResolver } from "@/lib/ask/work-items";
import { getChatBot } from "@/lib/chat/bot";
import { getDb } from "@/lib/db";

type Params = { id: string };

/** Starting a request runs until its run is created. */
export const maxDuration = 300;

/**
 * A click on a card's button in the caller's chat (Start request, Not now, a Linear issue
 * draft's Create or Cancel): handled as the same click on Slack is, then the card's message as
 * it stands.
 */
export const POST = apiHandler<"member", typeof askCardActionRequestSchema, undefined, Params>(
  { body: askCardActionRequestSchema },
  async ({ user, body, params }): Promise<AskCardActionResponse> => {
    const db = getDb();
    const { thread } = await requireAskChat(db, user, params.id);
    const message = await askCardAction(
      { db, bot: getChatBot(), workItems: askWorkItemResolver(db) },
      thread,
      user,
      body,
    );
    return { message };
  },
);
