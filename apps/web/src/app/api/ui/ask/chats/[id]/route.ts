import { apiHandler } from "@/lib/api/handler";
import { askChatQuerySchema, type AskChatDetail } from "@/lib/api/ask";
import { loadAskChat, requireAskChat } from "@/lib/ask/chats";
import { askWorkItemResolver } from "@/lib/ask/work-items";
import { getDb } from "@/lib/db";

type Params = { id: string };

/**
 * The caller's chat: its latest messages (`before=<message id>` for older ones), oldest
 * first, and its in-flight ask. Another member's chat is not found.
 */
export const GET = apiHandler<"member", undefined, typeof askChatQuerySchema, Params>(
  { query: askChatQuerySchema },
  async ({ user, query, params }): Promise<AskChatDetail> => {
    const db = getDb();
    const { thread, organization } = await requireAskChat(db, user, params.id);
    return loadAskChat({ db, workItems: askWorkItemResolver(db) }, thread, organization, query);
  },
);
