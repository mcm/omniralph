import "server-only";
import {
  appendChatMessage,
  cancelChatLinearIssueDraft,
  chatThreads,
  claimChatLinearIssueDraft,
  completeChatLinearIssueDraft,
  createChatLinearDelegation,
  expireChatLinearIssueDraft,
  getChatLinearIssueDraft,
  releaseChatLinearIssueDraft,
  type ChatConnection,
  type ChatLinearIssueDraft,
  type Database,
} from "@omniralph/db";
import {
  Actions,
  Button,
  Card,
  CardText,
  Field,
  Fields,
  LinkButton,
  type ActionEvent,
  type CardChild,
  type CardElement,
  type Logger,
} from "chat";
import { eq } from "drizzle-orm";
import { getLinearGateway, LinearNotConnectedError } from "@/lib/linear/client";
import type { LinearGateway } from "@/lib/linear/gateway";
import { sanitizeCapped, sanitizeTitle } from "@/lib/review/sanitize";
import { CHAT_ATTACHMENT_LIMITS, type ChatAttachmentLimits } from "./agent/config";
import {
  adapterFetcher,
  attachmentName,
  loadAttachment,
  type FetchAttachment,
} from "./attachments";
import type { ChatActor } from "./identity";

/**
 * Linear issues drafted by the control-panel agent (`draft_linear_issue`): a
 * card with the preview and **Create** / **Create and delegate** / **Cancel**
 * buttons. Only the linked member who asked can click them; **Create** creates
 * the issue in the organization's Linear workspace and turns the card into a
 * link to it, and **Create and delegate** also delegates it to the Omniralph
 * app ({@link delegateToRalph}), so ralph builds it. A draft expires after
 * {@link LINEAR_ISSUE_DRAFT_TTL_MS}.
 */

export const LINEAR_ISSUE_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const CREATE_LINEAR_ISSUE_ACTION = "linear_issue_create";
export const CREATE_AND_DELEGATE_LINEAR_ISSUE_ACTION = "linear_issue_create_delegate";
export const CANCEL_LINEAR_ISSUE_ACTION = "linear_issue_cancel";
export const LINEAR_ISSUE_ACTIONS = [
  CREATE_LINEAR_ISSUE_ACTION,
  CREATE_AND_DELEGATE_LINEAR_ISSUE_ACTION,
  CANCEL_LINEAR_ISSUE_ACTION,
];

/** Longest description the preview shows (the issue gets all of it). */
const MAX_PREVIEW_CHARS = 2_500;

export const PRIORITY_NAMES = ["No priority", "Urgent", "High", "Medium", "Low"] as const;

export const NOT_REQUESTER_REPLY =
  "Only the person who asked for this issue can create or cancel it. Mention me to draft your own.";
export const LINEAR_NOT_CONNECTED_REPLY =
  "This organization has no Linear workspace connected anymore, so I can't create the issue. An admin can connect one under Settings › Integrations in the control panel.";

type Draft = Pick<
  ChatLinearIssueDraft,
  | "id"
  | "teamKey"
  | "title"
  | "description"
  | "projectName"
  | "labels"
  | "priority"
  | "attachments"
  | "linearIssueIdentifier"
  | "linearIssueUrl"
>;

/** The draft's title as shown in chat (it's the model's text). */
const shownTitle = (draft: Pick<Draft, "title">) =>
  sanitizeTitle(draft.title, { allowedHosts: [] });

function previewFields(draft: Draft): CardChild[] {
  const fields = [Field({ label: "Team", value: draft.teamKey })];
  if (draft.projectName) fields.push(Field({ label: "Project", value: draft.projectName }));
  if (draft.labels.length > 0)
    fields.push(Field({ label: "Labels", value: draft.labels.join(", ") }));
  if (draft.priority !== null) {
    fields.push(
      Field({ label: "Priority", value: PRIORITY_NAMES[draft.priority] ?? `${draft.priority}` }),
    );
  }
  if (draft.attachments.length > 0) {
    fields.push(
      Field({
        label: "Screenshots",
        value: draft.attachments.map((a) => attachmentName(a)).join(", "),
      }),
    );
  }
  return [Fields(fields)];
}

/** The pending draft: preview with **Create** / **Cancel**. */
export function draftCard(draft: Draft): CardElement {
  const description = draft.description.trim()
    ? sanitizeCapped(draft.description, { allowedHosts: [] }, MAX_PREVIEW_CHARS)
    : "_No description_";
  return Card({
    title: `New Linear issue: ${shownTitle(draft)}`,
    children: [
      ...previewFields(draft),
      CardText(description),
      Actions([
        Button({
          id: CREATE_LINEAR_ISSUE_ACTION,
          label: "Create",
          style: "primary",
          value: draft.id,
        }),
        Button({
          id: CREATE_AND_DELEGATE_LINEAR_ISSUE_ACTION,
          label: "Create and delegate",
          value: draft.id,
        }),
        Button({ id: CANCEL_LINEAR_ISSUE_ACTION, label: "Cancel", value: draft.id }),
      ]),
    ],
  });
}

