import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { getCurrentUser } from "@/lib/auth/session";
import { chatLinkProblem, checkChatLink } from "@/lib/chat/link-account";
import { CHAT_LINK_PATH } from "@/lib/chat/link-paths";
import { getDb } from "@/lib/db";
import { ChatLinkView } from "./chat-link-view";

export const metadata: Metadata = { title: "Link chat account · Omniralph" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Where a chat user lands from the bot's link prompt: signed in, they confirm
 * linking the chat user to their account in the link's organization.
 */
export default async function ChatLinkPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const state = typeof params.state === "string" ? params.state : null;
  const user = await getCurrentUser();
  if (!user) {
    const back = `${CHAT_LINK_PATH}${state ? `?state=${encodeURIComponent(state)}` : ""}`;
    redirect(`${SIGN_IN_PATH}?callbackUrl=${encodeURIComponent(back)}`);
  }
  const check = await checkChatLink(getDb(), user.id, state);
  if (check.status !== "ready") return <ChatLinkView problem={chatLinkProblem(check)} />;
  return (
    <ChatLinkView
      confirmation={{
        state: state!,
        platform: check.state.platform,
        displayName: check.state.displayName,
        organizationName: check.organizationName,
        connectionName: check.connectionName,
      }}
    />
  );
}
