import { apiHandler } from "@/lib/api/handler";
import { askChatCreateSchema, askChatListQuerySchema, type AskChatList } from "@/lib/api/ask";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { askTurnResponse, loadAskChats, startAskChat } from "@/lib/ask/chats";
import { askWorkItemResolver } from "@/lib/ask/work-items";
import { getChatBot } from "@/lib/chat/bot";
import { getDb } from "@/lib/db";
import { scmAdapterFor } from "@/lib/scm/adapters";

/** A turn streams for as long as Om works on it. */
export const maxDuration = 300;

/**
 * The caller's own web chats, newest activity first: in the active organization, one of
 * the user's (`organization=<id>`) or all of them (`organization=all`).
 */
export const GET = apiHandler(
  { query: askChatListQuerySchema },
  async ({ user, query }): Promise<AskChatList> => {
    const organizations = await resolveOrganizationScope(user, query.organization);
    return loadAskChats(getDb(), user, organizations, query);
  },
);

/**
 * Starts a chat about a repo (`repositoryId`; null for all of the organization's repos)
 * with its first message, and answers it as an event stream starting with `chat`.
 */
export const POST = apiHandler({ body: askChatCreateSchema }, async ({ user, body }) => {
  const db = getDb();
  const { thread, chat } = await startAskChat({ db, adapterFor: scmAdapterFor }, user, body);
  return askTurnResponse(
    { db, bot: getChatBot(), workItems: askWorkItemResolver(db) },
    { thread, user, text: body.text, chat },
  );
});
