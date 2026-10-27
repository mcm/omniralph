import { apiHandler } from "@/lib/api/handler";
import { askMessageCreateSchema } from "@/lib/api/ask";
import { askTurnResponse, requireAskChat } from "@/lib/ask/chats";
import { askWorkItemResolver } from "@/lib/ask/work-items";
import { getChatBot } from "@/lib/chat/bot";
import { getDb } from "@/lib/db";

type Params = { id: string };

/** A turn streams for as long as Om works on it. */
export const maxDuration = 300;

/** Sends a message in the caller's chat and answers it as an event stream. */
export const POST = apiHandler<"member", typeof askMessageCreateSchema, undefined, Params>(
  { body: askMessageCreateSchema },
  async ({ user, body, params }) => {
    const db = getDb();
    const { thread } = await requireAskChat(db, user, params.id);
    return askTurnResponse(
      { db, bot: getChatBot(), workItems: askWorkItemResolver(db) },
      { thread, user, text: body.text },
    );
  },
);
