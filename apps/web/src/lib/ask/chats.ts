import "server-only";
import {
  createWebChatThread,
  getChatThread,
  getRepository,
  getRepositoryWithConnection,
  getWebMessage,
  listConnectedRepositories,
  listWebChats,
  listWebMessages,
  webChatTitle,
  type ChatThread,
  type Database,
  type Repository,
  type ScmConnection,
} from "@omniralph/db";
import type { ScmAdapter } from "@omniralph/scm";
import { after } from "next/server";
import { z } from "zod";
import {
  ASK_MESSAGE_PAGE_SIZE,
  encodeAskChatCursor,
  type AskChat,
  type AskChatDetail,
  type AskChatList,
  type AskMessageView,
  type AskRepositoryList,
} from "@/lib/api/ask";
import { ApiRouteError } from "@/lib/api/handler";
import { membership, type ScopedOrganization } from "@/lib/api/scope";
import type { OrgUser } from "@/lib/auth/session";
import {
  handleWebMessage,
  recordWebChatChange,
  type HandleWebMessageDeps,
} from "@/lib/chat/web-adapter";
import { sendWebEvent, webEventStream } from "@/lib/chat/web-stream";
import { liveWaitUntil } from "@/lib/live/request";
import { fetchDefaultBranch } from "@/lib/repositories/default-branch";
import type { AskStreamEventName, AskStreamEvents } from "./sse";
import { askActivity, askMessages, type AskMessagesDeps } from "./messages";

/**
 * Ask's chats (`/api/ui/ask/**`): a web chat is private to the member who started it, in
 * an organization they are still a member of. Sending a message answers with the turn as
 * server-sent events, from the web adapter and the handler (`lib/chat/web-stream.ts`).
 */

/** Most repos a new chat offers (the Repos rail's limit). */
export const ASK_REPOSITORY_LIMIT = 500;

/** A repo as a chat shows it. */
type RepositoryRef = Pick<Repository, "id" | "provider" | "fullPath">;

const repositoryRef = (repository: RepositoryRef) => ({
  id: repository.id,
  provider: repository.provider,
  fullPath: repository.fullPath,
});

/** A web chat as the chats list and the chat header show it. */
export function askChatView(
  thread: ChatThread,
  organization: ScopedOrganization,
  repository: RepositoryRef | null,
): AskChat {
  return {
    id: thread.id,
    title: thread.title ?? "",
    organization,
    repository: repository && repositoryRef(repository),
    branch: thread.branch,
    updatedAt: thread.updatedAt.toISOString(),
  };
}

/** The repos of `threads`, by ID (a removed repo is missing). */
async function chatRepositories(
  db: Database,
  threads: readonly ChatThread[],
): Promise<Map<string, Repository>> {
  const ids = [...new Set(threads.flatMap((t) => (t.repositoryId ? [t.repositoryId] : [])))];
  const found = await Promise.all(ids.map((id) => getRepository(db, id)));
  return new Map(found.flatMap((repository) => (repository ? [[repository.id, repository]] : [])));
}

async function chatView(
  db: Database,
  thread: ChatThread,
  organization: ScopedOrganization,
): Promise<AskChat> {
  const repositories = await chatRepositories(db, [thread]);
  return askChatView(
    thread,
    organization,
    (thread.repositoryId && repositories.get(thread.repositoryId)) || null,
  );
}

/** A page of the member's own web chats in `organizations`, newest activity first. */
export async function loadAskChats(
  db: Database,
  user: Pick<OrgUser, "id">,
  organizations: readonly ScopedOrganization[],
  page: { cursor?: { updatedAt: string; id: string }; limit: number },
): Promise<AskChatList> {
  const byId = new Map(organizations.map((o) => [o.id, o]));
  const { chats, next } = await listWebChats(db, {
    userId: user.id,
    organizationIds: [...byId.keys()],
    cursor: page.cursor ?? null,
    limit: page.limit,
  });
  const repositories = await chatRepositories(db, chats);
  return {
    chats: chats.map((thread) =>
      askChatView(
        thread,
        byId.get(thread.organizationId)!,
        (thread.repositoryId && repositories.get(thread.repositoryId)) || null,
      ),
    ),
    nextCursor: next && encodeAskChatCursor(next),
  };
}

/**
 * The web chat `chatId` of the caller, with their membership of its organization. Not found
 * for anything else: an unknown ID, a Slack or Discord thread, another member's chat, or a
 * chat of an organization the caller has left.
 */
export async function requireAskChat(
  db: Database,
  user: OrgUser,
  chatId: string,
): Promise<{ thread: ChatThread; organization: ScopedOrganization }> {
  const thread = z.uuid().safeParse(chatId).success ? await getChatThread(db, chatId) : null;
  if (!thread || thread.platform !== "web" || thread.startedByUserId !== user.id) {
    throw ApiRouteError.notFound();
  }
  const organization = await membership(user, thread.organizationId);
  if (!organization) throw ApiRouteError.notFound();
  return { thread, organization };
}

/** A chat with its latest messages (older than `before`), and its in-flight ask. */
export async function loadAskChat(
  deps: AskMessagesDeps,
  thread: ChatThread,
  organization: ScopedOrganization,
  { before }: { before?: string } = {},
): Promise<AskChatDetail> {
  const { db } = deps;
  const page = await listWebMessages(db, thread.id, { before, limit: ASK_MESSAGE_PAGE_SIZE });
  const [chat, messages, activity] = await Promise.all([
    chatView(db, thread, organization),
    askMessages(deps, thread, page.messages),
    askActivity(db, thread),
  ]);
  return {
    chat,
    messages,
    activity,
    nextBefore: page.nextBefore,
  };
}

