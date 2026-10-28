"use client";

import { useRouter } from "next/navigation";
import { AskChat } from "./ask-chat";
import { askChatHref } from "./ask-chats-list";
import { AskNewChat } from "./ask-new-chat";
import "./ask-page.css";

/** The chats list page, the tab's root. */
export const ASK_HREF = "/ask";
/** The New chat page (`?repository=` preselects a repo). */
export const ASK_NEW_HREF = "/ask/new";

/**
 * Whether the path is an Ask page that opens full screen on a phone (New chat and a chat):
 * no tab bar, the chat header at the top and the composer pinned at the bottom. The chats
 * list (`/ask`) is the tab's root and keeps the tab bar.
 */
export function isAskFullScreenPath(pathname: string): boolean {
  return /^\/ask\/[^/]+\/?$/.test(pathname);
}

/** `/ask/new`: New chat as the page; the started chat replaces it in the history. */
export function AskNewChatPage({ repositoryId }: { repositoryId: string | null }) {
  const router = useRouter();
  return (
    <div className="or-ask-page or-ask-page--full">
      <AskNewChat
        headingLevel={1}
        repositoryId={repositoryId}
        onBack={() => router.push(ASK_HREF)}
        onChatStarted={(chat) => router.replace(askChatHref(chat.id))}
        autoFocus
      />
    </div>
  );
}

/** `/ask/{chatId}`: the chat as the page, with ‹ Chats and New chat (no Close). */
export function AskChatPage({ chatId }: { chatId: string }) {
  const router = useRouter();
  return (
    <div className="or-ask-page or-ask-page--full">
      <AskChat
        chatId={chatId}
        headingLevel={1}
        onBack={() => router.push(ASK_HREF)}
        onNewChat={() => router.push(ASK_NEW_HREF)}
      />
    </div>
  );
}
