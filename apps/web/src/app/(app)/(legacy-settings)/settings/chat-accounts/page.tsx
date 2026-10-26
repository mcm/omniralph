import type { Metadata } from "next";
import { ChatAccountsView } from "./chat-accounts-view";

export const metadata: Metadata = { title: "Chat accounts · Omniralph" };

/** The signed-in user's linked Slack and Discord accounts, in every organization. */
export default function ChatAccountsPage() {
  return <ChatAccountsView />;
}
