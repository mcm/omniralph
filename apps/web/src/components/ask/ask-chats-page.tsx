"use client";

import { useRouter } from "next/navigation";
import { AskChatsList } from "./ask-chats-list";
import { ASK_NEW_HREF } from "./ask-pages";
import "./ask-page.css";

/**
 * The `/ask` page (the phone's Ask tab root, MobileAsk): the "Ask" heading, New chat and the
 * chats list as the page's main content, its rows opening `/ask/{id}`.
 */
export function AskChatsPage() {
  const router = useRouter();
  return (
    <div className="or-ask-page">
      <AskChatsList headingLevel={1} onNewChat={() => router.push(ASK_NEW_HREF)} />
    </div>
  );
}