/**
 * The draft once its issue was created: identifier and link (and whether
 * ralph has it, and the screenshots that couldn't be attached).
 */
export function createdCard(
  draft: Draft,
  delegated = false,
  failedScreenshots: readonly string[] = [],
): CardElement {
  const identifier = draft.linearIssueIdentifier ?? "the issue";
  const children: CardChild[] = [CardText(`Created ${identifier}: ${shownTitle(draft)}`)];
  if (failedScreenshots.length > 0) {
    children.push(CardText(`Couldn't attach: ${failedScreenshots.join(", ")}`));
  }
  if (delegated) {
    children.push(
      CardText("Delegated to Omniralph: I'll post here when it starts and when it finishes."),
    );
  }
  if (draft.linearIssueUrl) {
    children.push(
      Actions([LinkButton({ label: `Open ${identifier}`, url: draft.linearIssueUrl })]),
    );
  }
  return Card({ title: `Created ${identifier}`, children });
}

export function cancelledCard(draft: Draft): CardElement {
  return Card({
    title: "Cancelled",
    children: [CardText(`Linear issue draft "${shownTitle(draft)}" was cancelled.`)],
  });
}

export function expiredCard(draft: Draft): CardElement {
  return Card({
    title: "Expired",
    children: [
      CardText(
        `Linear issue draft "${shownTitle(draft)}" expired after 24 hours. Mention me to draft it again.`,
      ),
    ],
  });
}

/** The card for a draft's current state. */
export function cardFor(draft: ChatLinearIssueDraft): CardElement {
  switch (draft.status) {
    case "created":
      return createdCard(draft);
    case "cancelled":
      return cancelledCard(draft);
    case "expired":
      return expiredCard(draft);
    case "pending":
    case "creating":
      return draftCard(draft);
  }
}

/** What `chat_messages` records once the issue is created. */
export function createdMessage(draft: Draft, delegated = false): string {
  const created = `Created Linear issue ${draft.linearIssueIdentifier}: ${draft.title} (${draft.linearIssueUrl})`;
  return delegated ? `${created}, and delegated it to Omniralph.` : created;
}

/**
 * Delegates a Linear issue to the Omniralph app for a chat thread: first
 * records the delegation (so the run Linear's agent session starts is tied to
 * the thread, see `startRun`), then delegates the issue to the app user
 * (`getViewer`). Throws when Linear fails.
 */
export async function delegateToRalph(
  db: Database,
  linear: LinearGateway,
  input: { organizationId: string; chatThreadId: string; linearIssueId: string },
): Promise<void> {
  await createChatLinearDelegation(db, {
    organizationId: input.organizationId,
    threadId: input.chatThreadId,
    linearIssueId: input.linearIssueId,
  });
  const app = await linear.getViewer();
  await linear.delegateIssue(input.linearIssueId, app.id);
}

/**
 * Uploads a draft's screenshots to Linear (fetched again from the chat
 * platform): the Markdown that embeds them at the end of the description, and
 * the names of those that couldn't be fetched or uploaded.
 */
export async function embedScreenshots(
  linear: LinearGateway,
  fetchData: FetchAttachment,
  attachments: ChatLinearIssueDraft["attachments"],
  limits: ChatAttachmentLimits = CHAT_ATTACHMENT_LIMITS,
  logger: Pick<Logger, "warn"> = console,
): Promise<{ markdown: string; failed: string[] }> {
  const images: string[] = [];
  const failed: string[] = [];
  for (const attachment of attachments) {
    const name = attachmentName(attachment);
    const content = await loadAttachment(attachment, fetchData, limits);
    if (content.status !== "loaded" || content.kind !== "image") {
      logger.warn("Couldn't load a screenshot for a Linear issue", {
        ref: attachment.ref,
        reason: content.status === "skipped" ? content.reason : "not an image",
      });
      failed.push(name);
      continue;
    }
    try {
      const url = await linear.uploadFile({
        filename: name,
        contentType: content.mediaType,
        data: content.data,
      });
      images.push(`![${name}](${url})`);
    } catch (error) {
      logger.warn("Couldn't upload a screenshot to Linear", { ref: attachment.ref, error });
      failed.push(name);
    }
  }
  return {
    markdown: images.length > 0 ? `\n\n## Screenshots\n\n${images.join("\n\n")}` : "",
    failed,
  };
}

export const DELEGATION_FAILED_REPLY =
  "The issue was created, but Linear didn't delegate it to Omniralph. Ask me to delegate it again, or delegate it to Omniralph in Linear.";

export interface LinearIssueActionDeps {
  db: Database;
  /** Who clicked, in the connection's organization. */
  resolveActor(connection: ChatConnection, externalUserId: string): Promise<ChatActor>;
  /** The organization's Linear workspace (default: `getLinearGateway`). */
  linear?: (organizationId: string) => Promise<LinearGateway>;
  /** Fetches the draft's screenshots (default: through the clicked card's adapter). */
  fetchAttachment?: FetchAttachment;
  attachmentLimits?: ChatAttachmentLimits;
  now?: () => Date;
  logger?: Logger;
}

