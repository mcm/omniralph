"use client";

import { useRouter } from "next/navigation";
import { AskChatsList } from "./ask-chats-list";

/** The `/ask` page: the chats list as the page's main content, its rows opening `/ask/{id}`. */
export function AskChatsPage() {
  const router = useRouter();
  return <AskChatsList headingLevel={1} onNewChat={() => router.push("/ask/new")} />;
}
