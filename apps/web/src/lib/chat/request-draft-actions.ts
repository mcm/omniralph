import "server-only";
import {
  appendChatMessage,
  claimChatRequestDraft,
  completeChatRequestDraftStart,
  dismissChatRequestDraft,
  expireChatRequestDraft,
  getChatRequestDraft,
  getChatThread,
  listChatMessages,
  releaseChatRequestDraft,
  type ChatConnection,
  type ChatRequestDraft,
  type ChatThread,
  type Database,
} from "@omniralph/db";
import type { ActionEvent, Logger } from "chat";
import { getAppUrl } from "@/lib/app-url";
import {
  startChatRequest,
  type ChatRequestOutcome,
  type QuotedMessage,
} from "@/lib/ralph/chat-start";
import type { RalphDeps } from "@/lib/ralph/run";
import { runHref } from "@/lib/runs/links";
import { codingOffMessage } from "@/lib/work-items/create";
import { chatPlaybookOf } from "./agent/read-tools";
import type { ChatActor } from "./identity";
import type { PlaybookLookup } from "./playbooks";
import {
  DISMISS_REQUEST_DRAFT_ACTION,
  NOT_REQUESTER_TEXT,
  requestDraftCard,
  requestDraftContext,
  requestDraftView,
  START_REQUEST_DRAFT_ACTION,
} from "./request-draft";
import { recordWebChatChange } from "./web-adapter";

/**
 * Clicks on a drafted request's card (`./request-draft`), on every platform: **Start
 * request** starts the request run of the thread, **Not now** dismisses the draft. Only the
 * member who asked can act, once, before the draft expires; the card then shows the outcome.
 * In a web chat, every status change publishes the chat's change.
 */

/** How many of the chat's latest user messages a started request quotes. */
export const REQUEST_DRAFT_QUOTED_MESSAGES = 5;

export const RUN_ACTIVE_TEXT =
  "A request is already running in this chat. Wait for it to finish, or tell Om what to change.";
export const START_FAILED_TEXT = "Om couldn't start the request. Try again in a moment.";

export interface RequestDraftActionDeps {
  db: Database;
  /** Who clicked, in the connection's organization. */
  resolveActor(connection: ChatConnection, externalUserId: string): Promise<ChatActor>;
  /** The ralph orchestrator's dependencies for an organization (default: `defaultDeps`). */
  ralph?: (organizationId: string) => Promise<RalphDeps>;
  /** Looks up the playbooks chat runs (default: the organization's). */
  getPlaybook?: PlaybookLookup;
  /** `APP_URL` (tests). */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  logger?: Logger;
}

/** A chat message's text, for a quote (user messages are stored as text). */
const messageText = (content: unknown) => (typeof content === "string" ? content : "");

/** The chat's latest user messages up to the draft, oldest first, for the request's quote. */
async function latestMessages(db: Database, draft: ChatRequestDraft): Promise<QuotedMessage[]> {
  const history = await listChatMessages(db, draft.threadId, 50);
  return history
    .filter((m) => m.role === "user" && m.createdAt <= draft.createdAt)
    .map((m) => ({ author: m.authorName, text: messageText(m.content) }))
    .filter((m) => m.text.trim())
    .slice(-REQUEST_DRAFT_QUOTED_MESSAGES);
}

/** Why a request didn't start, as the card says it. */
function refusal(outcome: Exclude<ChatRequestOutcome, { status: "started" }>, repository: string) {
  switch (outcome.status) {
    case "unknown_repository":
      return codingOffMessage(repository.split("/").pop() ?? repository);
    case "already_running":
      return RUN_ACTIVE_TEXT;
    case "failed":
      return outcome.error;
    case "nothing_to_ship":
      return START_FAILED_TEXT;
  }
}

/**
 * Handles a click on a drafted request's card, received by `connection`. Clicks on drafts of
 * another connection or thread are ignored; clicks by anyone but the member who asked get a
 * private note.
 */
