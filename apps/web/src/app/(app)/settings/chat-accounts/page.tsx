import type { Metadata } from "next";
import { listChatIdentities } from "@omniralph/db";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { ChatAccountsView } from "./chat-accounts-view";

export const metadata: Metadata = { title: "Chat accounts · Omniralph" };

/** The signed-in user's linked Slack and Discord accounts, in every organization. */
export default async function ChatAccountsPage() {
  const user = await requirePageUser();
  const identities = await listChatIdentities(getDb(), user.id);
  return (
    <ChatAccountsView
      identities={identities.map((i) => ({
        organizationId: i.organizationId,
        organizationName: i.organizationName,
        platform: i.platform,
        externalUserId: i.externalUserId,
        displayName: i.displayName,
        source: i.source,
        linkedAt: i.linkedAt.toISOString(),
      }))}
    />
  );
}
