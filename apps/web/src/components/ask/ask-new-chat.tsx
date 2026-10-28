"use client";

import { Field, Select } from "@omniralph/ui";
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

function parseChoice(value: string): AskScopeChoice {
  const [organizationId = "", repositoryId = "all"] = value.split(":");
  return { organizationId, repositoryId: repositoryId === "all" ? null : repositoryId };
}

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

/** The picker's options: "All repos" then each repo, or one group per organization. */
function RepoOptions({
  user,
  repositories,
}: {
  user: SessionUser;
  repositories: readonly AskRepositoryOption[];
}) {
  const option = (repository: AskRepositoryOption) => (
    <option
      key={repository.id}
      value={choiceValue({
        organizationId: repository.organization.id,
        repositoryId: repository.id,
      })}
    >
      {repository.fullPath}
    </option>
  );
  if (user.scope !== "all") {
    return (
      <>
        <option value={choiceValue({ organizationId: user.organization.id, repositoryId: null })}>
          All repos
        </option>
        {repositories.filter((r) => r.organization.id === user.organization.id).map(option)}
      </>
    );
  }
  return (
    <>
      {user.organizations.map((organization) => (
        <optgroup key={organization.id} label={organization.name}>
          <option value={choiceValue({ organizationId: organization.id, repositoryId: null })}>
            All repos in {organization.name}
          </option>
          {repositories.filter((r) => r.organization.id === organization.id).map(option)}
        </optgroup>
      ))}
    </>
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
 * New chat (Design board Ask): the "Repo" picker ("All repos" first, then every repo of the
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
        <Field label="Repo" stacked>
          <Select
            value={choiceValue(choice)}
            disabled={sending !== null}
            onChange={(event) => setPicked(parseChoice(event.target.value))}
          >
            <RepoOptions user={user} repositories={options ?? []} />
          </Select>
        </Field>
        {repositories.isError ? (
          <p className="or-ask-new__note" role="alert">
            Couldn&apos;t load the repos. {repositories.error.message}
          </p>
        ) : null}
        {sending !== null ? <UserBubble text={sending} /> : null}
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
