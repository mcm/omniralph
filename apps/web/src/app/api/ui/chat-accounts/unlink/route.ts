import { apiHandler } from "@/lib/api/handler";
import { unlinkChatAccountSchema } from "@/lib/api/organization";
import { getDb } from "@/lib/db";
import { unlinkChatAccount } from "@/lib/chat/accounts";

/** Unlinks one of the caller's own chat accounts (in any of their organizations). */
export const POST = apiHandler({ body: unlinkChatAccountSchema }, async ({ user, body }) =>
  unlinkChatAccount(getDb(), user.id, body),
);