export async function handleRequestDraftAction(
  deps: RequestDraftActionDeps,
  event: ActionEvent,
  connection: ChatConnection,
): Promise<void> {
  const { db } = deps;
  const logger = deps.logger ?? console;
  const now = deps.now?.() ?? new Date();
  const appUrl = getAppUrl(deps.env);
  const draftId = event.value;
  if (!draftId || !/^[0-9a-f-]{36}$/i.test(draftId)) return;
  const draft = await getChatRequestDraft(db, draftId);
  if (!draft) return;
  const chatThread = await getChatThread(db, draft.threadId);
  if (
    !chatThread ||
    chatThread.connectionId !== connection.id ||
    chatThread.externalThreadId !== event.threadId
  ) {
    logger.warn("Ignoring a request draft click from another thread", {
      draftId,
      threadId: event.threadId,
    });
    return;
  }

  const show = async (current: ChatRequestDraft) => {
    const context = await requestDraftContext(db, current, {
      platform: connection.platform,
      appUrl,
      now,
    });
    await event.adapter.editMessage(
      event.threadId,
      event.messageId,
      requestDraftCard(requestDraftView(current, context)),
    );
  };
  /** The draft's status changed: a web chat's views reload it. */
  const changed = () => {
    if (connection.platform === "web") recordWebChatChange(db, chatThread);
  };
  const record = (content: string) =>
    appendChatMessage(db, { threadId: draft.threadId, role: "assistant", content });

  const actor = await deps.resolveActor(connection, event.user.userId);
  if (actor.kind !== "member" || actor.userId !== draft.requestedByUserId) {
    // A web chat is its starter's alone (the API refuses anyone else): a note there would be
    // the starter's to read.
    if (connection.platform === "web") return;
    await event.thread
      ?.postEphemeral(event.user, NOT_REQUESTER_TEXT, { fallbackToDM: true })
      .catch((error: unknown) =>
        logger.warn("Couldn't answer a request draft click", { draftId, error }),
      );
    return;
  }

  if (draft.status === "pending" && draft.expiresAt <= now) {
    const expired = await expireChatRequestDraft(db, draft.id, now);
    if (expired) {
      changed();
      await record(`The request draft "${draft.title}" expired before anyone acted on it.`);
    }
    await show(expired ?? draft);
    return;
  }

  if (event.actionId === DISMISS_REQUEST_DRAFT_ACTION) {
    const dismissed = await dismissChatRequestDraft(db, draft.id, now);
    if (!dismissed) {
      // Already handled (e.g. a double click): show where it stands.
      await show(draft);
      return;
    }
    changed();
    await show(dismissed);
    await record(`The request draft "${draft.title}" was dismissed (Not now); nothing started.`);
    return;
  }

  if (event.actionId === START_REQUEST_DRAFT_ACTION) {
    await startRequest(deps, { draft, chatThread, connection, actor, now, show, changed, record });
  }
}

async function startRequest(
  deps: RequestDraftActionDeps,
  input: {
    draft: ChatRequestDraft;
    chatThread: ChatThread;
    connection: ChatConnection;
    actor: Extract<ChatActor, { kind: "member" }>;
    now: Date;
    show(draft: ChatRequestDraft): Promise<void>;
    changed(): void;
    record(content: string): Promise<unknown>;
  },
): Promise<void> {
  const { db } = deps;
  const logger = deps.logger ?? console;
  const { draft, chatThread, connection, show, changed } = input;
  const claimed = await claimChatRequestDraft(db, draft.id, "starting", input.now);
  if (!claimed) {
    // A click already running shows its outcome when it's done.
    if (draft.status !== "starting" && draft.status !== "adding") await show(draft);
    return;
  }
  changed();
  const context = await requestDraftContext(db, claimed, {
    platform: connection.platform,
    appUrl: getAppUrl(deps.env),
  });
  const repository = context.repository?.fullPath ?? "";

  let reason: string | null = null;
  let runId: string | null = null;
  try {
    const task = await chatPlaybookOf(
      {
        db,
        organizationId: chatThread.organizationId,
        connection,
        chatThread,
        getPlaybook: deps.getPlaybook,
      },
      "startWork",
    );
    if ("error" in task) {
      reason = task.message;
    } else if (!context.repository) {
      reason = START_FAILED_TEXT;
    } else {
      const ralph = await (
        deps.ralph ??
        (async (organizationId: string) => {
          const { defaultDeps } = await import("@/lib/ralph/jobs");
          return defaultDeps(db, organizationId);
        })
      )(chatThread.organizationId);
      const outcome = await startChatRequest(ralph, {
        chatThreadId: chatThread.id,
        repository,
        request: claimed.request,
        quoted: await latestMessages(db, claimed),
        author: input.actor.name ?? null,
        codingTaskId: task.task.id,
      });
      if (outcome.status === "started") runId = outcome.run.id;
      else reason = refusal(outcome, repository);
    }
  } catch (error) {
    logger.error("Starting a drafted request failed", { draftId: draft.id, error });
    reason = START_FAILED_TEXT;
  }

  if (!runId) {
    const released = await releaseChatRequestDraft(db, claimed.id, reason ?? START_FAILED_TEXT);
    changed();
    await show(released ?? claimed);
    return;
  }
  const started = await completeChatRequestDraftStart(db, claimed.id, runId);
  changed();
  await show(started ?? claimed);
  await input.record(
    `Started the request "${claimed.title}" in ${repository}: ${getAppUrl(deps.env)}${runHref(runId)}. Its news comes back to this chat as run events.`,
  );
}
