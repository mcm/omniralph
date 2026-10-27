"use client";

import { IconBooks, IconChevronLeft, IconPlus, IconX } from "@tabler/icons-react";
import { BranchBadge, Button, IconButton, MetaBadge, RepoBadge } from "@omniralph/ui";
import * as React from "react";
import type { AskChat as AskChatModel } from "@/lib/api/ask";
import { AskActivityLine } from "./activity-line";
import { AskMessage } from "./ask-message";
import { askDraft, setAskDraft } from "./chat-memory";
import { AskComposer } from "./composer";
import { useAskChat } from "./use-ask-chat";
import "./ask-chat.css";

/** Within this many pixels of the bottom, the list follows new messages. */
const STICK_TO_BOTTOM_PX = 24;
/** Within this many pixels of the top, the older messages load. */
const LOAD_OLDER_PX = 8;

export interface AskChatProps {
  chatId: string;
  /** ‹ Chats: back to the chats list. */
  onBack: () => void;
  /** New chat. */
  onNewChat: () => void;
  /** Close Ask (the desktop panel); no Close button without it. */
  onClose?: () => void;
  /** Moves focus to the composer when the chat opens. */
  autoFocus?: boolean;
}

/** "All repos" or the chat's repo, and its branch. */
function ChatScope({ chat }: { chat: AskChatModel }) {
  return (
    <div className="or-ask-chat__scope">
      {chat.repository ? (
        <RepoBadge host={chat.repository.provider} name={chat.repository.fullPath} />
      ) : (
        <MetaBadge icon={IconBooks} text="All repos" />
      )}
      {chat.branch ? <BranchBadge name={chat.branch} /> : null}
    </div>
  );
}

/** The chat header: ‹ Chats, the title over the repo and branch, New chat and Close Ask. */
export function AskChatHeader({
  chat,
  onBack,
  onNewChat,
  onClose,
}: Pick<AskChatProps, "onBack" | "onNewChat" | "onClose"> & { chat: AskChatModel | null }) {
  return (
    <header className="or-ask-chat__header">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        icon={IconChevronLeft}
        onClick={onBack}
        className="or-ask-chat__back"
      >
        Chats
      </Button>
      <div className="or-ask-chat__heading">
        <h2 className="or-ask-chat__title">{chat?.title ?? "Ask"}</h2>
        {chat ? <ChatScope chat={chat} /> : null}
      </div>
      <div className="or-ask-chat__tools">
        <IconButton type="button" label="New chat" icon={IconPlus} onClick={onNewChat} />
        {onClose ? (
          <IconButton type="button" label="Close Ask" icon={IconX} onClick={onClose} />
        ) : null}
      </div>
    </header>
  );
}

/** The chat's first load: a skeleton, or what went wrong with Retry. */
function ChatLoading({ query }: { query: ReturnType<typeof useAskChat>["query"] }) {
  if (query.isError) {
    return (
      <div className="or-ask-chat__error" role="alert">
        <p>Couldn&apos;t load the chat. {query.error.message}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  return <ChatSkeleton />;
}

function ChatSkeleton() {
  return (
    <div className="or-ask-chat__skeleton" aria-busy="true" aria-label="Loading the chat">
      <div className="or-ask-chat__skeleton-line" />
      <div className="or-ask-chat__skeleton-line or-ask-chat__skeleton-line--short" />
    </div>
  );
}

/**
 * A chat with Om: the header, the messages (older ones load when the list is scrolled to
 * the top; a new message scrolls to the bottom unless the member has scrolled up), the
 * "Om is reading" line while an ask runs, and the composer pinned at the bottom. Om's reply
 * streams in as it is written; later answers (an ask's code answer, a card's new state)
 * arrive through the live data layer. The draft is kept per chat while the view is away.
 */
export function AskChat(props: AskChatProps) {
  return <AskChatView key={props.chatId} {...props} />;
}

function AskChatView({ chatId, onBack, onNewChat, onClose, autoFocus }: AskChatProps) {
  const ask = useAskChat(chatId);
  const [draft, setDraft] = React.useState(() => askDraft(chatId));
  const list = React.useRef<HTMLDivElement | null>(null);
  const composer = React.useRef<HTMLTextAreaElement | null>(null);
  // Whether the list follows new messages: until the member scrolls up.
  const pinned = React.useRef(true);
  // The list's height before older messages loaded, to keep the view where it was.
  const heightBeforeOlder = React.useRef<number | null>(null);

  const changeDraft = (text: string) => {
    setDraft(text);
    setAskDraft(chatId, text);
  };

  const send = async () => {
    const text = draft;
    changeDraft("");
    pinned.current = true;
    const result = await ask.send(text);
    // Nothing reached Om: give the text back, unless the member has typed since.
    if (result === "failed" && !askDraft(chatId)) changeDraft(text);
  };

  React.useEffect(() => {
    if (autoFocus) composer.current?.focus();
  }, [autoFocus]);

  const { messages, activity } = ask;
  const last = messages.at(-1);
  const first = messages[0];
  const followKey = `${messages.length}:${last?.id}:${last?.markdown.length}:${activity?.state}:${ask.status}`;

  React.useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    if (heightBeforeOlder.current !== null && !ask.loadingOlder) {
      element.scrollTop = element.scrollHeight - heightBeforeOlder.current + element.scrollTop;
      heightBeforeOlder.current = null;
      return;
    }
    if (pinned.current) element.scrollTop = element.scrollHeight;
  }, [followKey, first?.id, ask.loadingOlder]);

  const onScroll = () => {
    const element = list.current;
    if (!element) return;
    pinned.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_TO_BOTTOM_PX;
    if (element.scrollTop <= LOAD_OLDER_PX && ask.hasOlder && !ask.loadingOlder) {
      heightBeforeOlder.current = element.scrollHeight;
      ask.loadOlder();
    }
  };

  const streamingMessage = messages.some((m) => m.author === "om" && m.status === "streaming");

  return (
    <section className="or-ask-chat" aria-label={ask.chat?.title ?? "Chat"}>
      <AskChatHeader chat={ask.chat} onBack={onBack} onNewChat={onNewChat} onClose={onClose} />
      <div
        ref={list}
        className="or-ask-chat__messages"
        onScroll={onScroll}
        aria-busy={ask.loadingOlder || undefined}
      >
        {ask.query.data === undefined ? (
          <ChatLoading query={ask.query} />
        ) : (
          <>
            {messages.map((message) => (
              <AskMessage
                key={message.id}
                message={message}
                status={message.status === "streaming" ? ask.status : null}
                onAction={(click) => ask.act(message.id, click)}
                {...ask.actionState(message.id)}
              />
            ))}
            {ask.status && !streamingMessage ? (
              <p className="or-ask-chat__status" role="status">
                {ask.status}
              </p>
            ) : null}
            {activity ? <AskActivityLine activity={activity} /> : null}
          </>
        )}
      </div>
      <AskComposer
        value={draft}
        onChange={changeDraft}
        onSend={() => void send()}
        streaming={ask.streaming}
        textareaRef={composer}
      />
    </section>
  );
}
