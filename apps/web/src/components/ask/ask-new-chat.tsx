"use client";

import { BrandMark, EmptyState, Field, Menu, type MenuAction, type MenuItem } from "@omniralph/ui";
import { IconBooks, IconChevronDown, IconMessage } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useCurrentUser, type SessionUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import type { AskChat, AskRepositoryOption } from "@/lib/api/ask";
import { askKeys } from "@/lib/api/keys";
import { AskChatHeader } from "./ask-chat";
import { useAskContextRepositoryId } from "./ask-context";
import { askDraft, setAskDraft } from "./chat-memory";
import { AskComposer } from "./composer";
import { repoShortName } from "./format";
import { runAskTurn } from "./turn";
import { addChatToLists, useAskRepositories } from "./use-ask-chats";
import { UserBubble } from "./user-bubble";
import "./ask-chats.css";

/** The composer draft of New chat, kept like a chat's while the view is away. */
export const NEW_CHAT_DRAFT = "new";

/** What the picker holds: an organization's repo, or all of its repos (`repositoryId` null). */
export interface AskScopeChoice {
  organizationId: string;
  repositoryId: string | null;
}

const choiceValue = ({ organizationId, repositoryId }: AskScopeChoice) =>
  `${organizationId}:${repositoryId ?? "all"}`;

/**
 * The picker's first choice: the page's repo when a new chat can pick it (connected, with
 * Ask on), else all of the active organization's repos.
 */
export function defaultAskChoice(
  user: Pick<SessionUser, "organization">,
  repositories: readonly AskRepositoryOption[] | undefined,
  contextRepositoryId: string | null,
): AskScopeChoice {
  const repository = contextRepositoryId
    ? repositories?.find((option) => option.id === contextRepositoryId)
    : undefined;
  return repository
    ? { organizationId: repository.organization.id, repositoryId: repository.id }
    : { organizationId: user.organization.id, repositoryId: null };
}

/** The composer's placeholder for a new chat about `repository` (null: all repos). */
export function newChatPlaceholder(repository: Pick<AskRepositoryOption, "fullPath"> | null) {
  return repository ? `Ask about ${repoShortName(repository.fullPath)}…` : "Ask about your repos…";
}

/** The picker's label for a choice: "All repos", "All repos in Acme" or the repo's path. */
function choiceLabel(
  user: SessionUser,
  choice: AskScopeChoice,
  repository: AskRepositoryOption | null,
): string {
  if (repository) return repository.fullPath;
  if (user.scope !== "all") return "All repos";
  const organization = user.organizations.find((entry) => entry.id === choice.organizationId);
  return organization ? `All repos in ${organization.name}` : "All repos";
}

/**
 * The picker's choices: "All repos" then each repo, or one group per organization under "All
 * organizations". Every repo carries its code host's mark (Design rule 1), "All repos" the
 * All repos icon.
 */
function repoMenuItems(
  user: SessionUser,
  repositories: readonly AskRepositoryOption[],
  chosen: string,
  onPick: (choice: AskScopeChoice) => void,
): MenuItem[] {
  const item = (choice: AskScopeChoice, label: string, group?: string): MenuAction => ({
    label,
    checked: choiceValue(choice) === chosen,
    onSelect: () => onPick(choice),
    ...(group === undefined ? {} : { group }),
  });
  const repoItems = (organizationId: string, group?: string) =>
    repositories
      .filter((repository) => repository.organization.id === organizationId)
      .map((repository): MenuItem => ({
        ...item({ organizationId, repositoryId: repository.id }, repository.fullPath, group),
        mark: <BrandMark brand={repository.provider} />,
      }));
  if (user.scope !== "all") {
    const organizationId = user.organization.id;
    return [
      { ...item({ organizationId, repositoryId: null }, "All repos"), icon: IconBooks },
      ...repoItems(organizationId),
    ];
  }
  return user.organizations.flatMap(({ id, name }) => [
    {
      ...item({ organizationId: id, repositoryId: null }, `All repos in ${name}`, name),
      icon: IconBooks,
    },
    ...repoItems(id, name),
  ]);
}

/**
 * The "Repo" picker: a `Menu` drawn like a `Select` (led by the chosen repo's host mark, or
 * the All repos icon), since a native select's options can't carry marks.
 */
function RepoPicker({
  user,
  repositories,
  choice,
  repository,
  disabled,
  onPick,
}: {
  user: SessionUser;
  repositories: readonly AskRepositoryOption[];
  choice: AskScopeChoice;
  repository: AskRepositoryOption | null;
  disabled: boolean;
  onPick: (choice: AskScopeChoice) => void;
}) {
  const id = React.useId();
  const label = choiceLabel(user, choice, repository);
  return (
    <Field label="Repo" htmlFor={id} stacked className="or-ask-new__repo">
      <span className="or-select">
        <span className="or-select__leading" aria-hidden="true">
          {repository ? (
            <BrandMark brand={repository.provider} />
          ) : (
            <IconBooks size={14} stroke={1.75} />
          )}
        </span>
        <Menu
          align="start"
          disabled={disabled}
          items={repoMenuItems(user, repositories, choiceValue(choice), onPick)}
          trigger={
            <button
              id={id}
              type="button"
              className="or-input or-select__control or-select__control--leading or-ask-new__repo-button"
              aria-label={`Repo: ${label}`}
            >
              {label}
            </button>
          }
        />
        <IconChevronDown className="or-select__chevron" size={16} stroke={1.75} aria-hidden />
      </span>
    </Field>
  );
}

