"use client";

import { IconBooks, IconMessage, IconPlus, IconX } from "@tabler/icons-react";
import {
  Button,
  EmptyState,
  IconButton,
  ListLoading,
  ListRow,
  MetaBadge,
  OrgBadge,
  RepoBadge,
  RowList,
} from "@omniralph/ui";
import * as React from "react";
import { useCurrentUser } from "@/components/current-user";
import type { AskChat } from "@/lib/api/ask";
import { useClock } from "@/screens/clock";
import { compactAge } from "@/screens/inbox/labels";
import { useAskChats } from "./use-ask-chats";
import "./ask-chats.css";

/** Where a chat opens as a page (`/ask/{chatId}`). */
export const askChatHref = (chatId: string) => `/ask/${encodeURIComponent(chatId)}`;

export interface AskChatsListProps {
  /** New chat (the list header's button and the empty state's action). */
  onNewChat: () => void;
  /**
   * Opens a chat in place (the desktop panel); without it, a row navigates to the chat's
   * page.
   */
  onOpenChat?: (chatId: string) => void;
  /** Close Ask (the desktop panel); no Close button without it. */
  onClose?: () => void;
  /** The "Ask" heading's level: 1 on the `/ask` page, 2 in the panel. */
  headingLevel?: 1 | 2;
  /** Moves focus to the first row (or New chat, with none) when the list shows. */
  autoFocus?: boolean;
}

const opensElsewhere = (event: React.MouseEvent) =>
  event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

/** A chat's badges: the organization (only under "All organizations"), then the repo or "All repos". */
function ChatBadges({ chat, showOrganization }: { chat: AskChat; showOrganization: boolean }) {
  return (
    <>
      {showOrganization ? <OrgBadge name={chat.organization.name} /> : null}
      {chat.repository ? (
        <RepoBadge host={chat.repository.provider} name={chat.repository.fullPath} />
      ) : (
        <MetaBadge icon={IconBooks} text="All repos" />
      )}
    </>
  );
}

/** Loads the next page when it scrolls into view. */
function LoadMore({ onVisible, loading }: { onVisible: () => void; loading: boolean }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const latest = React.useRef(onVisible);
  React.useEffect(() => {
    latest.current = onVisible;
  });
  React.useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className="or-ask-chats__more"
      aria-busy={loading || undefined}
      data-testid="ask-chats-more"
    />
  );
}

/**
 * The viewer's chats (Design boards Ask and MobileAsk): the "Ask" header with New chat (and
 * Close Ask in the panel), then one row per chat, newest activity first: its title, how
 * long ago it was active in the mono time slot, and its repo or "All repos" (led by its
 * organization under "All organizations"). More load as the list scrolls to its end. A live
 * query: chats that get a message move to the top, and chats started elsewhere appear.
 */
export function AskChatsList({
  onNewChat,
  onOpenChat,
  onClose,
  headingLevel = 2,
  autoFocus,
}: AskChatsListProps) {
  const user = useCurrentUser();
  const showOrganization = user.scope === "all";
  const now = useClock();
  const list = useAskChats();
  const chats = list.data?.pages.flatMap((page) => page.chats);
  const container = React.useRef<HTMLElement | null>(null);
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const listShown = chats !== undefined;

  React.useEffect(() => {
    if (!autoFocus || !listShown) return;
    const target =
      container.current?.querySelector<HTMLElement>(".or-row__link") ??
      container.current?.querySelector<HTMLElement>(".or-ask-chats__new");
    target?.focus();
  }, [autoFocus, listShown]);

  return (
    <section ref={container} className="or-ask-chats" aria-label="Chats">
      <header className="or-ask-chats__header">
        <Heading className="or-ask-chats__title">Ask</Heading>
        <Button
          type="button"
          variant="solid"
          size="sm"
          icon={IconPlus}
          className="or-ask-chats__new"
          onClick={onNewChat}
        >
          New chat
        </Button>
        {onClose ? (
          <IconButton type="button" label="Close Ask" icon={IconX} onClick={onClose} />
        ) : null}
      </header>
      <div className="or-ask-chats__body">
        {list.isError && !chats ? (
          <div className="or-ask-chats__error" role="alert">
            <p>Couldn&apos;t load your chats. {list.error.message}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={list.isFetching}
              onClick={() => void list.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : chats === undefined ? (
          <ListLoading label="Loading chats" />
        ) : chats.length === 0 ? (
          <EmptyState
            headingLevel={headingLevel === 1 ? 2 : 3}
            title="No chats yet"
            action={
              <Button type="button" variant="solid" size="sm" icon={IconPlus} onClick={onNewChat}>
                New chat
              </Button>
            }
          />
        ) : (
          <>
            <RowList aria-label="Chats">
              {chats.map((chat) => (
                <ListRow
                  key={chat.id}
                  href={askChatHref(chat.id)}
                  onClick={
                    onOpenChat
                      ? (event) => {
                          // A new tab or window still opens the chat's page.
                          if (opensElsewhere(event)) return;
                          event.preventDefault();
                          onOpenChat(chat.id);
                        }
                      : undefined
                  }
                  mark={<IconMessage size={16} stroke={1.75} aria-hidden="true" />}
                  title={chat.title}
                  time={<time dateTime={chat.updatedAt}>{compactAge(chat.updatedAt, now)}</time>}
                  meta={<ChatBadges chat={chat} showOrganization={showOrganization} />}
                />
              ))}
            </RowList>
            {list.hasNextPage ? (
              <LoadMore
                // A new observer per page: it reports a sentinel still in view after a load.
                key={list.data?.pages.length}
                loading={list.isFetchingNextPage}
                onVisible={() => {
                  if (!list.isFetchingNextPage) void list.fetchNextPage();
                }}
              />
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
