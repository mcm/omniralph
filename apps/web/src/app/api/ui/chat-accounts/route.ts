import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { loadChatAccounts } from "@/lib/chat/accounts";

/** Settings › Linked chat accounts: the caller's own linked chat accounts, in every organization. */
export const GET = apiHandler({}, async ({ user }) => ({
  identities: await loadChatAccounts(getDb(), user.id),
}));