/** The repos a new chat in `organizations` can pick: connected, with Ask on. */
export async function askRepositories(
  db: Database,
  organizations: readonly ScopedOrganization[],
): Promise<AskRepositoryList> {
  const byId = new Map(organizations.map((o) => [o.id, o]));
  const { repositories } = await listConnectedRepositories(
    db,
    [...byId.keys()],
    ASK_REPOSITORY_LIMIT,
  );
  return {
    repositories: repositories
      .filter((repository) => repository.askEnabled)
      .map((repository) => ({
        ...repositoryRef(repository),
        organization: byId.get(repository.organizationId)!,
      })),
  };
}

export const ASK_REPOSITORY_UNAVAILABLE = "Ask is off for this repo, or it isn't connected.";

export interface StartAskChatDeps {
  db: Database;
  adapterFor: (db: Database, connection: ScmConnection) => ScmAdapter;
}

/**
 * Starts the caller's web chat in `organizationId` about `repositoryId` (null: all of the
 * organization's repos), titled after its first message, on the repo's default branch (read
 * from the code host, else the one last stored). The repo must be the organization's,
 * connected, with Ask on. Records the chat's change.
 */
export async function startAskChat(
  deps: StartAskChatDeps,
  user: OrgUser,
  input: { organizationId: string; repositoryId: string | null; text: string },
): Promise<{ thread: ChatThread; chat: AskChat }> {
  const { db } = deps;
  const organization = await membership(user, input.organizationId);
  if (!organization) throw ApiRouteError.notFound();

  let repository: Repository | null = null;
  let branch: string | null = null;
  if (input.repositoryId) {
    const found = await getRepositoryWithConnection(db, input.repositoryId, organization.id);
    if (!found) throw ApiRouteError.notFound();
    repository = found.repository;
    if (repository.disconnectedAt || !repository.askEnabled) {
      throw new ApiRouteError(400, ASK_REPOSITORY_UNAVAILABLE, "repository_unavailable", {
        repositoryId: ASK_REPOSITORY_UNAVAILABLE,
      });
    }
    try {
      branch = await fetchDefaultBranch(deps, found.connection, repository);
    } catch (error) {
      branch = repository.defaultBranch;
      if (!branch) {
        console.error(`Reading the default branch of ${repository.fullPath} failed`, error);
        throw new ApiRouteError(
          502,
          `Couldn't read the default branch of ${repository.fullPath}. Try again.`,
          "default_branch_unavailable",
        );
      }
    }
  }

  const thread = await createWebChatThread(db, {
    organizationId: organization.id,
    userId: user.id,
    repositoryId: repository?.id ?? null,
    branch,
    title: webChatTitle(input.text),
  });
  recordWebChatChange(db, thread);
  return { thread, chat: askChatView(thread, organization, repository) };
}

/** A message as the web adapter sends it (`webMessageView`). */
type SentMessage = Pick<AskMessageView, "id" | "author" | "markdown" | "status" | "createdAt">;

/**
 * The full view of a message a `message` event names (what the view model adds: run, files,
 * work items, card), keeping the event's own text and status (a streaming row's text in the
 * database may be ahead of the deltas sent so far).
 */
async function fullMessage(
  deps: AskMessagesDeps,
  thread: ChatThread,
  sent: SentMessage,
): Promise<AskMessageView> {
  const row = await getWebMessage(deps.db, sent.id);
  if (!row || row.threadId !== thread.id) {
    return { ...sent, run: null, files: [], workItems: [], card: null };
  }
  const [message] = await askMessages(deps, thread, [row]);
  return { ...message!, markdown: sent.markdown, status: sent.status };
}

export interface AskTurnDeps extends AskMessagesDeps {
  bot: HandleWebMessageDeps["bot"];
}

/** Keeps the work alive after the response (Next `after()`), publishing what it commits. */
function keepAlive(work: Promise<void>): void {
  const published = liveWaitUntil(work);
  try {
    after(published);
  } catch {
    // Outside a Next request (tests): the work runs on anyway.
    void published.catch(() => undefined);
  }
}

/**
 * The member's message `text` in `thread`, answered as an event stream: `chat` first when
 * `chat` is given (a new chat), the stored user message, Om's streamed reply and what it
 * does, then `done`. The turn runs to its end even when the client goes away.
 */
export function askTurnResponse(
  deps: AskTurnDeps,
  input: { thread: ChatThread; user: OrgUser; text: string; chat?: AskChat },
): Response {
  const { thread, user, text, chat } = input;
  const prepare = async <K extends AskStreamEventName>(
    name: K,
    data: AskStreamEvents[K],
  ): Promise<AskStreamEvents[K]> => {
    if (name !== "message") return data;
    const sent = (data as AskStreamEvents["message"]).message as SentMessage;
    return { message: await fullMessage(deps, thread, sent) } as AskStreamEvents[K];
  };
  const { body, finished } = webEventStream(
    async () => {
      if (chat) sendWebEvent("chat", { chat });
      await handleWebMessage(
        { db: deps.db, bot: deps.bot },
        { thread, user: { id: user.id, name: user.name, email: user.email }, text },
      );
    },
    {
      prepare,
      onError: (error) => console.error(`Ask turn in chat ${thread.id} failed`, error),
    },
  );
  keepAlive(finished);
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