/**
 * Handles a click on a draft card's **Create** or **Cancel** button, received
 * by `connection`. Clicks on drafts of another connection or thread are
 * ignored; clicks by anyone but the member who asked get a private note.
 */
export async function handleLinearIssueAction(
  deps: LinearIssueActionDeps,
  event: ActionEvent,
  connection: ChatConnection,
): Promise<void> {
  const { db } = deps;
  const logger = deps.logger ?? console;
  const now = deps.now?.() ?? new Date();
  const draftId = event.value;
  if (!draftId || !/^[0-9a-f-]{36}$/i.test(draftId)) return;
  const draft = await getChatLinearIssueDraft(db, draftId);
  if (!draft) return;
  const [chatThread] = await db
    .select()
    .from(chatThreads)
    .where(eq(chatThreads.id, draft.threadId))
    .limit(1);
  if (
    !chatThread ||
    chatThread.connectionId !== connection.id ||
    chatThread.externalThreadId !== event.threadId
  ) {
    logger.warn("Ignoring a Linear issue draft click from another thread", {
      draftId,
      threadId: event.threadId,
    });
    return;
  }

  const show = (card: CardElement) =>
    event.adapter.editMessage(event.threadId, event.messageId, card);
  const tell = async (text: string) => {
    if (!event.thread) return;
    await event.thread
      .postEphemeral(event.user, text, { fallbackToDM: true })
      .catch((error: unknown) =>
        logger.warn("Couldn't answer a Linear issue draft click", { draftId, error }),
      );
  };
  const record = (content: string) =>
    appendChatMessage(db, { threadId: draft.threadId, role: "assistant", content });

  const actor = await deps.resolveActor(connection, event.user.userId);
  if (actor.kind !== "member" || actor.userId !== draft.requestedByUserId) {
    await tell(NOT_REQUESTER_REPLY);
    return;
  }

  if (draft.status === "pending" && draft.expiresAt <= now) {
    const expired = await expireChatLinearIssueDraft(db, draft.id, now);
    await show(expiredCard(expired ?? draft));
    if (expired)
      await record(`The Linear issue draft "${draft.title}" expired before it was created.`);
    return;
  }

  if (event.actionId === CANCEL_LINEAR_ISSUE_ACTION) {
    const cancelled = await cancelChatLinearIssueDraft(db, draft.id);
    if (!cancelled) {
      // Already handled (e.g. a double click): show where it stands.
      await show(cardFor(draft));
      return;
    }
    await show(cancelledCard(cancelled));
    await record(`Cancelled the Linear issue draft "${draft.title}"; nothing was created.`);
    return;
  }

  const delegate = event.actionId === CREATE_AND_DELEGATE_LINEAR_ISSUE_ACTION;
  if (event.actionId !== CREATE_LINEAR_ISSUE_ACTION && !delegate) return;
  const claimed = await claimChatLinearIssueDraft(db, draft.id, now);
  if (!claimed) {
    if (draft.status !== "creating") await show(cardFor(draft));
    return;
  }
  let created: ChatLinearIssueDraft | null;
  let linear: LinearGateway;
  let failedScreenshots: string[] = [];
  try {
    linear = await (deps.linear ?? ((organizationId) => getLinearGateway({ db, organizationId })))(
      chatThread.organizationId,
    );
    const screenshots = await embedScreenshots(
      linear,
      deps.fetchAttachment ?? adapterFetcher(event.adapter),
      claimed.attachments,
      deps.attachmentLimits,
      logger,
    );
    failedScreenshots = screenshots.failed;
    const issue = await linear.createIssue({
      teamId: claimed.teamId,
      title: claimed.title,
      description: `${claimed.description}${screenshots.markdown}`,
      ...(claimed.projectName && { projectName: claimed.projectName }),
      ...(claimed.labels.length > 0 && { labels: claimed.labels }),
      ...(claimed.priority !== null && { priority: claimed.priority }),
    });
    created = await completeChatLinearIssueDraft(db, claimed.id, issue);
  } catch (error) {
    await releaseChatLinearIssueDraft(db, claimed.id);
    if (error instanceof LinearNotConnectedError) {
      await tell(LINEAR_NOT_CONNECTED_REPLY);
      return;
    }
    logger.error("Creating a Linear issue from chat failed", { draftId, error });
    await tell("Linear didn't create the issue. Please try again in a moment.");
    return;
  }
  if (!created) return;
  let delegated = false;
  if (delegate && created.linearIssueId) {
    try {
      await delegateToRalph(db, linear, {
        organizationId: chatThread.organizationId,
        chatThreadId: chatThread.id,
        linearIssueId: created.linearIssueId,
      });
      delegated = true;
    } catch (error) {
      logger.error("Delegating a Linear issue created from chat failed", { draftId, error });
      await tell(DELEGATION_FAILED_REPLY);
    }
  }
  await show(createdCard(created, delegated, failedScreenshots));
  await record(createdMessage(created, delegated));
}