export interface AskNewChatProps {
  /** ‹ Chats: back to the chats list. */
  onBack: () => void;
  /**
   * The new chat exists (its `chat` event, before Om answers): show it. Its reply keeps
   * streaming into the chat's view.
   */
  onChatStarted: (chat: AskChat) => void;
  /** Close Ask (the desktop panel); no Close button without it. */
  onClose?: () => void;
  /** Preselects this repo (`/ask/new?repository=`) over the page's. */
  repositoryId?: string | null;
  /** Moves focus to the composer when the view opens. */
  autoFocus?: boolean;
  /** The title's heading level: 1 when New chat is the page (`/ask/new`), else 2. */
  headingLevel?: 1 | 2;
}

/**
 * New chat (Design board Ask): the "Repo" picker (led by the chosen repo's host mark, or the
 * All repos icon; at most 480 px wide) ("All repos" first, then every repo of the
 * organization a chat can ask about; grouped per organization under "All organizations"),
 * starting on the repo of the page the member is on, and the composer. Sending the first
 * message starts the chat (`POST /api/ui/ask/chats`): it goes to the top of the chats list
 * and `onChatStarted` switches to it, where Om's reply streams. From then on the chat's repo
 * is fixed: its header shows it as a badge.
 */
export function AskNewChat({
  onBack,
  onChatStarted,
  onClose,
  repositoryId,
  autoFocus,
  headingLevel,
}: AskNewChatProps) {
  const user = useCurrentUser();
  const client = useQueryClient();
  const keys = useQueryKeys();
  const repositories = useAskRepositories();
  const contextRepositoryId = useAskContextRepositoryId();
  const [picked, setPicked] = React.useState<AskScopeChoice | null>(null);
  const [draft, setDraft] = React.useState(() => askDraft(NEW_CHAT_DRAFT));
  const [sending, setSending] = React.useState<string | null>(null);
  const composer = React.useRef<HTMLTextAreaElement | null>(null);
  const started = React.useRef(onChatStarted);
  React.useEffect(() => {
    started.current = onChatStarted;
  });

  const options = repositories.data?.repositories;
  const choice = picked ?? defaultAskChoice(user, options, repositoryId ?? contextRepositoryId);
  const repository =
    choice.repositoryId === null
      ? null
      : (options?.find((option) => option.id === choice.repositoryId) ?? null);

  const changeDraft = (text: string) => {
    setDraft(text);
    setAskDraft(NEW_CHAT_DRAFT, text);
  };

  React.useEffect(() => {
    if (autoFocus) composer.current?.focus();
  }, [autoFocus]);

  const send = async () => {
    const written = draft;
    const text = written.trim();
    if (!text || sending !== null) return;
    changeDraft("");
    setSending(text);
    const result = await runAskTurn({
      client,
      chatKey: askKeys(keys).chat,
      chatId: null,
      path: "/api/ui/ask/chats",
      body: {
        organizationId: choice.organizationId,
        repositoryId: choice.repositoryId,
        text,
      },
      text,
      organizationId: user.organization.id,
      onChat: (chat) => {
        addChatToLists(client, keys, chat);
        started.current(chat);
      },
    });
    setSending(null);
    // No chat was started: give the text back, unless the member has typed since.
    if (result === "failed" && !askDraft(NEW_CHAT_DRAFT)) changeDraft(written);
  };

  const newChat = () => {
    changeDraft("");
    setPicked(null);
    composer.current?.focus();
  };

  return (
    <section className="or-ask-chat or-ask-new" aria-label="New chat">
      <AskChatHeader
        chat={null}
        onBack={onBack}
        onNewChat={newChat}
        onClose={onClose}
        headingLevel={headingLevel}
      />
      <div className="or-ask-chat__messages">
        <RepoPicker
          user={user}
          repositories={options ?? []}
          choice={choice}
          repository={repository}
          disabled={sending !== null}
          onPick={setPicked}
        />
        {repositories.isError ? (
          <p className="or-ask-new__note" role="alert">
            Couldn&apos;t load the repos. {repositories.error.message}
          </p>
        ) : null}
        {sending !== null ? (
          <UserBubble text={sending} />
        ) : (
          <EmptyState
            className="or-ask-new__empty"
            icon={IconMessage}
            headingLevel={headingLevel === 1 ? 2 : 3}
            // The composer already says "Ask about …": the title says what an answer is.
            title="Answers come from your code"
            description={`Om reads ${repository ? repoShortName(repository.fullPath) : "your repos"} and cites the files it used.`}
          />
        )}
      </div>
      <AskComposer
        value={draft}
        onChange={changeDraft}
        onSend={() => void send()}
        streaming={sending !== null}
        placeholder={newChatPlaceholder(repository)}
        textareaRef={composer}
      />
    </section>
  );
}
